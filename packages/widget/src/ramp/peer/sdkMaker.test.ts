import { describe, expect, it } from "vitest";
import { atomic, type RampIntent } from "@xochi/client";
import { decodeFunctionData, erc20Abi } from "viem";
import type { PreparedTransaction } from "@zkp2p/sdk";
import { peerConfiguration } from "./discovery.js";
import { createSDKMakerIO, type UnsignedMakerSDK } from "./sdkMaker.js";
import { MakerSetupRequired, MakerWithdrawalBlocked } from "./offramp.js";
const config = peerConfiguration();
const now = Date.parse("2026-11-16T00:00:00Z");
const wallet = "0x000000000000000000000000000000000000dEaD";
const intent: RampIntent = {
  contract_version: "ramp/1",
  kind: "intent",
  direction: "offramp",
  fiat: { kind: "fiat", currency: "USD", decimals: 6 },
  crypto: config.settlement,
  exact: { side: "crypto", money: { asset: config.settlement, atomic: atomic("2000000") } },
  recipient: wallet,
};
const tx: PreparedTransaction = {
  chainId: 8453,
  to: config.escrow as `0x${string}`,
  data: "0x1234",
  value: 0n,
};
class MemorySDK implements UnsignedMakerSDK {
  registered = 0;
  deposits: Parameters<UnsignedMakerSDK["prepareCreateDeposit"]>[0][] = [];
  partial: string[] = [];
  full = 0;
  refusal?: string;
  async registerPayeeDetails() {
    this.registered++;
    if (this.refusal)
      throw Object.assign(new Error("[synthetic-redacted-error]"), { code: this.refusal });
    return { depositDetails: [], hashedOnchainIds: [`0x${"3".repeat(64)}`] };
  }
  async prepareCreateDeposit(input: Parameters<UnsignedMakerSDK["prepareCreateDeposit"]>[0]) {
    this.deposits.push(input);
    return { prepared: tx, depositDetails: [] };
  }
  removeFunds = {
    prepare: async (input: Parameters<UnsignedMakerSDK["removeFunds"]["prepare"]>[0]) => {
      this.partial.push(input.amount.toString());
      return tx;
    },
  };
  withdrawDeposit = {
    prepare: async () => {
      this.full++;
      return tx;
    },
  };
}
function setup() {
  const sdk = new MemorySDK();
  const terms = {
    minimum: "1000000",
    maximum: "5000000",
    conversionRate: "1000000000000000000",
    validUntil: new Date(now + 20_000).toISOString(),
  };
  const io = createSDKMakerIO({
    sdk,
    discovery: { now: () => now },
    executionTerms: async () => terms,
    reads: {
      readiness: async () => ({
        oracleFresh: true,
        requiresIdentityAttestation: false,
        identityAttested: false,
        sellerSetup: "ready",
      }),
      allowance: async () => true,
      reconcile: async () => ({ state: "pending" }),
      deposit: async () => ({
        remaining: "2000000",
        unmatched: "2000000",
        filled: "0",
        withdrawn: "0",
        activeIntents: 0,
        closed: false,
      }),
    },
  });
  return { sdk, io, terms };
}
describe("SDK maker preparation port", () => {
  it("encodes exact ERC-20 approval without invoking a signer", async () => {
    const { io } = setup();
    const prepared = await io.prepareApproval("2000000");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: prepared.data });
    expect(prepared.to.toLowerCase()).toBe(config.settlement.asset_id.toLowerCase());
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([config.escrow, 2000000n]);
  });
  it("registers privately and uses only SDK unsigned prepare methods", async () => {
    const { io, sdk } = setup();
    const payeeHash = await io.registerOwnPayee("revolut", "[synthetic-own-account]");
    await io.prepareDeposit({ intent, rail: "revolut", amount: "2000000", payeeHash });
    expect(sdk.registered).toBe(1);
    expect(sdk.deposits[0]).toMatchObject({
      amount: 2000000n,
      intentAmountRange: { min: 1000000n, max: 2000000n },
      payeeDetailsHashes: [payeeHash],
      retainOnEmpty: false,
    });
    expect(sdk.deposits[0]).not.toHaveProperty("payeeData");
    await io.prepareWithdrawal("123", "1000000", false);
    await io.prepareWithdrawal("123", "2000000", true);
    expect(sdk.partial).toEqual(["1000000"]);
    expect(sdk.full).toBe(1);
  });
  it.each(["wise", "paypal", "alipay"])(
    "enforces documented identity setup for %s",
    async (rail) => {
      const { io } = setup();
      expect((await io.readiness(intent, rail)).requiresIdentityAttestation).toBe(true);
    },
  );
  it.each([
    "SELLER_AUTOPILOT_REQUIRED",
    "SELLER_CREDENTIAL_REQUIRED",
    "IDENTITY_ATTESTATION_REQUIRED",
  ])("sanitizes explicit setup refusal %s", async (code) => {
    const { io, sdk } = setup();
    sdk.refusal = code;
    await expect(io.registerOwnPayee("revolut", "[synthetic-own-account]")).rejects.toBeInstanceOf(
      MakerSetupRequired,
    );
  });
  it("sanitizes withdrawal refusal and rejects stale execution prices", async () => {
    const { io, sdk, terms } = setup();
    sdk.refusal = "ACTIVE_INTENT_BLOCKS_WITHDRAWAL";
    await expect(io.registerOwnPayee("revolut", "[synthetic-own-account]")).rejects.toBeInstanceOf(
      MakerWithdrawalBlocked,
    );
    terms.validUntil = new Date(now).toISOString();
    await expect(
      io.prepareDeposit({
        intent,
        rail: "revolut",
        amount: "2000000",
        payeeHash: "[synthetic-hash]",
      }),
    ).rejects.toThrow("provider_declined");
    expect(sdk.deposits).toHaveLength(0);
  });
});
