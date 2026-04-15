/**
 * Proof recency utility tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isProofRecent, assertProofRecent, DEFAULT_MAX_PROOF_AGE } from "../src/recency.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isProofRecent", () => {
  it("returns true for a recent proof", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isProofRecent(now - 100)).toBe(true);
  });

  it("returns false for a stale proof", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isProofRecent(now - 7200)).toBe(false);
  });

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
  it("does not throw for a recent proof", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => assertProofRecent(now - 100)).not.toThrow();
  });

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
});

describe("DEFAULT_MAX_PROOF_AGE", () => {
  it("is 3600 seconds (1 hour)", () => {
    expect(DEFAULT_MAX_PROOF_AGE).toBe(3600);
  });
});
