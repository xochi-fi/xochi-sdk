/**
 * Proof recency utility tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isProofRecent,
  assertProofRecent,
  chainProofTimestamp,
  ChainAheadOfClockError,
  DEFAULT_MAX_PROOF_AGE,
} from "../src/recency.js";
import { startScriptedBlockRpc } from "./scripted-block-rpc.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isProofRecent", () => {
  it("returns true at exactly the boundary", () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(isProofRecent(now - DEFAULT_MAX_PROOF_AGE)).toBe(true);
  });

  it("returns false one second past boundary", () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(isProofRecent(now - DEFAULT_MAX_PROOF_AGE - 1)).toBe(false);
  });

  it("respects custom maxAgeSeconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isProofRecent(now - 50, 60)).toBe(true);
    expect(isProofRecent(now - 120, 60)).toBe(false);
  });
});

describe("assertProofRecent", () => {
  it("throws for a stale proof with details", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => assertProofRecent(now - 7200)).toThrow("Proof is too old");
    expect(() => assertProofRecent(now - 7200)).toThrow("max 3600s");
  });

  it("respects custom maxAgeSeconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => assertProofRecent(now - 50, 60)).not.toThrow();
    expect(() => assertProofRecent(now - 120, 60)).toThrow("max 60s");
  });

  it("rejects future, millisecond and non-integer timestamps like the Oracle", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isProofRecent(now + 86_400)).toBe(false);
    expect(() => assertProofRecent(now + 86_400)).toThrow("is in the future");
    // Date.now() is milliseconds: 1000x "now", so it reads as far future.
    expect(isProofRecent(Date.now())).toBe(false);
    expect(() => assertProofRecent(Number.NaN)).toThrow("must be a non-negative integer");
    expect(() => assertProofRecent(now - 0.5)).toThrow("must be a non-negative integer");
  });

  it("measures against an explicit reference time (e.g. the chain's block time)", () => {
    const chainNow = 1_700_000_000;
    expect(() => assertProofRecent(chainNow - 3600, 3600, chainNow)).not.toThrow();
    expect(() => assertProofRecent(chainNow - 3601, 3600, chainNow)).toThrow("Proof is too old");
    expect(() => assertProofRecent(chainNow + 1, 3600, chainNow)).toThrow("is in the future");
    expect(isProofRecent(chainNow, 3600, chainNow)).toBe(true);
    expect(() => assertProofRecent(chainNow, 3600, Number.NaN)).toThrow("Reference time");
  });
});

describe("chainProofTimestamp", () => {
  it("returns the latest block's timestamp when it trails the local clock", async () => {
    const latest = BigInt(Math.floor(Date.now() / 1000) - 100);
    const rpc = await startScriptedBlockRpc([latest]);
    try {
      expect(await chainProofTimestamp(rpc.client)).toBe(String(latest));
    } finally {
      await rpc.close();
    }
  });

  it("caps a head less than MAX_PROOF_AGE ahead at the local clock", async () => {
    const before = Math.floor(Date.now() / 1000);
    const rpc = await startScriptedBlockRpc([BigInt(before + DEFAULT_MAX_PROOF_AGE / 2)]);
    try {
      const stamp = Number(await chainProofTimestamp(rpc.client));
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    } finally {
      await rpc.close();
    }
  });

  it("throws ChainAheadOfClockError for a head more than MAX_PROOF_AGE ahead", async () => {
    const latest = BigInt(Math.floor(Date.now() / 1000) + 2 * DEFAULT_MAX_PROOF_AGE);
    const rpc = await startScriptedBlockRpc([latest]);
    try {
      const err: unknown = await chainProofTimestamp(rpc.client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChainAheadOfClockError);
      const { latestBlockTimestamp, localTimestamp, message } = err as ChainAheadOfClockError;
      expect(latestBlockTimestamp).toBe(latest);
      expect(latestBlockTimestamp - localTimestamp).toBeGreaterThan(BigInt(DEFAULT_MAX_PROOF_AGE));
      expect(message).toMatch(/pass an explicit timestamp/);
    } finally {
      await rpc.close();
    }
  });
});

describe("DEFAULT_MAX_PROOF_AGE", () => {
  it("is 3600 seconds (1 hour)", () => {
    expect(DEFAULT_MAX_PROOF_AGE).toBe(3600);
  });
});
