// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { listLocalSwaps, upsertLocalSwap } from "../../lib/localActivity.js";
import { findOnrampRoute } from "./routeActivity.js";
import { ROUTE_RECEIVED, ROUTE_WALLET } from "../../test/routePort.js";
import type { SwapActivityItem } from "../../types/activity.js";
afterEach(() => localStorage.clear());
const row: SwapActivityItem = {
  id: "xochi_public_intent",
  type: "swap",
  timestamp: 1,
  status: "pending",
  intentStatus: "executing",
  rampOperationId: "widget_ramp",
  data: {
    fromChainId: 8453,
    toChainId: 1,
    fromToken: ROUTE_RECEIVED.asset.kind === "crypto" ? ROUTE_RECEIVED.asset.asset_id : "",
    toToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    fromAmount: "25000000",
    toAmount: "24500000",
    tier: "Base",
    feeRate: 0,
    txHash: null,
    isCrossChain: true,
    settlementType: "stealth",
    stealthPayee: "other",
  },
};
it("links the existing public Xochi activity reference, retaining no recipient keys", () => {
  upsertLocalSwap(ROUTE_WALLET, row);
  expect(findOnrampRoute(ROUTE_WALLET, "widget_ramp", ROUTE_RECEIVED)?.id).toBe(row.id);
  expect(listLocalSwaps(ROUTE_WALLET)[0].data.stealthPayee).toBe("other");
  expect(JSON.stringify(listLocalSwaps(ROUTE_WALLET))).not.toContain("spendingPubKey");
  expect(JSON.stringify(listLocalSwaps(ROUTE_WALLET))).not.toContain("viewingPubKey");
});
it("requires the original wallet, widget reference and exact confirmed Base funding", () => {
  upsertLocalSwap(ROUTE_WALLET, row);
  expect(
    findOnrampRoute("0x2222222222222222222222222222222222222222", "widget_ramp", ROUTE_RECEIVED),
  ).toBeUndefined();
  expect(findOnrampRoute(ROUTE_WALLET, "another_ramp", ROUTE_RECEIVED)).toBeUndefined();
  upsertLocalSwap(ROUTE_WALLET, { ...row, data: { ...row.data, fromAmount: "1" } });
  expect(findOnrampRoute(ROUTE_WALLET, "widget_ramp", ROUTE_RECEIVED)).toBeUndefined();
  upsertLocalSwap(ROUTE_WALLET, { ...row, data: { ...row.data, fromChainId: 1 } });
  expect(findOnrampRoute(ROUTE_WALLET, "widget_ramp", ROUTE_RECEIVED)).toBeUndefined();
});
