import recorded from "./fixtures/usd-best-by-platform.json";
import { createLivePeerOfframpProvider } from "./liveProvider.js";
import type { UnsignedMakerSDK } from "./sdkMaker.js";
import { describe, expect, it } from "vitest";
import { atomic, type RampIntent } from "@xochi/client";
import { getContracts } from "@zkp2p/sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type AbiEvent,
  type Hex,
} from "viem";
import { peerConfiguration } from "./discovery.js";
import {
  createDefaultMakerReads,
  createMakerIndexer,
  type MakerPublicClient,
  type MakerChainTransaction,
  type MakerChainReceipt,
} from "./liveReads.js";
import type { ProtectedMakerMapping } from "./protectedMapping.js";
const config = peerConfiguration();
const contracts = getContracts(8453, "production");
const escrowAbi = contracts.abis.escrowV2!;
const wallet = "0x000000000000000000000000000000000000dEaD";
const zero = "0x0000000000000000000000000000000000000000";
const intentHash = `0x${"4".repeat(64)}` as Hex;
const txHash = `0x${"5".repeat(64)}` as Hex;
const composite = `8453_${config.escrow.toLowerCase()}_123`;
const intent: RampIntent = {
  contract_version: "ramp/1",
  kind: "intent",
  direction: "offramp",
  fiat: { kind: "fiat", currency: "USD", decimals: 6 },
  crypto: config.settlement,
  exact: { side: "crypto", money: { asset: config.settlement, atomic: atomic("25000000") } },
  recipient: wallet,
};
const range = { min: 1000000n, max: 100000000n };
function creation() {
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: "createDeposit",
    args: [
      {
        token: config.settlement.asset_id,
        amount: 25000000n,
        intentAmountRange: range,
        paymentMethods: [],
        paymentMethodData: [],
        currencies: [],
        delegate: zero,
        intentGuardian: zero,
        retainOnEmpty: false,
      },
    ],
  });
  const event = escrowAbi.find(
    (e) => e.type === "event" && e.name === "DepositReceived",
  ) as AbiEvent;
  const log = {
    address: config.escrow,
    topics: encodeEventTopics({
      abi: [event],
      eventName: "DepositReceived",
      args: { depositId: 123n, depositor: wallet, token: config.settlement.asset_id },
    }).map(String) as Hex[],
    data: encodeAbiParameters(
      event.inputs.filter((i) => !i.indexed),
      [25000000n, range, zero, zero],
    ),
  };
  return { data, log };
}
/** Real in-memory implementation of the viem read interface, with no network or mocking library. */
class MemoryPublicChain {
  chainId = 8453;
  height = 100n;
  paused = false;
  stale = false;
  adapter = zero;
  owner = wallet;
  remaining = 25000000n;
  outstanding = 0n;
  active: string[] = [];
  reads: string[] = [];
  tx: MakerChainTransaction = {
    chainId: 8453,
    from: wallet,
    to: config.escrow,
    input: creation().data,
    value: 0n,
  };
  receipt: MakerChainReceipt = {
    status: "success",
    blockNumber: 90n,
    transactionHash: txHash,
    logs: [creation().log],
  };
  client: MakerPublicClient = {
    getChainId: async () => this.chainId,
    getBlockNumber: async () => this.height,
    readContract: (async (args: { functionName: string; address: string }) => {
      this.reads.push(args.functionName);
      switch (args.functionName) {
        case "paused":
          return this.paused;
        case "balanceOf":
          return 25000000n;
        case "allowance":
          return 25000000n;
        case "getDeposit":
          if (args.address.toLowerCase() === contracts.addresses.protocolViewerV4?.toLowerCase())
            return {
              depositId: 123n,
              availableLiquidity: this.remaining,
              deposit: {
                depositor: this.owner,
                token: config.settlement.asset_id,
                remainingDeposits: this.remaining,
                outstandingIntentAmount: this.outstanding,
                intentAmountRange: range,
              },
            };
          return {
            depositor: this.owner,
            token: config.settlement.asset_id,
            remainingDeposits: this.remaining,
            outstandingIntentAmount: this.outstanding,
            intentAmountRange: range,
          };
        case "getDepositPaymentMethodActive":
        case "getDepositCurrencyListed":
          return true;
        case "getEffectiveRate":
          if (this.stale) throw new Error("[synthetic-stale-feed]");
          return 1000000000000000000n;
        case "getDepositOracleRateConfig":
          return { adapter: this.adapter, adapterConfig: "0x", spreadBps: 0, maxStaleness: 3600 };
        case "getDepositCurrencyMinRate":
          return 1000000000000000000n;
        case "getDepositIntentHashes":
          return this.active;
        case "getIntent":
          return { escrow: config.escrow, depositId: 123n, amount: this.outstanding };
        default:
          throw new Error("[synthetic-unsupported-read]");
      }
    }) as MakerPublicClient["readContract"],
    getTransaction: async () => this.tx,
    getTransactionReceipt: async () => this.receipt,
    call: (async () => ({ data: "0x" })) as MakerPublicClient["call"],
  };
}
class MemoryPublicIndexer {
  calls = 0;
  status = 200;
  remaining = "25000000";
  outstanding = "0";
  filled = "0";
  withdrawn = "0";
  closed = false;
  intents: {
    intentHash: string;
    amount: string;
    status: string;
    releasedAmount: string | null;
    orchestratorAddress: string;
  }[] = [];
  activities: { activityType: string; amount: string; blockNumber: string }[] = [];
  fetch: typeof fetch = async (_url, init) => {
    this.calls++;
    if (this.status === 429)
      return new Response("", { status: 429, headers: { "Retry-After": "2" } });
    const body = JSON.parse(String(init?.body));
    const data = body.query.includes("MakerTemplate")
      ? {
          DepositPaymentMethod: [
            {
              depositId: composite,
              depositIdOnContract: "123",
              paymentMethodHash: config.rails.revolut.paymentMethodHash,
            },
          ],
          MethodCurrency: [{ depositId: composite, depositIdOnContract: "123" }],
        }
      : {
          Deposit_by_pk: {
            depositId: "123",
            chainId: 8453,
            escrowAddress: config.escrow,
            depositor: wallet,
            token: config.settlement.asset_id,
            remainingDeposits: this.remaining,
            outstandingIntentAmount: this.outstanding,
            totalAmountTaken: this.filled,
            totalWithdrawn: this.withdrawn,
            blockNumber: "90",
            status: this.closed ? "CLOSED" : "ACTIVE",
          },
          Intent: this.intents,
          DepositFundActivity: this.activities,
        };
    return Response.json({ data });
  };
}
function setup() {
  const chain = new MemoryPublicChain(),
    indexer = new MemoryPublicIndexer();
  let now = Date.parse("2026-11-16T00:00:00Z");
  const defaults = createDefaultMakerReads({
    publicClient: chain.client,
    wallet,
    fetch: indexer.fetch,
    now: () => now,
    registered: () => true,
  });
  return {
    chain,
    indexer,
    defaults,
    advance: (value: number) => {
      now += value;
    },
  };
}
describe("default public maker reads", () => {
  it("reads live balance, rail/range, protocol pause and effective oracle price", async () => {
    const { chain, defaults } = setup();
    chain.adapter = "0x0000000000000000000000000000000000000001";
    const terms = await defaults.executionTerms(intent, "revolut");
    expect(terms).toMatchObject({
      minimum: "1000000",
      maximum: "25000000",
      conversionRate: "1000000000000000000",
    });
    expect((await defaults.makerEvidence(intent, "revolut")).credential).toBe("verified");
    expect(terms.oracle?.adapter).toBe(chain.adapter);
    expect(chain.reads).toContain("getDepositCurrencyListed");
    expect(chain.reads).toContain("getEffectiveRate");
    expect(await defaults.reads.allowance(wallet, "25000000")).toBe(true);
  });
  it("fails closed for stale oracle, protocol pause, wrong chain and constrained region", async () => {
    const s = setup();
    s.chain.stale = true;
    await expect(s.defaults.executionTerms(intent, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
    s.chain.stale = false;
    s.chain.paused = true;
    await expect(s.defaults.executionTerms(intent, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
    s.chain.paused = false;
    s.chain.chainId = 1;
    await expect(s.defaults.executionTerms(intent, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
    s.chain.chainId = 8453;
    await expect(s.defaults.executionTerms({ ...intent, region: "US" }, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
  });
  it("rebuilds active intents, verified fills and withdrawals from agreeing chain/indexer data", async () => {
    const { defaults, chain, indexer } = setup();
    expect(await defaults.reads.deposit("123", wallet)).toMatchObject({
      remaining: "25000000",
      filled: "0",
      activeIntents: 0,
    });
    chain.remaining = 10000000n;
    chain.outstanding = 5000000n;
    chain.active = [intentHash];
    indexer.remaining = "10000000";
    indexer.outstanding = "5000000";
    indexer.filled = "10000000";
    indexer.intents = [
      {
        intentHash,
        amount: "5000000",
        status: "SIGNALED",
        releasedAmount: null,
        orchestratorAddress: config.orchestrator,
      },
      {
        intentHash: `0x${"6".repeat(64)}`,
        amount: "10000000",
        status: "FULFILLED",
        releasedAmount: "10000000",
        orchestratorAddress: config.orchestrator,
      },
    ];
    expect(await defaults.reads.deposit("123", wallet)).toEqual({
      remaining: "15000000",
      unmatched: "10000000",
      filled: "10000000",
      withdrawn: "0",
      activeIntents: 1,
      closed: false,
    });
    chain.remaining = 0n;
    chain.outstanding = 0n;
    chain.active = [];
    indexer.remaining = "0";
    indexer.outstanding = "0";
    indexer.withdrawn = "15000000";
    indexer.closed = true;
    indexer.intents = indexer.intents.filter((i) => i.status === "FULFILLED");
    indexer.activities = [{ activityType: "WITHDRAWN", amount: "15000000", blockNumber: "99" }];
    expect(await defaults.reads.deposit("123", wallet)).toMatchObject({
      closed: true,
      filled: "10000000",
      withdrawn: "15000000",
    });
  });
  it("refuses incoherent or unverified indexer facts", async () => {
    const s = setup();
    s.indexer.remaining = "1";
    await expect(s.defaults.reads.deposit("123", wallet)).rejects.toThrow("peer_in_doubt");
    s.indexer.remaining = "25000000";
    s.indexer.filled = "10000000";
    await expect(s.defaults.reads.deposit("123", wallet)).rejects.toThrow("peer_in_doubt");
    s.indexer.filled = "0";
    s.chain.owner = zero;
    await expect(s.defaults.reads.deposit("123", wallet)).rejects.toThrow("peer_in_doubt");
  });
  it("matches exact transaction data and rebuilds a creation from its own confirmed receipt", async () => {
    const { defaults, chain } = setup();
    const expected = { chainId: 8453, to: config.escrow as Hex, data: chain.tx.input, value: 0n };
    expect(
      await defaults.reads.reconcile(txHash, "create_deposit", wallet, expected),
    ).toMatchObject({ state: "confirmed", depositId: "123" });
    expect(
      await defaults.reads.reconcile(txHash, "create_deposit", wallet, {
        ...expected,
        data: "0x1234",
      }),
    ).toEqual({ state: "pending" });
    const mapping: ProtectedMakerMapping = {
      operationRef: "widget_recovered",
      escrowAddress: config.escrow,
      depositId: "123",
      creationTxHash: txHash,
      legRevision: "2",
    };
    expect(await defaults.rebuild(mapping)).toEqual({
      state: "confirmed",
      depositId: "123",
      amount: "25000000",
    });
    expect(await defaults.rebuild({ ...mapping, depositId: "456" })).toEqual({ state: "pending" });
    expect(await defaults.rebuild({ ...mapping, legRevision: "3" })).toEqual({ state: "pending" });
  });
  it("honors indexer Retry-After without retries, sleeps or stale cached authorization", async () => {
    const s = setup();
    s.indexer.status = 429;
    await expect(s.defaults.executionTerms(intent, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
    expect(s.indexer.calls).toBe(1);
    s.indexer.status = 200;
    s.advance(1999);
    await expect(s.defaults.executionTerms(intent, "revolut")).rejects.toThrow(
      "capability_unavailable",
    );
    expect(s.indexer.calls).toBe(1);
    s.advance(1);
    expect((await s.defaults.executionTerms(intent, "revolut")).maximum).toBe("25000000");
    expect(s.indexer.calls).toBe(2);
  });
  it("does not expose a raw indexer response/error", async () => {
    const query = createMakerIndexer({
      fetch: async () => Response.json({ errors: [{ message: "[synthetic-private-error]" }] }),
    });
    await expect(query("query {}", {})).rejects.toThrow("capability_unavailable");
  });
  it("wires default reads, private registration, unsigned SDK preparation and durable recovery", async () => {
    const s = setup();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    let plans = 0;
    const sdk: UnsignedMakerSDK = {
      registerPayeeDetails: async () => ({
        depositDetails: [],
        hashedOnchainIds: [`0x${"3".repeat(64)}`],
      }),
      prepareCreateDeposit: async () => {
        plans++;
        return {
          depositDetails: [],
          prepared: { chainId: 8453, to: config.escrow as Hex, data: creation().data, value: 0n },
        };
      },
      removeFunds: {
        prepare: async () => ({
          chainId: 8453,
          to: config.escrow as Hex,
          data: "0x1234",
          value: 0n,
        }),
      },
      withdrawDeposit: {
        prepare: async () => ({
          chainId: 8453,
          to: config.escrow as Hex,
          data: "0x1234",
          value: 0n,
        }),
      },
    };
    const now = () => Date.parse(recorded.responseObject.quoteExpiresAt) - 10000;
    const discoveryReads = {
      bestByPlatform: async () => structuredClone(recorded),
      quote: async () => structuredClone(recorded),
    };
    const opts = {
      publicClient: s.chain.client,
      sdk,
      wallet,
      storage,
      fetch: s.indexer.fetch,
      now,
      discoveryReads,
    };
    const provider = createLivePeerOfframpProvider(opts);
    await provider.setupOwnAccount("revolut", "[synthetic-own-account]", "own_account");
    const offers = provider.normalizeCapabilities(await provider.capabilities(intent), intent);
    const offer = offers.find((o) => o.rail.id === "revolut")!;
    expect(offer.availability.state).toBe("available");
    const preview = await provider.preview(intent, offer);
    let snapshot = await provider.approve(preview, {
      expected_revision: "0",
      idempotency_key: "live_approve",
    });
    snapshot = await provider.interact(preview.operation_id, {
      expected_revision: snapshot.revision,
      idempotency_key: "live_prepare",
    });
    expect(snapshot.peer.state).toBe("action_required");
    expect((await provider.takeUnsignedPlan(preview.operation_id)).action).toBe("create_deposit");
    await provider.recordSubmission(preview.operation_id, "create_deposit", txHash);
    expect((await provider.orderStatus(preview.operation_id)).phase).toBe("awaiting_buyer");
    const resumed = createLivePeerOfframpProvider(opts);
    expect((await resumed.orderStatus(preview.operation_id)).phase).toBe("awaiting_buyer");
    expect(plans).toBe(1);
    expect([...values.values()].join("")).not.toContain("synthetic-own-account");
  });
  it("does not infer Autopilot or identity eligibility from successful payee registration", async () => {
    const s = setup();
    expect((await s.defaults.reads.readiness(intent, "venmo")).sellerSetup).toBe("required");
    expect((await s.defaults.reads.readiness(intent, "paypal")).requiresIdentityAttestation).toBe(
      true,
    );
  });
});
