import { describe, it, expect } from "vitest";
import { planResume, selectPayoutSource, shouldCaptureToActivity } from "./resumeSwap.js";
import { toActivityStatus } from "../../lib/localActivity.js";
import type { SwapActivityItem } from "../../types/activity.js";
import type { IntentStatus } from "../../types/intent.js";

// Base (8453) USDC -> Arbitrum (42161) USDC, the corridor the #339 incident ran on.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TRON = 728126428;
const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function makeRecord(overrides: Partial<SwapActivityItem["data"]> = {}): SwapActivityItem {
  const status: IntentStatus = "settling";
  return {
    id: "xi_abc123",
    type: "swap",
    timestamp: 1_800_000_000_000,
    status: toActivityStatus(status),
    intentStatus: status,
    data: {
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: USDC_BASE,
      toToken: USDC_ARB,
      fromAmount: "5000000",
      toAmount: "4989000",
      tier: "Standard",
      feeRate: 0.22,
      txHash: null,
      isCrossChain: true,
      ...overrides,
    },
  };
}

describe("planResume (#339)", () => {
  it("rebuilds the panel legs from a persisted record", () => {
    const plan = planResume(makeRecord());
    expect(plan).not.toBeNull();
    expect(plan?.intentId).toBe("xi_abc123");
    expect(plan?.status).toBe("settling");
    expect(plan?.fromChainId).toBe(8453);
    expect(plan?.toChainId).toBe(42161);
    expect(plan?.fromToken.symbol).toBe("USDC");
    expect(plan?.toToken.symbol).toBe("USDC");
  });

  // The flow modal reads amounts from the PANEL, not the intent. Without this
  // the real status renders over whatever pair the form defaults to, which is a
  // worse lie than showing nothing.
  it("formats the origin amount for the panel input", () => {
    expect(planResume(makeRecord())?.amount).toBe("5");
  });

  it("restores DAI and EURe using canonical chain-specific metadata", () => {
    const dai = planResume(
      makeRecord({
        fromChainId: 1,
        fromToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        fromAmount: "25000000000000000000",
      }),
    );
    expect(dai?.fromToken.symbol).toBe("DAI");
    expect(dai?.fromToken.decimals).toBe(18);
    expect(dai?.amount).toBe("25");

    const eure = planResume(
      makeRecord({
        toChainId: 1,
        toToken: "0x39b8B6385416f4cA36a20319F70D28621895279D",
      }),
    );
    expect(eure?.toToken.symbol).toBe("EURe");
    expect(eure?.toToken.decimals).toBe(18);
  });

  it("does not restore a known token address on the wrong chain", () => {
    expect(planResume(makeRecord({ fromToken: USDC_ARB }))).toBeNull();
  });

  // A resumed intent carries no quote (the served one is gone and is never
  // synthesized), so this is the only source for the modal's "you receive".
  it("carries the served payout captured at submit time", () => {
    expect(planResume(makeRecord())?.toAmount).toBe("4989000");
  });

  it("tolerates a record with no captured payout", () => {
    expect(planResume(makeRecord({ toAmount: null }))?.toAmount).toBeNull();
  });

  // A user ten minutes into a settling swap must not be told they just started.
  it("carries the original submit time for the elapsed counter", () => {
    expect(planResume(makeRecord())?.startedAt).toBe(1_800_000_000_000);
  });

  // The modal's ending describes the dispatched order, and after a reload the
  // live toggle is back on Public, so the record is the only source.
  it("carries the dispatched destination, stealth or public", () => {
    expect(planResume(makeRecord({ settlementType: "stealth" }))?.destination.type).toBe("stealth");
    expect(planResume(makeRecord({ settlementType: "public" }))?.destination.type).toBe("chain");
  });

  it("reads a record with no settlement marker as public", () => {
    expect(planResume(makeRecord())?.destination.type).toBe("chain");
  });

  it("returns null for a missing record", () => {
    expect(planResume(null)).toBeNull();
    expect(planResume(undefined)).toBeNull();
  });

  // Both Tron legs now resume. This USED to refuse them, which was the whole
  // gap: the panel's chain state is already SelectableChainId, and refusing here
  // meant the one flow that must survive losing the tab (a deposit route, where
  // the user has to leave the browser to send at all) could never be rebuilt.
  //
  // The token lookup is the load-bearing half. `getTokenInfoByAddress` lowercases
  // and destroys base58, so a Tron leg used to resolve to a truncated-address
  // "symbol" that matched no token and took the unresolvable-leg refusal below
  // even after the chain check passed.
  it("rebuilds a Tron DESTINATION leg (live corridor)", () => {
    const plan = planResume(makeRecord({ toChainId: TRON, toToken: USDT_TRON }));
    expect(plan).not.toBeNull();
    expect(plan?.toChainId).toBe(TRON);
    expect(plan?.toToken.symbol).toBe("USDT");
    // Wrong decimals here would misformat every amount on the resumed screen.
    expect(plan?.toToken.decimals).toBe(6);
  });

  it("rebuilds a Tron ORIGIN leg (deposit route)", () => {
    const plan = planResume(
      makeRecord({ fromChainId: TRON, fromToken: USDT_TRON, fromAmount: "50000000" }),
    );
    expect(plan).not.toBeNull();
    expect(plan?.fromChainId).toBe(TRON);
    expect(plan?.fromToken.symbol).toBe("USDT");
    expect(plan?.amount).toBe("50");
  });

  // Base58 is case-sensitive, so a case-folded lookup must not accidentally
  // resolve: that would name a different token than the one that was traded.
  it("does not resolve a case-folded Tron address", () => {
    expect(
      planResume(makeRecord({ fromChainId: TRON, fromToken: USDT_TRON.toLowerCase() })),
    ).toBeNull();
  });

  it("refuses a token that no longer resolves on its chain", () => {
    expect(
      planResume(makeRecord({ fromToken: "0x000000000000000000000000000000000000dEaD" })),
    ).toBeNull();
  });

  // A malformed stored amount must not throw on mount and take the panel down.
  // An empty input is survivable; the status still renders.
  it("degrades to an empty amount rather than throwing on a malformed value", () => {
    const plan = planResume(makeRecord({ fromAmount: "not-a-number" }));
    expect(plan).not.toBeNull();
    expect(plan?.amount).toBe("");
    expect(plan?.intentId).toBe("xi_abc123");
  });
});

// The fabricated-payout guard. Every regression here has been a MISSING CASE,
// not wrong arithmetic: #389 rendered "You receive 0" beside a decline, and
// adversarial review of #398 found two more ways a real number could appear
// beside a trade it did not belong to. Each case gets its own assertion.
describe("selectPayoutSource (#339, #389)", () => {
  const RESUMED = { intentId: "xi_resumed", toAmount: "4989000" };

  it("prefers a live solvable quote", () => {
    expect(selectPayoutSource({ canSolve: true, toAmount: "123" }, RESUMED, "xi_resumed")).toBe(
      "123",
    );
  });

  // #389: mapQuoteResponse defaults an absent to_amount to "0", so reading it
  // directly renders a fabricated "You receive 0" next to the decline notice.
  it("shows nothing for a declined quote", () => {
    expect(selectPayoutSource({ canSolve: false, toAmount: "0" }, null, "xi_a")).toBeNull();
  });

  // The specific trap: a decline must NOT fall through to the resumed payout,
  // which would show the resumed swap's number beside the decline.
  it("does not fall through from a decline to a resumed payout", () => {
    expect(
      selectPayoutSource({ canSolve: false, toAmount: "0" }, RESUMED, "xi_resumed"),
    ).toBeNull();
  });

  it("uses the resumed payout when there is no quote at all", () => {
    expect(selectPayoutSource(null, RESUMED, "xi_resumed")).toBe("4989000");
  });

  // The keying that stops a stale figure outliving its swap. After a reset the
  // intent id clears, so the resumed payout must stop applying with no explicit
  // cleanup call -- missing one such call is what produced the defect.
  it("stops applying once the intent is reset", () => {
    expect(selectPayoutSource(null, RESUMED, null)).toBeNull();
  });

  it("does not apply to a DIFFERENT intent", () => {
    expect(selectPayoutSource(null, RESUMED, "xi_other")).toBeNull();
  });

  it("shows nothing when nothing is known", () => {
    expect(selectPayoutSource(null, null, null)).toBeNull();
    expect(selectPayoutSource(null, { intentId: "xi_a", toAmount: null }, "xi_a")).toBeNull();
  });
});

// A resumed intent must not write to the activity log: the capture write sources
// toAmount/feeRate from the live quote (a resumed intent has none) and
// upsertLocalSwap replaces the nested data block wholesale, so it would destroy
// the served payout in the record it was just restored from.
describe("shouldCaptureToActivity (#339)", () => {
  const base = {
    hasOwner: true,
    hasIntentId: true,
    isCapturedStatus: true,
    isResumedIntent: false,
  };

  it("captures an ordinary dispatched swap", () => {
    expect(shouldCaptureToActivity(base)).toBe(true);
  });

  it("never captures a resumed intent", () => {
    expect(shouldCaptureToActivity({ ...base, isResumedIntent: true })).toBe(false);
  });

  it("still requires an owner, an id and a captured status", () => {
    expect(shouldCaptureToActivity({ ...base, hasOwner: false })).toBe(false);
    expect(shouldCaptureToActivity({ ...base, hasIntentId: false })).toBe(false);
    expect(shouldCaptureToActivity({ ...base, isCapturedStatus: false })).toBe(false);
  });
});

/**
 * The deposit facts, which are the reason resuming a deposit swap is worth
 * doing at all.
 *
 * A deposit route is the one flow whose completion REQUIRES leaving the browser:
 * the user reads an address and sends TRC-20 from a Tron wallet, and a mobile OS
 * evicts the backgrounded tab routinely. No quote is ever synthesized on resume
 * (a fabricated price shown as current would be a lie), so without these the
 * modal reopens at `awaiting_deposit` with no address, no window, and no way to
 * finish or abandon the swap.
 *
 * These four are already-displayed, solver-issued facts, so carrying them across
 * fabricates nothing.
 */
describe("planResume deposit facts", () => {
  // The persisted shape is the SIGNED binding plus its signature, not loose
  // display fields, so that what a resumed screen shows and what
  // `verifyStoredDeposit` proves are the same object. `planResume` itself does
  // no crypto: it is pure and sync, and the proof runs at the boundary in
  // useSwapPanel before the block is ever handed to the modal.
  const DEPOSIT = {
    attested: {
      intent_id: "xi_abc123",
      quote_id: "xq_dep",
      wallet: "0x1111111111111111111111111111111111111111",
      from_chain_id: TRON,
      from_token: USDT_TRON,
      from_amount: "50000000",
      deposit_address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
      deposit_deadline: 1_800_001_800,
      refund_address: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
      to_chain_id: 8453,
      to_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      to_amount: "49890000",
      min_to_amount: "49640000",
      recipient: "0x1111111111111111111111111111111111111111",
      stealth_spending_pub_key: null,
      stealth_viewing_pub_key: null,
      settlement_preference: "public",
    },
    attestation: `0x${"ab".repeat(65)}`,
  } satisfies SwapActivityItem["data"]["deposit"];

  const depositRecord = () =>
    makeRecord({
      fromChainId: TRON,
      fromToken: USDT_TRON,
      fromAmount: "50000000",
      deposit: DEPOSIT,
    });

  it("carries the whole signed binding across the resume", () => {
    expect(planResume(depositRecord())?.deposit).toEqual(DEPOSIT);
  });

  // The address is verbatim base58 and MUST NOT be normalised anywhere on this
  // path: a case-folded Tron address is a different, still-plausible address,
  // and this is the one the user is about to send real funds to.
  it("keeps the deposit address byte-for-byte", () => {
    expect(planResume(depositRecord())?.deposit?.attested.deposit_address).toBe(
      DEPOSIT.attested.deposit_address,
    );
  });

  // The signature has to survive, or the binding cannot be re-proven and the
  // resumed screen falls back to showing no address at all.
  it("carries the signature, without which nothing can be re-proven", () => {
    expect(planResume(depositRecord())?.deposit?.attestation).toBe(DEPOSIT.attestation);
  });

  // A pull route has no deposit block, and must not acquire one.
  it("is null on an ordinary EVM pull route", () => {
    expect(planResume(makeRecord())?.deposit).toBeNull();
  });

  // Records written before this shipped have no `deposit` key at all. They must
  // resume as far as they can rather than refuse.
  it("degrades to null for a record written before deposits were persisted", () => {
    const plan = planResume(makeRecord({ fromChainId: TRON, fromToken: USDT_TRON }));
    expect(plan).not.toBeNull();
    expect(plan?.deposit).toBeNull();
  });
});
