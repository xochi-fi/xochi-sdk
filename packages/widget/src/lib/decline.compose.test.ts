/**
 * Composed path: worker prose -> browser categorizer.
 *
 * `decline.ts`'s module header states the invariant this file enforces:
 *
 *   "Messages deliberately preserve the keyword substrings the frontend
 *    categorizer (`src/lib/errorCategory.ts`) matches on"
 *
 * Nothing executed it. Both modules were tested in isolation, each fed input the
 * OTHER never sends: `errorCategory.test.ts` feeds raw `validation_failed:`
 * reasons, but on the QUOTE path the worker replaces the raw reason with
 * `classifyDecline` prose and serves that as `error` (see
 * `handlers/intents/quote.ts`); `detail` carries the raw reason and no frontend
 * code reads it. So the string the browser actually categorizes is the prose.
 *
 * That gap shipped a real defect: the `invalid_request` copy read "The solver
 * rejected this request...", and "rejected" matches the user-cancellation branch
 * roughly 70 lines before the request-shape branch. A malformed request rendered
 * "Transaction cancelled" with a Retry button that reproduced the same decline.
 *
 * These tests run every `classifyDecline` message through `getErrorInfo` (over
 * `@xochi/client`'s `classifyFailure`), with and without the `errorCategory`
 * served beside it, which is the composition production performs, and assert
 * the user-visible outcome. A copy edit on either side that breaks the pairing
 * fails here.
 */
import { describe, it, expect } from "vitest";
import { settlementFallback } from "@xochi/client";
import { classifyDecline, type DeclineCategory } from "@xochi/client";
import { getErrorInfo } from "./errorCategory.js";

/**
 * One representative raw solver reason per decline category, matching the wire
 * shapes Riddler actually emits (see `@quote_rejection_messages` in
 * `error_response.ex` and `readRiddlerError` in `worker-lib/src/riddler.ts`).
 */
const RAW_REASONS: { reason: string; category: DeclineCategory; label: string }[] = [
  {
    label: "malformed request (the #372 case)",
    reason: "validation_failed: signature: should be 130 character(s)",
    category: "invalid_request",
  },
  {
    label: "unsupported chain pair",
    reason: "unsupported_chain: unsupported route 1 -> 999",
    category: "route_unsupported",
  },
  {
    label: "cross-token pair",
    reason: "token_mismatch: Requested token pair is not supported",
    category: "route_unsupported",
  },
  {
    label: "over the per-transaction cap",
    reason: "amount_above_maximum: Order amount exceeds the supported maximum",
    category: "amount_too_large",
  },
  {
    label: "below the gas floor",
    reason: "unprofitable: Order too small to fill profitably at current gas costs",
    category: "amount_too_small",
  },
  {
    label: "solver inventory",
    reason: "insufficient_liquidity: solver inventory is temporarily insufficient",
    category: "no_liquidity",
  },
  {
    label: "missing solver token",
    reason: "unauthorized: Authentication required",
    category: "auth",
  },
];

describe("classifyDecline -> getErrorInfo (the composition production runs)", () => {
  // The specific regression. Named on its own so a failure reads as the defect
  // rather than as one row of a table.
  it("does not tell the user they cancelled a trade the solver refused", () => {
    const decline = classifyDecline("validation_failed: signature: should be 130 character(s)");
    const ui = getErrorInfo(decline.message);

    expect(decline.category).toBe("invalid_request");
    expect(ui.message).not.toBe("Transaction cancelled");
    expect(ui.category).not.toBe("rejected");
  });

  // Retrying a malformed request reproduces the identical decline, so offering
  // the button is worse than offering nothing: it is a loop with no exit.
  it("does not offer a Retry that deterministically fails again", () => {
    const decline = classifyDecline("validation_failed: signature: should be 130 character(s)");
    expect(getErrorInfo(decline.message).canRetry).toBe(false);
  });

  // The quote path's prose carries no machine code, so the categorizer has to
  // recognise it by wording alone. This is the pairing that must not drift.
  it("routes the served prose to the request-shape branch, not the fallback", () => {
    const decline = classifyDecline("validation_failed: nonce: can't be blank");
    const ui = getErrorInfo(decline.message);
    expect(ui.message).toBe("Couldn't submit this trade");
    // Not the generic passthrough, which would echo the sentence back as a title.
    expect(ui.message).not.toBe(decline.message);
  });

  // Every category, not just the one that broke: no decline may render as a
  // user cancellation, and none may fall through to the raw-echo fallback.
  it.each(RAW_REASONS)("$label never renders as a cancellation", ({ reason, category }) => {
    const decline = classifyDecline(reason);
    expect(decline.category).toBe(category);

    const ui = getErrorInfo(decline.message);
    expect(ui.category).not.toBe("rejected");
    expect(ui.message).not.toBe("Transaction cancelled");
    // The fallback echoes the input verbatim as the title. Hitting it means the
    // categorizer had no branch for this prose.
    expect(ui.message).not.toBe(decline.message);
  });

  // The panel passes the served `errorCategory` with the prose; the prose-only
  // readers (the minimum guidance) do not. Both must show the same thing.
  it.each(RAW_REASONS)("$label reads the same with its category", ({ reason }) => {
    const decline = classifyDecline(reason);
    const withCategory = getErrorInfo(decline.message, undefined, decline.category);
    const proseOnly = getErrorInfo(decline.message);
    expect(withCategory.message).toBe(proseOnly.message);
    expect(withCategory.canRetry).toBe(proseOnly.canRetry);
  });

  // A pair decline already says what to pick instead. The generic route copy
  // ("only USDC ... to a different chain") is wrong for both: the user may be
  // sending USDC already, and some same-chain pairs are live.
  it.each([
    "token_mismatch: Requested token pair is not supported",
    "same_chain_unsupported: same-chain swaps are not supported",
  ])("keeps the served advice for %s", (reason) => {
    const decline = classifyDecline(reason);
    const ui = getErrorInfo(decline.message, undefined, decline.category);
    expect(ui.message).toBe("Pair not supported");
    expect(ui.suggestion).toContain("Pick a different pair");
    expect(ui.suggestion).not.toMatch(/^That pair is not supported/);
    expect(ui.canRetry).toBe(false);
  });

  // The quote path serves this sentence, never the raw stealth-field reason,
  // and a stealth-field rejection is exactly where switching to Public fills.
  it("offers Public for a stealth-field rejection served as prose", () => {
    const served = classifyDecline("validation_failed: stealth_viewing_pub_key: can't be blank");
    expect(
      settlementFallback({
        settlement: "stealth",
        status: "failed",
        error: served.message,
        errorCategory: served.category,
      }),
    ).toBe("request_rejected");
  });

  // A decline the user cannot act on must not invite a retry; one they CAN act
  // on must keep it. Pinning both directions stops a future copy edit from
  // silently flipping either.
  it.each([
    { label: "malformed request", reason: "validation_failed: quote_id: is invalid", retry: false },
    { label: "unsupported route", reason: "unsupported_chain: 1 -> 999", retry: false },
    {
      label: "transient inventory",
      reason: "insufficient_liquidity: temporarily insufficient",
      retry: true,
    },
  ])("$label offers retry: $retry", ({ reason, retry }) => {
    const decline = classifyDecline(reason);
    expect(getErrorInfo(decline.message).canRetry).toBe(retry);
  });

  // A genuine quote expiry is recoverable by re-quoting, and the request-shape
  // branch sits ahead of the expiry branch. Riddler spells it as a validation
  // failure naming the `quote` field, so the guard has to let it through.
  it("keeps a genuinely expired quote retryable", () => {
    const ui = getErrorInfo("validation_failed: quote: quote expired");
    expect(ui.message).toBe("Quote expired");
    expect(ui.canRetry).toBe(true);
  });

  // ...while a rejection naming the `quote_id` FIELD still must not be read as
  // an expiry (the ordering bug the original fix was written for).
  it("still does not mistake a quote_id field name for an expiry", () => {
    const ui = getErrorInfo("validation_failed: quote_id: does not match intent");
    expect(ui.message).toBe("Couldn't submit this trade");
    expect(ui.canRetry).toBe(false);
  });
});
