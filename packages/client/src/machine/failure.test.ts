import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  isSettlementAvailable,
  settlementFallback,
  settlementRefusalReason,
} from "./failure.js";
import type { StructuredError } from "./state.js";

const kind = (error: string | StructuredError, category?: string) =>
  classifyFailure(error, category).kind;

/**
 * The Worker's `classifyDecline` sentences (xochi packages/shared decline.ts),
 * served as the quote path's `error`: what the browser actually reads.
 */
const SERVED = {
  invalidRequest: "The solver could not accept this request. Check the values sent and try again.",
  pairCrossChain:
    "That pair is not supported between these chains. Some coins can't move to another chain as the same coin, and not every coin swaps for every other. Pick a different pair.",
  pairSameChain:
    "That pair is not supported as a same-chain trade. Only some pairs trade on a single chain. Pick a different pair, or receive on another chain.",
  routeUnsupported: "Route not supported. Send USDC, USDT or USDG to a different chain.",
};

describe("classifyFailure: the server's credential is not the user's cancellation", () => {
  it("reads a 401 code, a can_solve:false reason and an execute throw as auth", () => {
    expect(kind({ message: "HTTP 401: Unauthorized", code: 401 })).toBe("auth");
    expect(kind("unauthorized: Authentication required")).toBe("auth");
    expect(kind("HTTP 401: invalid token")).toBe("auth");
  });

  it("still reads a wallet refusal as the user's", () => {
    const f = classifyFailure("User rejected the request.");
    expect(f.kind).toBe("wallet_rejected");
    expect(f.retryable).toBe(true);
  });
});

describe("classifyFailure: in-doubt funds are never retryable", () => {
  it("reads the do-not-resubmit marker across its prose variants", () => {
    for (const reason of [
      "pull_failed: settlement in doubt, do not resubmit this intent",
      "Settlement pending verification. Don't resubmit.",
      "funds may have moved; do not re-submit",
    ]) {
      const f = classifyFailure(reason);
      expect(f).toEqual({ kind: "in_doubt", retryable: false });
    }
  });

  it("wins over the retryable liquidity and expiry wordings it can carry", () => {
    expect(kind("insufficient liquidity during settlement; do not resubmit")).toBe("in_doubt");
    expect(kind("quote expired mid-pull, do not resubmit, request a new quote later")).toBe(
      "in_doubt",
    );
  });

  it("leaves the clean, auto-refunded failures retryable", () => {
    expect(classifyFailure("pull_failed: Solver temporarily unavailable").retryable).toBe(true);
    expect(classifyFailure("service_unavailable: settlement failed, refunded").retryable).toBe(
      true,
    );
  });
});

describe("classifyFailure: the solver's inventory is not the user's balance or intent", () => {
  it("reads liquidity ahead of funds and cancellation", () => {
    expect(kind("insufficient liquidity")).toBe("no_liquidity");
    expect(kind("order cancelled: no liquidity for this route")).toBe("no_liquidity");
    expect(classifyFailure("insufficient_liquidity: retry shortly").retryable).toBe(true);
  });

  it("still reads a wallet shortfall as funds, final", () => {
    expect(classifyFailure("insufficient funds for gas")).toEqual({
      kind: "insufficient_funds",
      retryable: false,
    });
  });
});

describe("classifyFailure: transport failures", () => {
  it("reads every engine's fetch failure as network, coded or not", () => {
    expect(kind("Failed to fetch")).toBe("network");
    expect(kind("Load failed")).toBe("network");
    expect(kind("NetworkError when attempting to fetch resource.")).toBe("network");
    expect(kind({ message: "Failed to fetch" })).toBe("network");
  });
});

describe("classifyFailure: HTTP codes", () => {
  it("keys a coded error off its status, not its message", () => {
    expect(kind({ message: "HTTP 429: slow down", code: 429 })).toBe("rate_limited");
    expect(classifyFailure({ message: "HTTP 404: gone", code: 404 })).toEqual({
      kind: "http",
      status: 404,
      retryable: false,
    });
    expect(classifyFailure({ message: "HTTP 500", code: 500 }).retryable).toBe(true);
    expect(classifyFailure({ message: "HTTP 400: bad", code: 400 }).retryable).toBe(false);
  });

  it("reads a 503 body's precise transient cause, else plain busy", () => {
    const body = (b: unknown) => ({ message: `HTTP 503: ${JSON.stringify(b)}`, code: 503 });
    expect(kind(body({ error_category: "conversion_unavailable" }))).toBe("pricing_unavailable");
    expect(kind(body({ detail: "request timed out" }))).toBe("solver_timeout");
    expect(kind(body({ detail: "request timed out later" }))).toBe("busy");
    expect(kind(body([1]))).toBe("busy");
    expect(kind({ message: "HTTP 503: <html>", code: 503 })).toBe("busy");
    expect(kind({ message: "conversion_unavailable", code: 503 })).toBe("busy");
  });
});

describe("classifyFailure: the request's shape is not the route", () => {
  it("names the field a raw execute reason carries, minus Riddler's prefix", () => {
    expect(classifyFailure("validation_failed: signature: should be 130 character(s)")).toEqual({
      kind: "request_rejected",
      field: "signature: should be 130 character(s)",
      retryable: false,
    });
    expect(classifyFailure("validation_failed: Request validation failed: nonce: blank")).toEqual(
      expect.objectContaining({ field: "nonce: blank" }),
    );
    expect(classifyFailure("validation_failed")).toEqual(expect.objectContaining({ field: null }));
  });

  it("reads the quote path's served prose, which carries no code", () => {
    expect(classifyFailure(SERVED.invalidRequest)).toEqual({
      kind: "request_rejected",
      field: null,
      retryable: false,
    });
  });

  it("is not read as an expiry because a field is named quote_id", () => {
    expect(kind("validation_failed: quote_id: does not match intent")).toBe("request_rejected");
  });

  it("lets a real expiry, spelled as a validation failure, stay retryable", () => {
    expect(classifyFailure("validation_failed: quote: quote expired")).toEqual({
      kind: "quote_expired",
      retryable: true,
    });
  });

  it("is not hijacked by the 503 body's quote_id", () => {
    expect(kind('Solver temporarily unavailable {"quote_id":"q1"}')).toBe("busy");
  });
});

describe("classifyFailure: routes and pairs", () => {
  it("keeps a token-resolution lag retryable, not a dead route", () => {
    expect(classifyFailure("unsupported_origin_token: 0xabc")).toEqual({
      kind: "token_unresolved",
      retryable: true,
    });
    expect(kind("unsupported_destination_token")).toBe("token_unresolved");
  });

  it("keeps the Worker's pair advice instead of the generic route verdict", () => {
    expect(classifyFailure(SERVED.pairCrossChain)).toEqual({
      kind: "pair_unsupported",
      advice:
        "Some coins can't move to another chain as the same coin, and not every coin swaps for every other. Pick a different pair.",
      retryable: false,
    });
    expect(classifyFailure(SERVED.pairSameChain)).toEqual(
      expect.objectContaining({
        kind: "pair_unsupported",
        advice:
          "Only some pairs trade on a single chain. Pick a different pair, or receive on another chain.",
      }),
    );
  });

  it("reads a genuinely unsupported route as final", () => {
    expect(classifyFailure(SERVED.routeUnsupported)).toEqual({
      kind: "route_unsupported",
      retryable: false,
    });
  });
});

describe("classifyFailure: order size", () => {
  it("keeps the served cap, minus the advice the kind implies", () => {
    expect(
      classifyFailure("Order is above the maximum of $600 for this route. Try a smaller amount."),
    ).toEqual({
      kind: "amount_too_large",
      limit: "Order is above the maximum of $600 for this route.",
      retryable: false,
    });
  });

  it("keeps the served minimum advice, minus its restated headline", () => {
    expect(
      classifyFailure(
        "Amount too small for this route. This route costs $2.10. Send at least $41.",
      ),
    ).toEqual({
      kind: "amount_too_small",
      advice: "This route costs $2.10. Send at least $41.",
      retryable: false,
    });
    expect(classifyFailure("unprofitable")).toEqual(
      expect.objectContaining({ advice: "unprofitable" }),
    );
    expect(classifyFailure("Amount too small.")).toEqual(expect.objectContaining({ advice: null }));
  });
});

describe("classifyFailure: the declined quote's category wins over its prose", () => {
  it("maps each documented category", () => {
    for (const c of [
      "gas_floor_unpriced",
      "inventory_unverified",
      "quote_holds_exhausted",
      "idempotency_key_in_flight",
      "idempotency_unavailable",
    ]) {
      expect(classifyFailure("anything", c)).toEqual({ kind: "busy", retryable: true });
    }
    expect(kind("x", "conversion_unavailable")).toBe("pricing_unavailable");
    expect(kind("x", "no_liquidity")).toBe("no_liquidity");
    expect(kind("x", "auth")).toBe("auth");
    expect(kind("x", "settlement_type_unavailable")).toBe("settlement_unavailable");
    expect(kind(SERVED.invalidRequest, "invalid_request")).toBe("request_rejected");
    expect(kind(SERVED.routeUnsupported, "route_unsupported")).toBe("route_unsupported");
    expect(kind(SERVED.pairSameChain, "route_unsupported")).toBe("pair_unsupported");
  });

  it("does not let prose that reads as cancellation override the category", () => {
    expect(kind("The solver rejected this request.", "invalid_request")).toBe("request_rejected");
  });

  it("treats an unknown category as a final decline, per the contract", () => {
    expect(classifyFailure("Your order is not possible", "origin_pull_amount_mismatch")).toEqual({
      kind: "declined",
      message: "Your order is not possible",
      retryable: false,
    });
    expect(kind("x", "constructor")).toBe("declined");
  });

  it("reads `unknown`'s prose, and keeps unrecognized prose final", () => {
    expect(kind("Solver temporarily unavailable", "unknown")).toBe("busy");
    expect(classifyFailure("gibberish", "unknown")).toEqual({
      kind: "declined",
      message: "gibberish",
      retryable: false,
    });
  });
});

describe("classifyFailure: the remainder", () => {
  it("reads slippage, rate and verification, and passes the rest through verbatim", () => {
    expect(kind("slippage exceeded")).toBe("slippage");
    expect(kind("too many requests")).toBe("rate_limited");
    expect(kind("verification unavailable")).toBe("verification_unavailable");
    const long = "x".repeat(300);
    expect(classifyFailure(long)).toEqual({ kind: "unrecognized", message: long, retryable: true });
  });
});

describe("isSettlementAvailable / settlementRefusalReason", () => {
  const options = [
    { type: "public" as const, available: true },
    { type: "stealth" as const, available: false, reason: "  Not on this chain.  " },
    { type: "shielded" as const, available: false, reason: "  " },
  ];

  it("answers only for a mode the solver reported on", () => {
    expect(isSettlementAvailable(options, "public")).toBe(true);
    expect(isSettlementAvailable(options, "stealth")).toBe(false);
    expect(isSettlementAvailable([], "stealth")).toBeUndefined();
    expect(isSettlementAvailable(undefined, "stealth")).toBeUndefined();
    expect(isSettlementAvailable([options[0]], "stealth")).toBeUndefined();
  });

  it("gives the served reason only for an explicitly unavailable mode", () => {
    expect(settlementRefusalReason(options, "stealth")).toBe("Not on this chain.");
    expect(settlementRefusalReason(options, "public")).toBeNull();
    expect(settlementRefusalReason(options, "shielded")).toBeNull();
    expect(settlementRefusalReason(undefined, "stealth")).toBeNull();
  });
});

describe("settlementFallback", () => {
  const failedStealth = (error: string | StructuredError | null, errorCategory?: string) =>
    settlementFallback({ settlement: "stealth", status: "failed", error, errorCategory });

  it("offers Public on a stealth-field rejection, raw or served", () => {
    expect(failedStealth("validation_failed: stealth_spending_pub_key: can't be blank")).toBe(
      "request_rejected",
    );
    expect(failedStealth(SERVED.invalidRequest)).toBe("request_rejected");
  });

  it("offers Public on a route verdict, whatever its HTTP code", () => {
    expect(failedStealth(SERVED.routeUnsupported)).toBe("route_unsupported");
    expect(failedStealth({ message: "HTTP 400: not supported", code: 400 })).toBe(
      "route_unsupported",
    );
    expect(failedStealth("declined", "settlement_type_unavailable")).toBe("route_unsupported");
  });

  it("offers nothing for an expiry, an unrelated failure, or no failure", () => {
    expect(failedStealth("validation_failed: quote: quote expired")).toBeNull();
    expect(failedStealth("insufficient liquidity")).toBeNull();
    expect(failedStealth("Solver temporarily unavailable")).toBeNull();
    expect(failedStealth(null)).toBeNull();
  });

  it("offers nothing on Public, or before the trade has failed", () => {
    expect(
      settlementFallback({
        settlement: "public",
        status: "failed",
        error: SERVED.routeUnsupported,
      }),
    ).toBeNull();
    expect(
      settlementFallback({
        settlement: "stealth",
        status: "quoted",
        error: "validation_failed: stealth_spending_pub_key: can't be blank",
      }),
    ).toBeNull();
  });
});
