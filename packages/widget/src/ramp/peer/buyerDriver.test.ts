import { resolveFiatCurrencyBytes32, type IndexerIntent } from "@zkp2p/sdk";
import { expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { createPeerBuyerDriver, peerRecipientTransfer } from "./buyerDriver.js";
import { peerConfiguration } from "./discovery.js";
import { digest } from "./normalization.js";
const token = peerConfiguration().settlement.asset_id as Address;
const recipient = "0x1111111111111111111111111111111111111111";
const vault = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
function transfer(address: Address, to: Address, value: bigint, from: Address = vault) {
  return {
    address,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as [
      Hex,
      ...Hex[],
    ],
  };
}
it("requires the actual reviewed USDC payment, not a closed payout lock or unrelated transfer", () => {
  expect(peerRecipientTransfer([], token, recipient, 1000000n, vault)).toBe(false);
  for (const logs of [
    [transfer(token, vault, 1000000n)],
    [transfer(other, recipient, 1000000n)],
    [transfer(token, recipient, 999999n)],
    [transfer(token, recipient, 1000000n, other)],
    [transfer(token, other, 1000000n)],
  ])
    expect(peerRecipientTransfer(logs, token, recipient, 1000000n, vault)).toBe(false);
  expect(
    peerRecipientTransfer(
      [transfer(token, recipient, 1000000n)],
      token,
      recipient,
      1000000n,
      vault,
    ),
  ).toBe(true);
});

const approvedAfter = 1_800_000_000_000;
const operationId = "reviewed-purchase";
const signalHash = `0x${"1".repeat(64)}` as Hex;
const txHash = `0x${"2".repeat(64)}` as Hex;
const payeeId = `0x${"3".repeat(64)}` as Hex;
const exact = {
  owner: recipient as Address,
  to: recipient as Address,
  escrow: peerConfiguration().escrow as Address,
  depositId: 1n,
  amount: 100000000n,
  conversionRate: 1000000000000000000n,
  paymentMethod: peerConfiguration().rails.venmo.paymentMethodHash as Hex,
  fiatCurrency: resolveFiatCurrencyBytes32("USD"),
  timestamp: BigInt(approvedAfter / 1000 + 1),
  payeeId,
};
const terms = digest([
  exact.owner,
  exact.to,
  exact.escrow.toLowerCase(),
  "1",
  "100000000",
  "1000000000000000000",
  exact.paymentMethod.toLowerCase(),
  exact.fiatCurrency.toLowerCase(),
]);
const lookup = {
  operationId,
  wallet: recipient,
  rail: "venmo",
  currency: "USD",
  payAtomic: "100000000",
  receiveAtomic: "100000000",
  approvedAfter,
};

function resumeFixture(
  status: IndexerIntent["status"],
  indexed = exact,
  signaled = indexed,
  live = signaled,
) {
  const config = peerConfiguration();
  const signalEvent = parseAbiItem(
    "event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp, bytes32 groupId, address arbitrator)",
  );
  const params = signalEvent.inputs.filter((input) => !("indexed" in input && input.indexed));
  const readPayee = vi.fn(async () => undefined);
  const receipt = {
    status: "success",
    from: recipient,
    to: config.orchestrator,
    blockNumber: 123n,
    logs: [
      {
        address: config.orchestrator,
        topics: encodeEventTopics({
          abi: [signalEvent],
          eventName: "IntentSignaled",
          args: { intentHash: signalHash, escrow: signaled.escrow, depositId: signaled.depositId },
        }),
        data: encodeAbiParameters(params, [
          signaled.paymentMethod,
          signaled.owner,
          signaled.to,
          signaled.amount,
          signaled.fiatCurrency,
          signaled.conversionRate,
          signaled.timestamp,
          txHash,
          other,
        ]),
      },
    ],
  };
  const checkpoints = new Map([
    [
      `xochi:peer-buyer-binding:v1:${operationId}`,
      JSON.stringify({
        terms,
        payee: digest([terms, payeeId]),
        payAtomic: lookup.payAtomic,
        receiveAtomic: lookup.receiveAtomic,
        after: approvedAfter + 1,
        before: approvedAfter + 120_000,
      }),
    ],
  ]);
  const driver = createPeerBuyerDriver({
    wallet: { account: { address: recipient } } as unknown as WalletClient,
    publicClient: {
      chain: { id: 8453 },
      async readContract() {
        return 3600n;
      },
      async waitForTransactionReceipt() {
        return receipt;
      },
    } as unknown as PublicClient,
    resumeStorage: {
      getItem: (key) => checkpoints.get(key) ?? null,
      setItem: (key, value) => {
        checkpoints.set(key, value);
      },
    },
    resumeReads: {
      async intent() {
        return {
          ...live,
          referralFees: [],
          payerCommitment: "0x",
          takerWhitelisted: false,
          arbitrator: other,
        };
      },
      payee: readPayee,
      async ownerIntents() {
        return [
          {
            id: signalHash,
            owner: indexed.owner,
            toAddress: indexed.to,
            orchestratorAddress: config.orchestrator,
            verifier: other,
            paymentMethodHash: indexed.paymentMethod,
            fiatCurrency: indexed.fiatCurrency,
            signalTimestamp: indexed.timestamp.toString(),
            amount: indexed.amount.toString(),
            conversionRate: indexed.conversionRate.toString(),
            depositId: indexed.depositId.toString(),
            intentHash: signalHash,
            isExpired: status === "PRUNED",
            status,
            signalTxHash: txHash,
            fulfillTxHash: txHash,
          },
        ];
      },
    },
  });
  return { resume: driver.resume!, readPayee, checkpoints };
}

it.each(["SIGNALED", "PRUNED", "FULFILLED"] as const)(
  "rejects an older 40 USD %s intent during recovery of a 100 USD purchase",
  async (status) => {
    const { resume, readPayee } = resumeFixture(status, {
      ...exact,
      amount: 40000000n,
      timestamp: BigInt((approvedAfter - 60_000) / 1000),
    });
    expect(await resume(lookup)).toBeUndefined();
    expect(readPayee).not.toHaveBeenCalled();
  },
);

it.each(["SIGNALED", "PRUNED", "FULFILLED"] as const)(
  "requires exact %s economic terms in the indexer and signal receipt",
  async (status) => {
    const mismatch = { ...exact, conversionRate: exact.conversionRate + 1n };
    for (const fixture of [
      resumeFixture(status, mismatch),
      resumeFixture(status, exact, mismatch),
    ]) {
      expect(await fixture.resume(lookup)).toBeUndefined();
      expect(fixture.readPayee).not.toHaveBeenCalled();
    }
  },
);

it("rejects a matching intent outside the submission window", async () => {
  const { resume, readPayee } = resumeFixture("SIGNALED", {
    ...exact,
    timestamp: BigInt(approvedAfter / 1000 + 121),
  });
  expect(await resume(lookup)).toBeUndefined();
  expect(readPayee).not.toHaveBeenCalled();
});

it("requires the reviewed amounts, the original checkpoint, and the live payee", async () => {
  const fixture = resumeFixture("SIGNALED");
  expect(await fixture.resume({ ...lookup, payAtomic: "40000000" })).toBeUndefined();
  expect(await fixture.resume({ ...lookup, receiveAtomic: "40000000" })).toBeUndefined();
  expect(fixture.readPayee).not.toHaveBeenCalled();
  fixture.checkpoints.clear();
  expect(await fixture.resume(lookup)).toBeUndefined();
  expect(fixture.readPayee).not.toHaveBeenCalled();

  const mismatched = resumeFixture("SIGNALED", exact, exact, { ...exact, payeeId: txHash });
  expect(await mismatched.resume(lookup)).toBeUndefined();
  expect(mismatched.readPayee).not.toHaveBeenCalled();
});

it.each([
  ["SIGNALED", "active"],
  ["PRUNED", "expired"],
  ["FULFILLED", "fulfilled"],
] as const)("reconciles an exact %s intent as %s", async (status, kind) => {
  const { resume, readPayee } = resumeFixture(status);
  expect(await resume(lookup)).toMatchObject({ kind });
  expect(readPayee).toHaveBeenCalledTimes(status === "SIGNALED" ? 1 : 0);
});
