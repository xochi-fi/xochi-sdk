// @vitest-environment jsdom

/**
 * The flow's own status poll can see a private swap's TERMINAL status-only
 * answer (`legs_withheld: true`, SPEC §5.1) before the activity feed's poll
 * does. Its capture write then turns the record terminal, and the feed never
 * polls a terminal record again, so the served verdict has to ride that write
 * or the row's wallet sign-in offer never appears. Before the flow has read
 * the intent at all, its write must leave the feed's verdict alone.
 *
 * `useSwapFlow` is driven with the intent it would get from `useIntent`; the
 * capture write, the stored record and the feed row are all real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import type { IntentStatus } from "../../types/intent.js";
import { renderTrade, apiStub, TEST_ACCOUNT } from "./harness.js";
import { useSwapFlow } from "./useSwapFlow.js";
import { TOKENS } from "./config.js";
import type { UseIntentReturn } from "../../hooks/useIntent.js";
import { listLocalSwaps, refreshLocalSwaps } from "../../lib/localActivity.js";
import { ActivityFeed } from "../../components/ActivityFeed.js";
import { LINKS_SIGN_IN_LABEL } from "../../components/LinksSignIn.js";
import { testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 0 }) });

const INTENT_ID = "xi_flow_capture";
const noop = (): void => {};

/** A dispatched stealth intent as `useIntent` reports it, overridden per step. */
const intentAt = (status: IntentStatus, legsWithheld: boolean | null): UseIntentReturn => ({
  status,
  quote: null,
  error: null,
  refundReason: null,
  txHash: null,
  receivingTxHash: null,
  settlementTxHash: null,
  settlementChainId: null,
  substatus: null,
  legsWithheld,
  escrow: null,
  reconciling: false,
  intentId: INTENT_ID,
  quoteId: "xq_flow_capture",
  quotedAddress: TEST_ACCOUNT,
  quotedFromAmount: "5000000",
  attestedDeposit: null,
  pollExhausted: false,
  receipt: {
    phase: status === "completed" ? "success" : "settling",
    quote: { kind: "none" },
    payout: { kind: "none" },
    cost: { kind: "none" },
    settlement: {
      mode: "stealth",
      label: "Stealth",
      recipient: "one_time_address",
      amount: "visible",
      recipientAction: "claim",
    },
    signing: { kind: "unavailable" },
  },
  isLoading: false,
  canSign: false,
  canAllocateDepositRoute: false,
  feeRate: "0.22",
  tierName: "Standard",
  permitType: "none",
  approval: "none",
  isApproving: false,
  requestQuote: noop,
  allocateDepositRoute: () => Promise.resolve(false),
  sign: noop,
  cancelSign: () => false,
  signPull: noop,
  reset: noop,
  resume: noop,
  awaitingPull: false,
  isSigningPull: false,
  quoteExpiresIn: null,
  refreshQuote: noop,
  raceEvents: [],
  fillMs: null,
});

let setIntent: (next: UseIntentReturn) => void = noop;

/** The swap panel's flow group with nothing but its capture write observable. */
function FlowProbe({ initial }: { initial: UseIntentReturn }) {
  const [intent, set] = useState(initial);
  setIntent = set;
  useSwapFlow({
    prefill: null,
    intent,
    isConnected: true,
    address: TEST_ACCOUNT,
    connectedChainId: 8453,
    fromChainId: 8453,
    toChainId: 42161,
    fromToken: TOKENS[8453][0],
    toToken: TOKENS[42161][0],
    routeCheck: { status: "supported" },
    applyRoute: noop,
    amount: "5",
    amountBigInt: 5_000_000n,
    insufficientBalance: false,
    currentBalance: 5_000_000n,
    excessiveSlippage: false,
    orderOutOfBounds: false,
    setAmount: noop,
    settlement: "stealth",
    settlementFix: null,
    destination: { type: "stealth", chainId: 42161, shielded: false },
    recipientMissing: false,
    recipientInvalid: false,
    restoreSettlement: noop,
    clearRecipient: noop,
    restoreRecipientTag: noop,
    restoreRefundAddress: noop,
    flowOpen: true,
    setFlowOpen: noop,
    resumed: null,
    setResumed: noop,
  });
  return null;
}

const stored = () => listLocalSwaps(TEST_ACCOUNT).find((r) => r.id === INTENT_ID);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("the flow capture carries the served legs_withheld verdict", () => {
  it("keeps the sign-in offer when the flow poll saw the terminal anonymous answer first", async () => {
    await renderTrade(<FlowProbe initial={intentAt("settling", null)} />, { connected: true });
    // Before any status read there is no verdict to persist.
    expect(stored()?.intentStatus).toBe("settling");
    expect(stored()?.legsWithheld).toBeUndefined();

    // The flow poll's terminal anonymous read lands first.
    act(() => setIntent(intentAt("completed", true)));
    expect(stored()?.intentStatus).toBe("completed");
    expect(stored()?.legsWithheld).toBe(true);

    // The feed never polls a terminal record, so this verdict is final.
    const getStatus = vi.fn(() => Promise.resolve(null));
    await refreshLocalSwaps(TEST_ACCOUNT, getStatus, () => true);
    expect(getStatus).not.toHaveBeenCalled();
    cleanup();

    const record = stored();
    if (!record) throw new Error("expected the captured record");
    await renderTrade(
      <ActivityFeed
        activities={[record]}
        isLoading={false}
        error={null}
        hasMore={false}
        isConnected
        connectedWallet={TEST_ACCOUNT}
        needsSignIn
        isSigningIn={false}
        onSignIn={noop}
        onRefresh={noop}
        onLoadMore={noop}
      />,
      { connected: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle activity" }));
    fireEvent.click(document.querySelector(".activity-row") as HTMLElement);
    expect(screen.getByRole("button", { name: LINKS_SIGN_IN_LABEL })).not.toBeNull();
  });

  it("clears a stored verdict when the flow poll reads the owner view", async () => {
    await renderTrade(<FlowProbe initial={intentAt("settling", true)} />, { connected: true });
    expect(stored()?.legsWithheld).toBe(true);

    act(() => setIntent(intentAt("completed", false)));
    expect(stored()?.legsWithheld).toBe(false);
  });

  it("leaves the feed's own verdict alone before the flow poll has read one", async () => {
    await renderTrade(<FlowProbe initial={intentAt("settling", true)} />, { connected: true });
    act(() => setIntent(intentAt("bridging", null)));
    expect(stored()?.legsWithheld).toBe(true);
  });
});

/** A `failed` intent as `useIntent` reports it, ending on `phase`. */
const failedAt = (phase: "failed" | "may-have-moved"): UseIntentReturn => {
  const intent = intentAt("failed", null);
  return { ...intent, receipt: { ...intent.receipt, phase } };
};

// The machine keeps no failure substatus, only its verdict, and the feed never
// polls a terminal record, so the capture write is where a failed row's retry
// is decided.
describe("the flow capture carries the machine's failure verdict", () => {
  it("records a nothing-moved failure as not_executed", async () => {
    await renderTrade(<FlowProbe initial={intentAt("settling", null)} />, { connected: true });
    act(() => setIntent(failedAt("failed")));
    expect(stored()?.intentStatus).toBe("failed");
    expect(stored()?.data.substatus).toBe("not_executed");
  });

  it("records no marker on a failure that may have moved funds", async () => {
    await renderTrade(<FlowProbe initial={intentAt("settling", null)} />, { connected: true });
    act(() => setIntent(failedAt("may-have-moved")));
    expect(stored()?.intentStatus).toBe("failed");
    expect(stored()?.data.substatus ?? null).toBeNull();
  });
});
