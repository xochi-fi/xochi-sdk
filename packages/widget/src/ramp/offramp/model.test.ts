// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { atomic, type RampIntent } from "@xochi/client";
import {
  canaryCapError,
  estimateSecondsLeft,
  formatEstimate,
  maskPayee,
  payeeError,
  progressSteps,
  usdcDecimal,
} from "./model.js";
import {
  listLocalOfframps,
  parseOfframpRecord,
  resumableOfframp,
  upsertLocalOfframp,
  type OfframpActivityItem,
} from "./localOfframps.js";
import { MemoryMaker, memoryOfframpPort } from "../../test/offrampPort.js";
import { peerConfiguration, type UnsignedMakerSDK } from "../peer/index.js";
import { withReferralCode } from "./port.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const row = (over: Partial<OfframpActivityItem> = {}): OfframpActivityItem => ({
  id: "op_1",
  type: "offramp",
  timestamp: 1,
  stage: "deposit",
  status: "open",
  data: { rail: "wise", currency: "USD", amount: "25000000" },
  ...over,
});

afterEach(() => window.localStorage.clear());

describe("payee", () => {
  it("masks after entry and bounds the handle", () => {
    expect(maskPayee("synthetic-handle-42")).toBe("sy••••42");
    expect(maskPayee("abc")).not.toContain("abc");
    expect(payeeError("  ")).toBeDefined();
    expect(payeeError("x".repeat(257))).toBeDefined();
    expect(payeeError("a\u0000b")).toBeDefined();
    expect(payeeError("@me")).toBeUndefined();
  });
});

describe("amounts and estimates", () => {
  it("formats without floats and never as an exact payout", () => {
    expect(usdcDecimal("25000000")).toBe("25");
    expect(usdcDecimal("1500001")).toBe("1.500001");
    expect(usdcDecimal("1")).toBe("0.000001");
    expect(formatEstimate("24750000", "USD", 6)).toBe("about 24.75 USD");
  });
  it("treats an estimate at its expiry as stale", () => {
    const expires_at = new Date(10_000).toISOString();
    expect(estimateSecondsLeft({ expires_at }, 9_001)).toBe(1);
    expect(estimateSecondsLeft({ expires_at }, 10_000)).toBe(0);
    expect(estimateSecondsLeft({ expires_at: "nope" }, 0)).toBe(0);
  });
});

describe("canary cap", () => {
  it("applies only when set and only above the cap", () => {
    expect(canaryCapError("25000000", undefined)).toBeUndefined();
    expect(canaryCapError("5000000", "5000000")).toBeUndefined();
    expect(canaryCapError("5000001", "5000000")).toMatch(/limits each cash-out/);
    expect(canaryCapError(undefined, "5000000")).toBeUndefined();
  });
});

describe("referral code", () => {
  it("is attached to deposit creation only when configured", async () => {
    const seen: unknown[] = [];
    const sdk = {
      registerPayeeDetails: async () => ({}),
      prepareCreateDeposit: async (params: unknown) => {
        seen.push(params);
        return {};
      },
      removeFunds: { prepare: async () => ({}) },
      withdrawDeposit: { prepare: async () => ({}) },
    } as unknown as UnsignedMakerSDK;
    const params = { amount: 1n } as unknown as Parameters<
      UnsignedMakerSDK["prepareCreateDeposit"]
    >[0];
    expect(withReferralCode(sdk, undefined)).toBe(sdk);
    await withReferralCode(sdk, undefined).prepareCreateDeposit(params);
    await withReferralCode(sdk, "ABC123").prepareCreateDeposit(params);
    expect(seen).toEqual([{ amount: 1n }, { amount: 1n, referralCode: "ABC123" }]);
  });
});

describe("progress", () => {
  it("walks the forward path and keeps returned off it", () => {
    expect(progressSteps("matched").map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(progressSteps("delivered").every((s) => s.state === "done")).toBe(true);
    expect(progressSteps(undefined).every((s) => s.state === "upcoming")).toBe(true);
  });
});

describe("local summaries", () => {
  it("keeps only the allowlisted shape and drops anything else", () => {
    const tainted = { ...row(), payee: "secret", data: { ...row().data, depositId: "9" } };
    const parsed = parseOfframpRecord(tainted)!;
    expect(JSON.stringify(parsed)).not.toMatch(/secret|depositId/);
    expect(parseOfframpRecord({ ...row(), data: { ...row().data, amount: "1.5" } })).toBeNull();
    expect(parseOfframpRecord({ ...row(), status: "paid" })).toBeNull();
    expect(parseOfframpRecord({ ...row(), id: "has space" })).toBeNull();
  });
  it("updates in place, keeps the first time, and resumes only open orders", () => {
    upsertLocalOfframp(WALLET, row({ timestamp: 5 }));
    upsertLocalOfframp(WALLET, row({ timestamp: 9, status: "delivered", phase: "delivered" }));
    const rows = listLocalOfframps(WALLET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ timestamp: 5, status: "delivered" });
    expect(resumableOfframp(rows)).toBeUndefined();
    upsertLocalOfframp(WALLET, row({ id: "op_2", timestamp: 7, status: "in_doubt" }));
    expect(resumableOfframp(listLocalOfframps(WALLET))?.id).toBe("op_2");
    expect(listLocalOfframps("0x2222222222222222222222222222222222222222")).toEqual([]);
  });
});

describe("maker capability revision", () => {
  it("does not change with the observation clock", async () => {
    const port = memoryOfframpPort({ account: WALLET });
    const settlement = peerConfiguration().settlement;
    const intent: RampIntent = {
      contract_version: "ramp/1",
      kind: "intent",
      direction: "offramp",
      exact: { side: "crypto", money: { asset: settlement, atomic: atomic("25000000") } },
      fiat: { kind: "fiat", currency: "USD", decimals: 6 },
      crypto: settlement,
      recipient: WALLET,
    };
    const { provider } = await port.runtime(WALLET);
    const revision = async () =>
      provider
        .normalizeCapabilities(await provider.capabilities(intent), intent)
        .find((o) => o.rail.id === "wise")!.capability_revision;
    const first = await revision();
    port.maker.clock.t = Date.now() + 5_000;
    expect(await revision()).toBe(first);
    expect(port.maker).toBeInstanceOf(MemoryMaker);
  });
});
