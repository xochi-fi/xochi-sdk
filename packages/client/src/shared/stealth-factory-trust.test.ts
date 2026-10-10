/**
 * Stealth SimpleAccountFactory trust anchor.
 *
 * The client FOLLOWS the solver-advertised factory rather than its own pin
 * (#302), because if the two derive against different factories they compute
 * different counterfactual addresses and the recipient cannot find the payout.
 *
 * That is correct for parity and says nothing about trust. The factory decides
 * who owns the account the money lands in, so an advertised factory that
 * deploys an account owned by someone else is theft both sides agree on. These
 * pin the allowlist that bounds what may be followed.
 */

import { describe, it, expect } from "vitest";
import {
  SIMPLE_ACCOUNT_FACTORY,
  STEALTH_ACCOUNT_SALT,
  TRUSTED_STEALTH_FACTORIES,
  isTrustedStealthFactory,
} from "./stealth.js";

const ATTACKER_FACTORY = "0xAbC0000000000000000000000000000000000123";

/** Stealth is pinned to Ethereum L1; it is the only chain with a listed factory. */
const MAINNET = 1;
/** A supported chain that lists no stealth factory. */
const BASE = 8453;

describe("isTrustedStealthFactory", () => {
  it("accepts the shipped factory", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, MAINNET)).toBe(true);
  });

  // EVM addresses compare case-insensitively, and the capability matrix
  // preserves whatever casing the solver sent, so a checksum difference must not
  // read as a different factory.
  it("compares case-insensitively", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY.toLowerCase(), MAINNET)).toBe(true);
    expect(
      isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY.toUpperCase().replace("0X", "0x"), MAINNET),
    ).toBe(true);
  });

  it("refuses a factory this build does not ship", () => {
    expect(isTrustedStealthFactory(ATTACKER_FACTORY, MAINNET)).toBe(false);
  });

  // Absent must never read as trusted: an unset field is the case an attacker
  // gets for free by omitting one.
  it("refuses absent or empty input", () => {
    expect(isTrustedStealthFactory(undefined, MAINNET)).toBe(false);
    expect(isTrustedStealthFactory(null, MAINNET)).toBe(false);
    expect(isTrustedStealthFactory("", MAINNET)).toBe(false);
  });

  it("keeps the shipped factory in the allowlist for L1", () => {
    expect(TRUSTED_STEALTH_FACTORIES[MAINNET]).toContain(SIMPLE_ACCOUNT_FACTORY);
  });

  // A factory is authorization for ONE chain. A flat list would let a factory
  // legitimate on L1 stand in as approval on any chain stealth later reaches.
  it("does not accept the L1 factory on a chain that lists none", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, BASE)).toBe(false);
    expect(TRUSTED_STEALTH_FACTORIES[BASE]).toBeUndefined();
  });

  it("refuses an absent chain id", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, undefined)).toBe(false);
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, null)).toBe(false);
  });

  // Rotation is staged by shipping both factories, letting the solver flip, then
  // dropping the old one. Every entry must still be a well-formed address.
  it("holds only well-formed addresses", () => {
    for (const list of Object.values(TRUSTED_STEALTH_FACTORIES)) {
      for (const f of list) expect(f).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe("STEALTH_ACCOUNT_SALT", () => {
  it("is 0: one account per stealth EOA", () => {
    expect(STEALTH_ACCOUNT_SALT).toBe(0);
  });
});
