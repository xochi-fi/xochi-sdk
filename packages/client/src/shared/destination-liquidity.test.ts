// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { thinDestinationWarning } from "./destination-liquidity.js";
import { TRON_CHAIN_ID } from "./chains.js";

describe("thinDestinationWarning", () => {
  it("flags USDC on Tron and steers to USDT", () => {
    const w = thinDestinationWarning(TRON_CHAIN_ID, "USDC");
    expect(w).not.toBeNull();
    expect(w!.preferred).toBe("USDT");
    expect(w!.action).toContain("USDT");
  });

  it("does not flag the destination people actually use", () => {
    expect(thinDestinationWarning(TRON_CHAIN_ID, "USDT")).toBeNull();
  });

  it("does not flag USDC on chains where it is healthy", () => {
    for (const chainId of [1, 10, 137, 8453, 42161]) {
      expect(thinDestinationWarning(chainId, "USDC")).toBeNull();
    }
  });

  it("is null-safe for an unresolved chain or token", () => {
    expect(thinDestinationWarning(undefined, "USDC")).toBeNull();
    expect(thinDestinationWarning(TRON_CHAIN_ID, undefined)).toBeNull();
    expect(thinDestinationWarning(TRON_CHAIN_ID, "")).toBeNull();
  });

  // The warning exists to be understood by someone who does not know what a
  // stablecoin issuer is. Keep it concrete and jargon-free.
  it("keeps the copy plain and free of em-dashes", () => {
    const w = thinDestinationWarning(TRON_CHAIN_ID, "USDC")!;
    for (const text of [w.headline, w.detail, w.action]) {
      expect(text).not.toMatch(/--|—/);
    }
    expect(w.detail).not.toMatch(/liquidity|TRC-20|bridge|depeg|on-chain/i);
    // States the consequence to the recipient, not just an abstract statistic.
    expect(w.detail.toLowerCase()).toContain("spend");
  });
});
