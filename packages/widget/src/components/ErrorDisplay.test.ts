import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorDisplay, computeRemaining } from "./ErrorDisplay.js";
import type { StructuredError } from "@xochi/client";

// Render the real component to static markup (no jsdom / effects needed) and
// check that quote rejections retain their distinct failure categories.
const html = (error: string): string =>
  renderToStaticMarkup(createElement(ErrorDisplay, { error }));

// Structured (code-carrying) variant with a retry handler so the Retry button
// renders. computeRemaining seeds the countdown synchronously, so the initial
// static markup already reflects it (no effect needed).
const htmlStructured = (error: StructuredError): string =>
  renderToStaticMarkup(createElement(ErrorDisplay, { error, onRetry: () => {} }));

describe("ErrorDisplay quote-rejection messaging", () => {
  it("distinguishes an unsupported chain route from a fill failure", () => {
    const out = html("unsupported_chain: unsupported route 1 -> 999");
    expect(out).toContain("Route not supported");
    expect(out).not.toContain("Couldn't fill this trade");
  });

  // A `validation_failed` is a request-SHAPE rejection, so the supported-token
  // list is the wrong advice: it tells a user on a working corridor to change
  // tokens they never needed to change. Show the field the solver named. #372.
  it("does not offer the token list for a validation_failed request-shape error", () => {
    const out = html("validation_failed: signature: should be 130 character(s)");
    expect(out).not.toContain("Route not supported");
    expect(out).toContain("should be 130 character(s)");
  });

  it("maps an unprofitable / below-minimum reason to amount-too-small", () => {
    expect(html("unprofitable: amount below minimum fill")).toContain("Amount too small");
  });

  it("still maps a genuine liquidity reason to a fill-failure message", () => {
    expect(html("no route found for this pair")).toContain("fill this trade");
  });

  it("passes an unrecognized reason through as generic copy", () => {
    expect(html("teapot refused to brew coffee")).toContain("teapot refused to brew coffee");
  });

  // A transient solver 503 (saturation / gas-oracle unavailable). The raw string
  // the quote path throws carries a `quote_id`, which used to hijack this into
  // "Quote expired"; it must read as a retryable, plain-language busy state.
  it("maps a transient 503 (with quote_id in the body) to a busy retry, not quote-expired", () => {
    const raw =
      'HTTP 503: {"success":false,"intent_id":"x","quote_id":"q","can_solve":false,"error":"Solver temporarily unavailable"}';
    const out = html(raw);
    expect(out).toContain("Temporarily busy");
    expect(out).toContain("Try again");
    expect(out).not.toContain("Quote expired");
    // No internal jargon leaks to the user.
    expect(out).not.toContain("Solver");
  });
});

// computeRemaining backs both ErrorDisplay's and SwapResult's countdown. It maps
// an ABSOLUTE unix-seconds target to the seconds left (or null when absent/past).
describe("computeRemaining", () => {
  it("returns null when no retryAfter is given", () => {
    expect(computeRemaining(undefined)).toBeNull();
  });

  it("returns seconds remaining for a future target", () => {
    const remaining = computeRemaining(Math.floor(Date.now() / 1000) + 5);
    expect(remaining).toBeGreaterThanOrEqual(4);
    expect(remaining).toBeLessThanOrEqual(5);
  });

  it("returns null for a target already in the past", () => {
    expect(computeRemaining(Math.floor(Date.now() / 1000) - 5)).toBeNull();
  });
});

// A structured backpressure error (429/503 with retryAfter) must render the
// categorizeByCode copy, a live "Retry in Ns" countdown, and a DISABLED Retry
// button so the user cannot hammer a saturated/limited backend.
describe("ErrorDisplay backpressure countdown", () => {
  it("renders code-503 copy, a countdown, and a disabled Retry while waiting", () => {
    const out = htmlStructured({
      message: "HTTP 503: Solver temporarily unavailable",
      code: 503,
      retryAfter: Math.floor(Date.now() / 1000) + 5,
    });
    // categorizeByCode(503) copy, NOT the raw "HTTP 503:" transport string.
    expect(out).toContain("Temporarily busy");
    expect(out).not.toContain("HTTP 503");
    expect(out).toMatch(/Retry in \d+s/);
    expect(out).toContain("disabled");
  });

  it("shows pricing-specific copy for a structured conversion_unavailable 503 and keeps the countdown", () => {
    const out = htmlStructured({
      message:
        'HTTP 503: {"success":false,"error_category":"conversion_unavailable","error":"A current price could not be verified","detail":"oracle response was stale"}',
      code: 503,
      retryAfter: Math.floor(Date.now() / 1000) + 5,
    });
    expect(out).toContain("Pricing temporarily unavailable");
    expect(out).toContain(
      "We couldn&#x27;t verify a current price for this trade. Try again shortly.",
    );
    expect(out).not.toContain("Temporarily busy");
    expect(out).not.toContain("liquidity");
    expect(out).toMatch(/Retry in \d+s/);
    expect(out).toContain("disabled");
  });

  it("shows solver-timeout copy for a structured request-timeout 503 and keeps the countdown", () => {
    const out = htmlStructured({
      message:
        'HTTP 503: {"success":false,"error":"Solver temporarily unavailable","detail":"request timed out"}',
      code: 503,
      retryAfter: Math.floor(Date.now() / 1000) + 5,
    });
    expect(out).toContain("Solver response timed out");
    expect(out).toContain("The solver took too long to respond. Try again shortly.");
    expect(out).not.toContain("Temporarily busy");
    expect(out).not.toContain("Connection problem");
    expect(out).not.toContain("liquidity");
    expect(out).toMatch(/Retry in \d+s/);
    expect(out).toContain("disabled");
  });

  it("renders code-429 copy and disables Retry while the countdown is active", () => {
    const out = htmlStructured({
      message: "HTTP 429: Rate limit exceeded",
      code: 429,
      retryAfter: Math.floor(Date.now() / 1000) + 20,
    });
    expect(out).toContain("Too many requests");
    expect(out).toMatch(/Retry in \d+s/);
    expect(out).toContain("disabled");
  });

  it("keeps Retry enabled for a code error without a retryAfter", () => {
    const out = htmlStructured({
      message: "HTTP 503: Solver temporarily unavailable",
      code: 503,
    });
    expect(out).toContain("Temporarily busy");
    expect(out).not.toMatch(/Retry in \d+s/);
    expect(out).not.toContain("disabled");
  });
});

describe("ErrorDisplay tag lookup failures", () => {
  it("uses the category instead of generic 503 copy or duplicate upstream detail", () => {
    const out = htmlStructured({
      message: "We can't look up @memory-rocky right now. Please try again.",
      code: 503,
      errorCategory: "tag_resolution_unavailable",
      reason: "upstream private detail",
      retryAfter: Math.floor(Date.now() / 1000) + 30,
    });
    expect(out).toContain("We can&#x27;t look up @memory-rocky right now. Please try again.");
    expect(out).toContain("Retry lookup");
    expect(out).not.toMatch(/Temporarily busy|upstream private detail|Retry in|disabled/);
    expect(out.match(/look up @memory-rocky/g)).toHaveLength(1);
  });
});
