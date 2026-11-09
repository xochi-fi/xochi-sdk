/**
 * Stealth SimpleAccountFactory trust anchor: pins the allowlist that bounds
 * which advertised factory may be followed (see `TRUSTED_STEALTH_FACTORIES`).
 */

import { describe, it, expect } from "vitest";
import {
  advertisedConversionPairs,
  SIMPLE_ACCOUNT_FACTORY,
  STEALTH_ACCOUNT_SALT,
  TRUSTED_STEALTH_FACTORIES,
  effectiveStealthChains,
  isTrustedStealthFactory,
  parseCapabilities,
  stealthFactoryFor,
  trustedStealthChains,
} from "../index.js";

const ATTACKER_FACTORY = "0xAbC0000000000000000000000000000000000123";

/** Chains whose shipped allowlist trusts the same factory. */
const MAINNET = 1;
const BASE = 8453;
/** A supported chain that lists no stealth factory. */
const UNTRUSTED_CHAIN = 10;

describe("isTrustedStealthFactory", () => {
  it("accepts the shipped factory on Ethereum and Base", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, MAINNET)).toBe(true);
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, BASE)).toBe(true);
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

  it("keeps the shipped factory in the allowlist for Ethereum and Base", () => {
    expect(TRUSTED_STEALTH_FACTORIES[MAINNET]).toContain(SIMPLE_ACCOUNT_FACTORY);
    expect(TRUSTED_STEALTH_FACTORIES[BASE]).toContain(SIMPLE_ACCOUNT_FACTORY);
  });

  // A factory is authorization for ONE chain. A flat list would let a factory
  // legitimate on Ethereum or Base stand in as approval on any other chain.
  it("rejects cross-chain factory reuse on a chain that lists none", () => {
    expect(isTrustedStealthFactory(SIMPLE_ACCOUNT_FACTORY, UNTRUSTED_CHAIN)).toBe(false);
    expect(TRUSTED_STEALTH_FACTORIES[UNTRUSTED_CHAIN]).toBeUndefined();
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
describe("effectiveStealthChains", () => {
  const shippedFactory = (chainId: number): string | null =>
    chainId === MAINNET || chainId === BASE ? SIMPLE_ACCOUNT_FACTORY : null;

  it("fails closed when the solver does not advertise a list", () => {
    expect(effectiveStealthChains(undefined, shippedFactory)).toEqual([]);
    expect(effectiveStealthChains(null, shippedFactory)).toEqual([]);
  });

  it("composes the parsed advertised factory through the client root", () => {
    const capabilities = parseCapabilities({
      stealth_chains: [MAINNET],
      chains: [
        {
          chain_id: MAINNET,
          chain_name: "Ethereum",
          vm_type: "evm",
          stealth_factory_address: SIMPLE_ACCOUNT_FACTORY,
        },
      ],
    });
    if (!capabilities) throw new Error("capabilities fixture did not parse");

    expect(
      effectiveStealthChains(capabilities.stealthChains, (chainId) =>
        stealthFactoryFor(capabilities, chainId),
      ),
    ).toEqual([MAINNET]);
  });

  it("exposes normalized legacy conversion pairs through the client root", () => {
    const capabilities = parseCapabilities({
      conversion_pairs: [{ from: "USDC", to: "DAI", same_chain: true }],
    });
    if (!capabilities) throw new Error("capabilities fixture did not parse");

    expect(advertisedConversionPairs(capabilities)).toEqual([
      { from: "USDC", to: "DAI", sameChain: true },
    ]);
  });

  it("preserves solver order while removing duplicates and untrusted chains", () => {
    expect(effectiveStealthChains([BASE, UNTRUSTED_CHAIN, MAINNET, BASE], shippedFactory)).toEqual([
      BASE,
      MAINNET,
    ]);
  });

  it("refuses missing, attacker-controlled, and wrong-chain factories", () => {
    expect(effectiveStealthChains([MAINNET], () => null)).toEqual([]);
    expect(effectiveStealthChains([MAINNET], () => ATTACKER_FACTORY)).toEqual([]);
    expect(
      effectiveStealthChains([MAINNET], () => SIMPLE_ACCOUNT_FACTORY, {
        [BASE]: [SIMPLE_ACCOUNT_FACTORY],
      }),
    ).toEqual([]);
  });

  it("does not trust a chain with an empty factory allowlist", () => {
    expect(
      effectiveStealthChains([BASE, MAINNET], shippedFactory, {
        [BASE]: [],
        [MAINNET]: [SIMPLE_ACCOUNT_FACTORY],
      }),
    ).toEqual([MAINNET]);
  });
});

describe("trustedStealthChains", () => {
  it("keeps scan and claim coverage independent of current solver routes", () => {
    expect(trustedStealthChains()).toEqual([MAINNET, BASE]);
    expect(
      trustedStealthChains({
        [BASE]: [],
        [MAINNET]: [SIMPLE_ACCOUNT_FACTORY],
      }),
    ).toEqual([MAINNET]);
  });
});

describe("STEALTH_ACCOUNT_SALT", () => {
  it("is 0: one account per stealth EOA", () => {
    expect(STEALTH_ACCOUNT_SALT).toBe(0);
  });
});
