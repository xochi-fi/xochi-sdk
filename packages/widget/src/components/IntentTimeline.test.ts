import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TRON_CHAIN_ID } from "@xochi/client";
import { IntentTimeline } from "./IntentTimeline.js";
import type { IntentStatus } from "../types/intent.js";

// Assertions target `>...<` because the stage row renders `shortLabel`, not
// `label`, so matching on the long form would pass vacuously.
type Overrides = Partial<Parameters<typeof IntentTimeline>[0]>;

const html = (overrides: Overrides = {}): string =>
  renderToStaticMarkup(
    createElement(IntentTimeline, {
      status: "bridging" as IntentStatus,
      isCrossChain: true,
      fromChainId: TRON_CHAIN_ID,
      toChainId: 8453,
      txHash: null,
      ...overrides,
    }),
  );

/**
 * A Tron-origin deposit route has no wallet signature anywhere: the user sends
 * TRC-20 from an external wallet and the solver settles on detection. The
 * timeline reused the cross-chain stages regardless, so it showed a completed
 * "Sign" step on a flow whose own confirm screen reads "Nothing to sign". A user
 * trying to work out whether they had missed a wallet prompt got two answers
 * from two screens and no way to reconcile them.
 */
describe("IntentTimeline deposit stages", () => {
  it("opens on the deposit, not on a signature that never happened", () => {
    const out = html({ isDeposit: true });
    expect(out).toContain(">Sent<");
    expect(out).not.toContain(">Sign<");
  });

  it("keeps the signed stage on an ordinary cross-chain route", () => {
    const out = html({ isDeposit: false });
    expect(out).toContain(">Sign<");
    expect(out).not.toContain(">Sent<");
  });

  // isDeposit has to win: a deposit route is always cross-chain, so keying off
  // isCrossChain alone can never distinguish them.
  it("prefers the deposit stages over the cross-chain ones", () => {
    expect(html({ isDeposit: true, isCrossChain: true })).toContain(">Sent<");
  });

  it("still reaches a terminal stage on a completed deposit", () => {
    expect(html({ isDeposit: true, status: "completed" as IntentStatus })).toContain(">Done<");
  });

  // Absent prop must behave exactly as before, so no existing route shifts.
  it("defaults to the pre-existing behaviour", () => {
    expect(html()).toContain(">Sign<");
  });
});
