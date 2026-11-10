// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { PICK_DIFFERENT_PAIR, classifyDecline, supportedOriginSentence } from "./decline.js";
import { SOLVER_ORIGIN_TOKENS } from "./solver-support.js";

describe("supportedOriginSentence", () => {
  it("lists the current origin set", () => {
    expect(supportedOriginSentence(["USDC", "USDT", "USDG"])).toBe(
      "Send USDC, USDT and USDG to a different chain.",
    );
  });

  it("defaults to the static solver origin set", () => {
    expect(supportedOriginSentence()).toContain(SOLVER_ORIGIN_TOKENS[0]);
  });
});

describe("classifyDecline", () => {
  it("normalizes an unsupported-route reject and keeps the origin guidance", () => {
    const info = classifyDecline("unsupported_chain: pair not enabled", ["USDC", "USDT", "USDG"]);
    expect(info.category).toBe("route_unsupported");
    expect(info.message).toBe(
      "Route not supported. Send USDC, USDT and USDG to a different chain.",
    );
    // Preserves the substring the frontend categorizer matches on.
    expect(info.message.toLowerCase()).toContain("not supported");
  });

  // A schema rejection is not a route verdict. It used to answer a malformed
  // request with "Route not supported. Send USDC, USDT or USDG to a different
  // chain.", telling the caller to change tokens that were never the problem.
  // The offending field rides along in the response `detail`. See xochi#372.
  it("gives a validation_failed its own category, not route_unsupported", () => {
    const info = classifyDecline("validation_failed: signature: should be 130 character(s)", [
      "USDC",
      "USDT",
      "USDG",
    ]);
    expect(info.category).toBe("invalid_request");
    expect(info.message.toLowerCase()).not.toContain("not supported");
    expect(info.message).not.toContain("USDC");
  });

  // token_mismatch covers both a cross-token pair the solver does not offer and
  // a same-token route for a coin it cannot move between chains at par (ZCHF,
  // EURe). The old copy told the ZCHF user to "send that coin", i.e. exactly
  // what they were doing (xochi#673).
  it("normalizes a token_mismatch reject without blaming a coin change", () => {
    const info = classifyDecline(
      "token_mismatch: Requested token pair is not supported on this route",
      ["USDC", "USDT", "USDG"],
    );
    expect(info.category).toBe("route_unsupported");
    expect(info.message.toLowerCase()).not.toContain("keep the same coin");
    expect(info.message.toLowerCase()).not.toContain("send that coin");
    expect(info.message).not.toContain(supportedOriginSentence(["USDC", "USDT", "USDG"]));
    expect(info.message).toContain(PICK_DIFFERENT_PAIR);
    // Keeps the substring the frontend categorizer matches on.
    expect(info.message.toLowerCase()).toContain("not supported");
  });

  // Same-chain trades are live for allowlisted pairs, so this decline must not
  // say same-chain is unsupported, and must not fall into the generic branch
  // that tells the user to send USDC to a different chain (xochi#673).
  it("gives same_chain_unsupported its own copy, not the generic route one", () => {
    const info = classifyDecline("same_chain_unsupported: Same-chain swaps are not supported", [
      "USDC",
      "USDT",
      "USDG",
    ]);
    expect(info.category).toBe("route_unsupported");
    expect(info.message).not.toContain(supportedOriginSentence(["USDC", "USDT", "USDG"]));
    expect(info.message.toLowerCase()).not.toContain("same-chain swaps are not supported");
    expect(info.message.toLowerCase()).not.toContain("public");
    expect(info.message).toContain(PICK_DIFFERENT_PAIR);
    expect(info.message.toLowerCase()).toContain("not supported");
  });

  it("normalizes a below-minimum reject", () => {
    for (const reason of ["unprofitable", "amount below min fill", "order too small"]) {
      const info = classifyDecline(reason);
      expect(info.category).toBe("amount_too_small");
      expect(info.message.toLowerCase()).toContain("minimum");
    }
  });

  it("folds the live gas floor into a below-minimum reject (#754)", () => {
    const info = classifyDecline("unprofitable", undefined, undefined, 1.05);
    expect(info.category).toBe("amount_too_small");
    expect(info.message).toContain("$1.05");
    // Preserves the substring the frontend categorizer matches on.
    expect(info.message.toLowerCase()).toContain("minimum");
    // "minimum" must not fall through to the "too large" branch.
    expect(info.category).not.toBe("amount_too_large");
  });

  it("normalizes a below-minimum reject without a floor number", () => {
    const info = classifyDecline("unprofitable", undefined, undefined);
    expect(info.category).toBe("amount_too_small");
    expect(info.message.toLowerCase()).toContain("minimum");
    expect(info.message).not.toContain("$");
  });

  it("normalizes an above-maximum reject and folds in the exact cap", () => {
    const info = classifyDecline(
      "amount_above_maximum: Order amount exceeds the supported maximum",
      undefined,
      600,
    );
    expect(info.category).toBe("amount_too_large");
    expect(info.message).toContain("$600");
    // Preserves the substring the frontend categorizer matches on.
    expect(info.message.toLowerCase()).toContain("above the maximum");
    // "maximum" must not fall through to the "too small" branch.
    expect(info.category).not.toBe("amount_too_small");
  });

  it("formats a four-figure cap with a thousands separator", () => {
    const info = classifyDecline("amount_above_maximum", undefined, 2000);
    expect(info.message).toContain("$2,000");
  });

  it("normalizes an above-maximum reject without a cap number", () => {
    const info = classifyDecline("amount_above_maximum", undefined);
    expect(info.category).toBe("amount_too_large");
    expect(info.message.toLowerCase()).toContain("above the maximum");
    expect(info.message).not.toContain("$");
  });

  it("normalizes a no-liquidity reject", () => {
    const info = classifyDecline("no route found for this pair");
    expect(info.category).toBe("no_liquidity");
    expect(info.message.toLowerCase()).toContain("no route");
  });

  it("folds the currently available solver inventory into a no-liquidity reject", () => {
    const info = classifyDecline("insufficient_liquidity", undefined, 73.25);
    expect(info.category).toBe("no_liquidity");
    expect(info.message).toContain("$73.25");
    expect(info.message.toLowerCase()).toContain("liquidity");
  });

  it("normalizes an upstream auth failure before route matching", () => {
    const info = classifyDecline("unauthorized: Authentication required");
    expect(info.category).toBe("auth");
    expect(info.message.toLowerCase()).toContain("authentication required");
  });

  it("bounds an unrecognized reason and collapses whitespace", () => {
    const long = "weird\n\nreason ".repeat(40);
    const info = classifyDecline(long);
    expect(info.category).toBe("unknown");
    expect(info.message.length).toBeLessThanOrEqual(123); // 120 + "..."
    expect(info.message).not.toContain("\n");
  });

  it("returns a generic sentence for an empty reason", () => {
    expect(classifyDecline("").category).toBe("unknown");
    expect(classifyDecline("   ").message).toBe("This trade could not be quoted.");
  });
});
