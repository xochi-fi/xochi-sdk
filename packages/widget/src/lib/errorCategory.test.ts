import { describe, it, expect } from "vitest";
import { AMOUNT_TOO_SMALL_TITLE, getErrorInfo, isAmountTooSmall } from "./errorCategory.js";

// Unauthorized / misconfiguration must be its own category, never folded into
// the user-cancellation ("rejected") bucket. A Riddler 401 (missing/invalid
// RIDDLER_API_TOKEN) is a server-side issue; labelling it "Transaction
// cancelled" hides the real cause. See issue #124.
describe("errorCategory: unauthorized is distinct from cancellation", () => {
  it("maps a 401 code to the auth category, not rejected", () => {
    const info = getErrorInfo({ message: "", code: 401 });
    expect(info.category).toBe("auth");
    expect(info.message).not.toBe("Transaction cancelled");
    expect(info.canRetry).toBe(true);
  });

  it("maps a can_solve:false unauthorized reason to auth", () => {
    const info = getErrorInfo("unauthorized: Authentication required");
    expect(info.category).toBe("auth");
    expect(info.message).toBe("Authorization failed");
    expect(info.message).not.toBe("Transaction cancelled");
  });

  it("maps an HTTP 401 thrown by the execute path to auth", () => {
    expect(getErrorInfo("HTTP 401: Invalid or expired token").category).toBe("auth");
  });

  it("still maps a genuine user cancellation to the rejected bucket", () => {
    const info = getErrorInfo("User rejected the request");
    expect(info.category).toBe("rejected");
    expect(info.message).toBe("Transaction cancelled");
  });

  it("attaches the auth glyph via getErrorInfo", () => {
    expect(getErrorInfo({ message: "nope", code: 401 }).category).toBe("auth");
    expect(getErrorInfo("unauthorized: Authentication required").art).toBe("[=]");
  });
});

describe("errorCategory: transport failures never reach the copy", () => {
  it("keeps the network copy for a browser fetch failure without a code", () => {
    for (const message of ["Failed to fetch", "Load failed"]) {
      const info = getErrorInfo({ message });
      expect(info.category).toBe("network");
      expect(info.message).not.toContain(message);
    }
  });
});

describe("errorCategory: structured 503 bodies retain their specific transient cause", () => {
  it("uses pricing copy only for the conversion_unavailable body marker", () => {
    const info = getErrorInfo({
      code: 503,
      message:
        'HTTP 503: {"success":false,"error_category":"conversion_unavailable","error":"A current price could not be verified","detail":"oracle response was stale"}',
    });
    expect(info).toMatchObject({
      message: "Pricing temporarily unavailable",
      suggestion: "We couldn't verify a current price for this trade. Try again shortly.",
      canRetry: true,
      category: "unavail",
    });
  });

  it("uses solver-timeout copy only for the exact request-timeout detail", () => {
    const info = getErrorInfo({
      code: 503,
      message:
        'HTTP 503: {"success":false,"error":"Solver temporarily unavailable","detail":"request timed out"}',
    });
    expect(info).toMatchObject({
      message: "Solver response timed out",
      suggestion: "The solver took too long to respond. Try again shortly.",
      canRetry: true,
      category: "unavail",
    });
  });

  it("keeps generic 503 copy for malformed, non-JSON, or unrecognized bodies", () => {
    for (const message of [
      "HTTP 503: Solver temporarily unavailable",
      'HTTP 503: {"error_category":"conversion_unavailable"',
      'HTTP 503: {"error_category":"other","detail":"request timed out eventually"}',
      'HTTP 503: ["conversion_unavailable"]',
    ]) {
      expect(getErrorInfo({ code: 503, message }).message).toBe("Temporarily busy");
    }
  });
});

// A solver liquidity decline must surface its real cause, not collapse to the
// generic "Transaction cancelled" (user-cancellation copy) or a misleading
// "Insufficient balance" that blames the user's wallet. The raw execute reason
// "insufficient liquidity" (see worker-lib execute-decision) and a decline whose
// wording includes "cancelled" both used to be mis-bucketed. See
// feedback-surface-solver-errors.
describe("errorCategory: liquidity decline is distinct from cancellation/balance", () => {
  it("maps 'insufficient liquidity' to the liquidity cause, not a wallet-balance error", () => {
    const info = getErrorInfo("insufficient liquidity");
    expect(info.category).toBe("liquidity");
    expect(info.message).not.toBe("Insufficient balance");
    expect(info.message).not.toBe("Transaction cancelled");
  });

  it("keeps a transient liquidity decline retryable (solver refills, 'retry shortly')", () => {
    const info = getErrorInfo(
      "insufficient_liquidity: solver has insufficient USDC liquidity on chain 8453 to fill this route; try a smaller amount or retry shortly",
    );
    expect(info.category).toBe("liquidity");
    expect(info.canRetry).toBe(true);
  });

  it("does not collapse a cancelled-for-no-liquidity decline to the cancellation copy", () => {
    const info = getErrorInfo("order cancelled: no liquidity to fill this route");
    expect(info.message).not.toBe("Transaction cancelled");
    expect(info.category).toBe("liquidity");
  });

  it("still maps a real wallet shortfall to the funds bucket", () => {
    const info = getErrorInfo("insufficient funds for gas");
    expect(info.category).toBe("funds");
    expect(info.message).toBe("Insufficient balance");
  });

  it("still maps a genuine user cancellation to the rejected bucket", () => {
    const info = getErrorInfo("User rejected the request");
    expect(info.category).toBe("rejected");
    expect(info.message).toBe("Transaction cancelled");
  });
});

// A token-resolution decline (`unsupported_origin_token` /
// `unsupported_destination_token`) fires when Riddler can't match the token
// bytes to its registry on a route the user could still pick -- the route IS on
// the supported matrix. It must NOT render the terminal "Route not supported
// yet" copy (which strips retry); it's a transient backend mismatch. A genuinely
// unsupported route (`unsupported_chain`, `same_chain_unsupported`) keeps the
// terminal copy. See issue #282. `validation_failed` used to be in that list and
// no longer is: it is a request-shape rejection, not a route verdict (#372).
describe("errorCategory: token-resolution decline is distinct from unsupported route", () => {
  it("keeps an origin-token resolution decline retryable, not 'Route not supported yet'", () => {
    const info = getErrorInfo(
      "unsupported_origin_token: origin token has no gasless pull path (ERC-3009/Permit2)",
    );
    expect(info.message).not.toBe("Route not supported");
    expect(info.canRetry).toBe(true);
  });

  it("keeps a destination-token resolution decline retryable", () => {
    const info = getErrorInfo(
      "unsupported_destination_token: destination token is not fillable on the destination chain",
    );
    expect(info.message).not.toBe("Route not supported");
    expect(info.canRetry).toBe(true);
  });

  it("still maps a genuinely unsupported chain route to the terminal copy", () => {
    const info = getErrorInfo("unsupported_chain: unsupported route 1 -> 999");
    expect(info.message).toBe("Route not supported");
    expect(info.canRetry).toBe(false);
  });

  it("does NOT blame the route for a validation_failed request-shape rejection", () => {
    const info = getErrorInfo("validation_failed: bad request shape");
    expect(info.message).not.toBe("Route not supported");
    expect(info.category).not.toBe("liquidity");
    expect(info.canRetry).toBe(false);
  });
});

// A `validation_failed` (422) means the solver rejected the request SHAPE. It
// used to render "Route not supported yet" plus the supported-token list, which
// told a user on a perfectly good corridor to go change their tokens. The worker
// now folds Riddler's per-field `details` into the reason, so the offending
// property reaches the user instead of being dropped. See issue #372.
describe("errorCategory: validation_failed names the field, not the route", () => {
  it("surfaces the offending property rather than the supported-token list", () => {
    const info = getErrorInfo("validation_failed: signature: should be 130 character(s)");
    expect(info.message).toBe("Couldn't submit this trade");
    expect(info.suggestion).toContain("signature: should be 130 character(s)");
    expect(info.suggestion).not.toContain("you can only send");
    expect(info.canRetry).toBe(false);
  });

  it("strips Riddler's generic message prefix so the field reads cleanly", () => {
    const info = getErrorInfo("validation_failed: Request validation failed: signature");
    expect(info.suggestion).toContain("signature");
    expect(info.suggestion).not.toMatch(/request validation failed/i);
  });

  it("falls back to plain copy when the reason carries no detail", () => {
    const info = getErrorInfo("validation_failed");
    expect(info.message).toBe("Couldn't submit this trade");
    expect(info.suggestion).toBe(
      "The solver couldn't accept this request. Check the values sent and try again.",
    );
  });

  // The quote path serves `classifyDecline` prose, not the raw reason, so the
  // categorizer has to recognise it with no machine code present. Matching only
  // the code let the prose fall through to the "rejected" (user-cancellation)
  // branch. Composition is covered in decline.compose.test.ts; this pins the
  // categorizer's half so the branch is not narrowed back to the code alone.
  it("recognises the served prose, which carries no machine code", () => {
    const info = getErrorInfo(
      "The solver could not accept this request. Check the values sent and try again.",
    );
    expect(info.message).toBe("Couldn't submit this trade");
    expect(info.canRetry).toBe(false);
    expect(info.category).not.toBe("rejected");
  });

  it("still renders the route verdict for a genuinely unsupported pair", () => {
    const info = getErrorInfo("same_chain_unsupported: same-chain swaps are not supported");
    expect(info.message).toBe("Route not supported");
    expect(info.category).toBe("liquidity");
  });

  // A rejection naming the `quote_id` field contains the substring "quote", so
  // it would fall into the loose "quote"/"expired" branch and render a retryable
  // "Quote expired" -- wrong cause, and it invites a retry that fails the same
  // way. Same hazard the 503 branch documents. The field list only reaches the
  // string because the worker now folds `details` in, so this test pins the
  // ordering that keeps it honest.
  it("is not hijacked into 'Quote expired' by a quote_id field name", () => {
    const info = getErrorInfo("validation_failed: quote_id: does not match intent");
    expect(info.message).toBe("Couldn't submit this trade");
    expect(info.category).not.toBe("expired");
    expect(info.canRetry).toBe(false);
  });

  // The sanitize cap (100 chars) truncates a long multi-field rejection. The
  // code sits at the front so it survives, but the tail can be cut mid-field --
  // including into a substring that a later branch would claim.
  it("survives truncation at the sanitize cap without changing category", () => {
    const truncated =
      "validation_failed: deadline: must be in the future; nonce: can't be blank; quote_id: does not mat...";
    expect(truncated.length).toBeLessThanOrEqual(100);
    const info = getErrorInfo(truncated);
    expect(info.message).toBe("Couldn't submit this trade");
    expect(info.category).toBe("generic");
    expect(info.canRetry).toBe(false);
  });
});

// An over-cap order must show the real per-transaction limit, not a generic
// "quote failed" or the misleading "Amount too small" bucket. See issue #289.
describe("errorCategory: above-maximum surfaces the cap and is terminal", () => {
  it("preserves the cap in the title and does not offer retry", () => {
    const info = getErrorInfo(
      "Amount above the maximum for this trade. The most you can send in one trade is $600. Try a smaller amount.",
    );
    expect(info.category).toBe("funds");
    expect(info.message).toContain("$600");
    expect(info.canRetry).toBe(false);
    // The trailing action moves to the suggestion, not the title.
    expect(info.message).not.toMatch(/try a smaller amount/i);
    expect(info.suggestion).toBe("Try a smaller amount.");
  });

  it("does not fall through to the 'Amount too small' bucket", () => {
    const info = getErrorInfo("Amount above the maximum for this trade. Try a smaller amount.");
    expect(info.message).not.toBe("Amount too small");
    expect(info.category).toBe("funds");
    expect(info.canRetry).toBe(false);
  });
});

// The fixed-cost decline is the only place the user is told what the route
// actually costs and the exact amount that would clear it. Collapsing that to a
// generic "Try a larger amount" throws away the number they need.
describe("errorCategory: below-minimum keeps the actionable amount", () => {
  it("preserves the cost and the suggested amount from the server", () => {
    const info = getErrorInfo(
      "Amount too small for this route. Sending to this chain costs about $10.07 no matter how much you send, so most of a small amount is used up. Send at least $41, or pick a different destination chain.",
    );
    expect(info.category).toBe("funds");
    expect(info.canRetry).toBe(false);
    expect(info.message).toBe("Amount too small");
    // The numbers survive into the suggestion.
    expect(info.suggestion).toContain("$10.07");
    expect(info.suggestion).toContain("$41");
    // The headline is not simply repeated in the detail.
    expect(info.suggestion).not.toMatch(/^amount too small for this route/i);
  });

  it("still handles a bare below-minimum reason with no amount", () => {
    const info = getErrorInfo("Amount below the minimum fill.");
    expect(info.message).toBe("Amount too small");
    expect(info.suggestion).toBeTruthy();
    expect(info.canRetry).toBe(false);
  });
});

// The panel attaches a cause to this decline: a one-tap destination change to
// Ethereum can turn a working quote into a refusal, and the refusal arrives
// looking unrelated to the tap. The predicate has to be true exactly when the
// panel is showing "Amount too small", never on a neighbouring decline, or the
// explanation lands beside an error it does not explain.
describe("errorCategory: isAmountTooSmall tracks the rendered verdict", () => {
  it("is true for the fixed-cost decline the worker serves", () => {
    expect(
      isAmountTooSmall(
        "Amount too small for this route. Sending to this chain costs about $0.22 no matter how much you send, so most of a small amount is used up. Send at least $15, or pick a different destination chain.",
      ),
    ).toBe(true);
  });

  it("is true for the solver's own below-the-floor decline", () => {
    expect(isAmountTooSmall("Amount below the minimum fill. Try a larger amount.")).toBe(true);
  });

  it("is false for the declines that sit next to it in the categorizer", () => {
    // "above the maximum" and the liquidity branch both match ahead of the
    // below-minimum branch and both carry wording a naive substring test trips on.
    expect(isAmountTooSmall("Amount above the maximum for this trade. Try a smaller amount.")).toBe(
      false,
    );
    expect(isAmountTooSmall("No route to fill this trade right now.")).toBe(false);
    expect(isAmountTooSmall("Insufficient balance for this trade")).toBe(false);
  });

  it("is false when there is no error at all", () => {
    expect(isAmountTooSmall(null)).toBe(false);
    expect(isAmountTooSmall("")).toBe(false);
  });

  it("reads a structured error's message, not just a bare string", () => {
    expect(isAmountTooSmall({ message: "Amount below the minimum fill." })).toBe(true);
  });

  it("agrees with the title the panel renders, off one source", () => {
    const message = "Amount below the minimum fill. Try a larger amount.";
    expect(getErrorInfo(message).message).toBe(AMOUNT_TOO_SMALL_TITLE);
    expect(isAmountTooSmall(message)).toBe(true);
  });
});

// Riddler's execute error taxonomy (execute_error.ex, #703) persists a stable
// "code: message" and auto-refunds a confirmed settlement failure. The ONLY
// non-retryable, fund-sensitive case is in-doubt (`pull_in_doubt`), which tells
// the client "do not resubmit". Copy must honor that and must NOT invite a retry
// that could double-outlay. The clean, refunding failures keep their retry via
// the liquidity / service-unavailable branches. (xochi#321 Action 2.)
describe("errorCategory: in-doubt settlement is non-retryable, clean failures retry", () => {
  it("maps an in-doubt pull to a cautious, non-retryable message (do not resubmit)", () => {
    const info = getErrorInfo(
      "pull_failed: Origin pull could not be confirmed and is being verified -- do not resubmit this intent; request a new quote to retry",
    );
    expect(info.message).toBe("Still finishing this swap");
    expect(info.canRetry).toBe(false);
    // Must not fall through to "Quote expired" on the "request a new quote" wording.
    expect(info.message).not.toBe("Quote expired");
    expect(info.suggestion).toContain("don't resubmit");
  });

  // Fund-safety ordering: an in-doubt reason that ALSO mentions "liquidity" must
  // win over the (retryable) liquidity branch, never inherit its retry
  // affordance and invite a double outlay. Regression for the branch order.
  it("keeps in-doubt non-retryable even when the reason also says 'liquidity'", () => {
    const info = getErrorInfo(
      "pull_failed: insufficient liquidity to confirm the fill -- do not resubmit this intent",
    );
    expect(info.message).toBe("Still finishing this swap");
    expect(info.canRetry).toBe(false);
    expect(info.category).not.toBe("liquidity");
  });

  // Prose-drift tolerance: Riddler may refine the exact wording. The classifier
  // must still catch the in-doubt marker across spelling variants, so a copy
  // tweak can never silently flip this fund-sensitive case to retryable.
  it("catches in-doubt across prose variants (don't / re-submit)", () => {
    for (const marker of [
      "please don't resubmit this intent",
      "do not re-submit this intent",
      "don't re-submit -- verifying on-chain",
    ]) {
      const info = getErrorInfo(`pull_failed: ${marker}`);
      expect(info.canRetry, marker).toBe(false);
      expect(info.message, marker).toBe("Still finishing this swap");
    }
  });

  it("keeps a transient pull_failed retryable (funds not moved, 'temporarily unavailable')", () => {
    const info = getErrorInfo(
      "pull_failed: Origin pull temporarily unavailable -- request a new quote to retry",
    );
    expect(info.canRetry).toBe(true);
    expect(info.message).not.toBe("Still finishing this swap");
  });

  it("keeps a service_unavailable settlement failure retryable (auto-refunded, requote)", () => {
    const info = getErrorInfo(
      "service_unavailable: Settlement temporarily unavailable: could not reserve a transaction slot -- request a new quote to retry",
    );
    expect(info.canRetry).toBe(true);
    expect(info.category).toBe("unavail");
  });

  it("keeps a cross-token settlement shortfall retryable via the liquidity branch", () => {
    const info = getErrorInfo(
      "insufficient_liquidity: Solver could not source the destination token for this cross-token route -- request a new quote to retry",
    );
    expect(info.category).toBe("liquidity");
    expect(info.canRetry).toBe(true);
  });
});
