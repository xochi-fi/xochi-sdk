// @vitest-environment jsdom

/**
 * Execution and solver proof (trade-widget-mvp.md, Phase 5).
 *
 * Was source text: `readFileSync` of `SwapFlowModal.tsx`, `SolverRace.tsx`,
 * `SwapResult.tsx` and `useSwapPanel.ts`, then `toContain` on flattened JSX --
 * including `toContain("{props.receivedAmount} {props.toSymbol}")`, which the
 * IntentView collapse rewrote without changing a pixel, and
 * `not.toContain("amountOut")`, which would have passed with the figure rendered
 * under a different local name.
 *
 * All three components render standalone, so the same rules are now checked
 * against the DOM a user gets:
 *
 *   - the signed payout figure never leaves the screen while the order fills,
 *     and the safe-to-close note renders with the timeline (pass-1 3.4);
 *   - the solver round renders handles and status words ONLY: no bid amount and
 *     no improvement figure until improvements are payable (register R19), and
 *     no invented lanes when zero frames arrive;
 *   - the stealth ending never reads as a finished public swap: its own title,
 *     no explorer link (the sweep hash is privacy-sensitive), and the claims
 *     handoff as the primary action (pass-1 4.6).
 *
 * The fourth rule -- an in-flight order with the modal closed keeps a way back
 * in -- moved to recoveryHistory.test.tsx, where the intent can be put in flight
 * for real (via the persisted-record resume) instead of pattern-matched in the
 * hook's source.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { renderTrade, apiStub } from "./harness.js";
import { SwapFlowModal, type IntentView } from "../../components/SwapFlowModal.js";
import { SolverRace } from "../../components/SolverRace.js";
import { SwapResult } from "../../components/swap-flow/SwapResult.js";
import { DEFAULT_DESTINATION, STEALTH_DESTINATION } from "../../types/intent.js";
import type { IntentStatus, RaceWebSocketMessage } from "../../types/intent.js";
import { phaseFromStatus } from "@xochi/client";
import { testBudget } from "../../test/waitBudget.js";

// Longest test: "keeps the payout figure on screen while the order fills" --
// it loops the three in-flight statuses, calling `openFlow` (a full
// `renderTrade` of the provider stack) each time, so 3 renders and 0 waits.
// This file has no waitFor and no findBy; the rest of its tests render the
// components standalone, which is cheaper.
vi.setConfig({ testTimeout: testBudget({ renders: 3, waits: 0 }) });

beforeEach(() => {
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A quiet intent, overridden per test.
 *
 * One object because the modal now takes one: `IntentView` replaced eighteen
 * drilled props, so a fixture is a fixture rather than an eighteen-line prop
 * list repeated per case.
 */
const intentView = (over: Partial<IntentView> = {}): IntentView => ({
  status: "idle",
  error: null,
  refundReason: null,
  intentId: null,
  quoteId: null,
  txHash: null,
  receivingTxHash: null,
  settlementTxHash: null,
  settlementChainId: null,
  substatus: null,
  quote: null,
  permitType: "none",
  approval: "none",
  awaitingPull: false,
  isSigningPull: false,
  quoteExpiresIn: null,
  raceEvents: [],
  fillMs: null,
  attestedDeposit: null,
  pollExhausted: false,
  // The machine's phase for a quiet intent at this status.
  receipt: { phase: phaseFromStatus(over.status ?? "idle"), signing: { kind: "unavailable" } },
  ...over,
});

const noop = (): void => {};

const openFlow = (status: IntentStatus, onCancelSign = noop) =>
  renderTrade(
    <SwapFlowModal
      open
      intent={intentView({ status, intentId: "xi_exec", quoteId: "q_exec" })}
      fromAmount="5000000"
      fromSymbol="USDC"
      fromDecimals={6}
      toSymbol="USDC"
      toDecimals={6}
      receivedAmount="4.989"
      fromChainId={8453}
      toChainId={42161}
      destination={DEFAULT_DESTINATION}
      isCrossChain
      estimatedDuration={60}
      onConfirm={noop}
      onCancelSign={onCancelSign}
      onRetry={noop}
      onClose={noop}
    />,
  );

describe("signed payout held through execution", () => {
  it("keeps the payout figure on screen while the order fills", async () => {
    // The one number the user cares about must survive every phase between
    // signing and done. Asserted for each in-flight phase rather than one,
    // because the progress branch is a single guard covering all of them and a
    // regression that drops one drops it silently.
    for (const status of ["executing", "bridging", "settling"] as const) {
      await openFlow(status);
      expect(screen.getByText(/^Receive/).textContent).toContain("4.989 USDC");
      cleanup();
    }
  });

  it("says the tab is safe to close, but only once the order is with the solver", async () => {
    await openFlow("executing");
    expect(
      screen.getByText(
        "Safe to close this tab. The order continues and Activity keeps the result.",
      ),
    ).toBeTruthy();
    cleanup();

    // During awaiting-wallet nothing has been submitted, so closing the tab
    // WOULD end the order. Promising otherwise there is the failure mode.
    await openFlow("signing");
    expect(screen.queryByText(/Safe to close this tab/)).toBeNull();
  });

  it("lets a user cancel a wallet prompt that cannot be approved", async () => {
    let cancelled = 0;
    await openFlow("signing", () => {
      cancelled += 1;
    });

    const cancel = screen.getByRole("button", { name: "Cancel signing" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    cancel.click();
    expect(cancelled).toBe(1);
  });
});

describe("solver round renders handles only (R19)", () => {
  const frame = (over: Partial<RaceWebSocketMessage>): RaceWebSocketMessage => ({
    type: "solver_bid",
    intentId: "xi_exec",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const frames: RaceWebSocketMessage[] = [
    frame({ type: "race_started", solversActive: 2 }),
    frame({ solver: "riddler-a", amountOut: "4999000", improvementBps: 42 }),
    frame({ solver: "riddler-b", amountOut: "4991000", improvementBps: 12 }),
    frame({ type: "race_won", solver: "riddler-a", amountOut: "4999000", elapsedMs: 1234 }),
  ];

  it("renders each solver handle and no figure from its bid", () => {
    const { container } = render(<SolverRace raceEvents={frames} settled />);
    // The handles ARE the content.
    expect(container.textContent).toContain("riddler-a");
    expect(container.textContent).toContain("riddler-b");
    // The frames carry amountOut and improvementBps. Rendering either promises
    // money no settlement path can pay: the payout is the signed quote, exactly.
    // Checked on rendered text, so a rename inside the component cannot make
    // this vacuous the way the old source-text check could.
    expect(container.textContent).not.toContain("4999000");
    expect(container.textContent).not.toContain("4991000");
    expect(container.textContent).not.toMatch(/4\.999|0\.42%|42 ?bps|improvement/i);
    expect(container.textContent).not.toMatch(/beat your quote/i);
  });

  it("renders only the unconditional truth when zero frames arrive", () => {
    // No race telemetry for the route, a dead socket, or no stream topic. The
    // sealed-intent line is true regardless; invented competitors are not.
    const { container } = render(<SolverRace raceEvents={[]} settled={false} />);
    expect(container.textContent).toContain(
      "The intent is sealed. It never touches a public mempool.",
    );
    expect(container.querySelectorAll(".solver-race__lane")).toHaveLength(0);
  });
});

describe("stealth ending is its own state (4.6)", () => {
  const stealthSuccess = (onGoToClaims?: () => void) =>
    render(
      <SwapResult
        variant="success"
        isStealth
        fromChainId={8453}
        toChainId={1}
        isCrossChain
        txHash={`0x${"11".repeat(32)}`}
        settlementTxHash={`0x${"22".repeat(32)}`}
        settlementChainId={1}
        receivedAmount="4.989"
        toSymbol="USDC"
        originTokens={["USDC"]}
        onRetry={noop}
        onClose={noop}
        onGoToClaims={onGoToClaims}
      />,
    );

  it("titles the stealth completion as a landing, not a finished swap", () => {
    expect(stealthSuccess().container.textContent).toContain("Landed at the private address");
    cleanup();
    // The contrast is the point: the same variant on a public route says the
    // swap is done, because there it is.
    const { container } = render(
      <SwapResult
        variant="success"
        fromChainId={8453}
        toChainId={42161}
        isCrossChain
        txHash={`0x${"11".repeat(32)}`}
        receivedAmount="4.989"
        toSymbol="USDC"
        originTokens={["USDC"]}
        onRetry={noop}
        onClose={noop}
      />,
    );
    expect(container.textContent).toContain("Swap complete");
  });

  it("suppresses explorer links on a stealth ending", () => {
    // The sweep hash is privacy-sensitive: linking it hands an observer the
    // one-time address the whole settlement exists to hide.
    expect(stealthSuccess().container.querySelectorAll("a")).toHaveLength(0);
    cleanup();
    // Same fixture minus `isStealth` DOES link, so the assertion above is about
    // the stealth gate and not about a fixture that never had a link.
    const { container } = render(
      <SwapResult
        variant="success"
        fromChainId={8453}
        toChainId={42161}
        isCrossChain
        txHash={`0x${"11".repeat(32)}`}
        settlementTxHash={`0x${"22".repeat(32)}`}
        settlementChainId={42161}
        receivedAmount="4.989"
        toSymbol="USDC"
        originTokens={["USDC"]}
        onRetry={noop}
        onClose={noop}
      />,
    );
    expect(container.querySelectorAll("a").length).toBeGreaterThan(0);
  });

  it("offers the claims handoff as the stealth primary action", () => {
    let handed = 0;
    stealthSuccess(() => {
      handed += 1;
    });
    const primary = screen.getByRole("button", { name: "Claim payment" });
    expect(primary.className).toContain("swap-result__primary");
    primary.click();
    expect(handed).toBe(1);
  });

  it("routes the modal's stealth ending through that same handoff", async () => {
    // End to end through the flow surface, since the modal is what decides
    // which ending a dispatched order gets -- from the order's OWN destination,
    // never the live toggle.
    let handed = 0;
    await renderTrade(
      <SwapFlowModal
        open
        intent={intentView({ status: "completed", intentId: "xi_done" })}
        fromAmount="5000000"
        fromSymbol="USDC"
        fromDecimals={6}
        toSymbol="USDC"
        toDecimals={6}
        receivedAmount="4.989"
        fromChainId={8453}
        toChainId={1}
        destination={STEALTH_DESTINATION}
        isCrossChain
        estimatedDuration={60}
        onConfirm={noop}
        onCancelSign={noop}
        onRetry={noop}
        onClose={noop}
        onGoToClaims={() => {
          handed += 1;
        }}
      />,
    );
    expect(screen.getByText("Landed at the private address")).toBeTruthy();
    screen.getByRole("button", { name: "Claim payment" }).click();
    expect(handed).toBe(1);
  });
});
