// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import type { RampSnapshot } from "@xochi/client";
import { STORAGE_KEYS } from "../../constants.js";
import {
  abandonRampSummary,
  getRampSummary,
  listRampSummaries,
  parseRampSummary,
  summaryBlocksNewPurchase,
  summaryFromSnapshot,
  upsertRampSummary,
  type RampOperationSummary,
} from "./summaries.js";

const at = "2026-11-16T12:00:00.000Z";
const base: RampOperationSummary = {
  operation_id: "op_1",
  direction: "onramp",
  wallet: "0x1111111111111111111111111111111111111111",
  rail: { id: "wise", label: "Wise" },
  pay: { asset: { kind: "fiat", currency: "USD", decimals: 6 }, atomic: "25996971" as never },
  receive: {
    asset: {
      kind: "crypto",
      chain_id: "eip155:8453",
      asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    atomic: "25000000" as never,
  },
  quote_expires_at: at,
  submitted: false,
  state: "quoted",
  terminal: false,
  created_at: at,
  updated_at: at,
};
beforeEach(() => window.localStorage.clear());

it("refuses rows carrying provider handles or payment identity", () => {
  for (const extra of [
    { intent_hash: `0x${"1".repeat(64)}` },
    { payment_recipient: "@someone" },
    { proof: "material" },
    { session_id: "s" },
    { launch_url: "https://example.invalid/bearer" },
  ]) {
    expect(parseRampSummary({ ...base, ...extra })).toBeNull();
    upsertRampSummary({ ...base, ...extra } as RampOperationSummary);
  }
  expect(window.localStorage.getItem(STORAGE_KEYS.localRamps)).toBeNull();
  expect(parseRampSummary({ ...base, rail: { ...base.rail, handle: "@x" } })).toBeNull();
  expect(parseRampSummary({ ...base, wallet: base.wallet.toUpperCase() })).toBeNull();
  expect(parseRampSummary({ ...base, pay: { ...base.pay, atomic: "25.99" } })).toBeNull();
});

it("drops tampered rows on read and keeps the existing storage keys untouched", () => {
  upsertRampSummary(base);
  window.localStorage.setItem(
    STORAGE_KEYS.localRamps,
    JSON.stringify([
      ...JSON.parse(window.localStorage.getItem(STORAGE_KEYS.localRamps)!),
      { ...base, operation_id: "op_2", payee: "@x" },
    ]),
  );
  expect(listRampSummaries().map((row) => row.operation_id)).toEqual(["op_1"]);
  expect(Object.keys(window.localStorage)).toEqual([STORAGE_KEYS.localRamps]);
  expect(STORAGE_KEYS.localRamps).not.toMatch(/^xochi_local_(sends|activity):/);
});

it("never un-submits, records the first held time, and abandons only unsubmitted flows", () => {
  const snapshot = (peer: Partial<RampSnapshot["peer"]>, terminal = false): RampSnapshot => ({
    contract_version: "ramp/1",
    kind: "snapshot",
    operation_id: "op_1",
    revision: "3",
    direction: "onramp",
    leg_order: ["peer"],
    peer: { name: "peer", state: "processing", recoverable: false, ...peer },
    allowed_actions: [],
    terminal,
    updated_at: at,
  });
  const submitted = summaryFromSnapshot(base, snapshot({ state: "in_doubt", recoverable: true }));
  expect(submitted.submitted).toBe(true);
  expect(summaryBlocksNewPurchase(submitted)).toBe(true);
  const held = summaryFromSnapshot(submitted, snapshot({ payout_state: "held" }), 1_000);
  expect(held.held_since).toBe(new Date(1_000).toISOString());
  expect(summaryFromSnapshot(held, snapshot({ payout_state: "held" }), 9_000).held_since).toBe(
    held.held_since,
  );
  const failed = summaryFromSnapshot(held, snapshot({ state: "failed" }, true));
  expect(failed.submitted).toBe(true);
  expect(summaryBlocksNewPurchase(failed)).toBe(false);

  upsertRampSummary(submitted);
  expect(abandonRampSummary("op_1")).toBe(false);
  upsertRampSummary(base);
  expect(abandonRampSummary("op_1")).toBe(true);
  expect(getRampSummary("op_1")?.abandoned).toBe(true);
});
