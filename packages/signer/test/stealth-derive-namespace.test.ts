/**
 * The stealth key namespace is pinned, not merely documented (xochi#471).
 *
 * `deriveStealthKeys` is a pure function of the wallet's signature over
 * STEALTH_DERIVE_MESSAGE, so that string IS the namespace. Change a character
 * and the same wallet derives a different spending/viewing pair, a different
 * meta-address, and matches none of the announcements its payments were sent
 * to. Every past payment becomes unclaimable.
 *
 * That is not hypothetical: an e2e script signed `xochi:stealth:derive:v1`
 * while the app signed the message below, so the harness spent months
 * exercising a namespace the product never used.
 *
 * Two guards here, because either alone is escapable:
 *   1. the message bytes, so an "improve the copy" edit fails loudly;
 *   2. the meta-address derived from a fixed signature, so a change to the
 *      derivation itself fails even if the message is untouched.
 */
import { describe, it, expect } from "vitest";
import { STEALTH_DERIVE_MESSAGE, encodeMetaAddress, deriveStealthKeys } from "@xochi/signer";

describe("STEALTH_DERIVE_MESSAGE is pinned", () => {
  it("is the exact string the app has signed since 2026-03-02", () => {
    expect(STEALTH_DERIVE_MESSAGE).toBe(
      "Sign this message to derive your Xochi stealth keys.\n\nThis signature will be used to create receiving addresses that only you can spend from.",
    );
  });

  it("keeps the blank line between the two sentences", () => {
    // A prettier pass or a copy edit that collapses "\n\n" to "\n" or " " is a
    // silent namespace change, so assert the separator directly.
    expect(STEALTH_DERIVE_MESSAGE.split("\n\n")).toHaveLength(2);
  });
});

describe("derived namespace is pinned", () => {
  // An arbitrary but fixed 65-byte signature. The value does not matter; that
  // the same value always yields the same meta-address does.
  const SIGNATURE = `0x${"ab".repeat(65)}`;

  it("derives a stable meta-address from a fixed signature", () => {
    const keys = deriveStealthKeys(SIGNATURE);

    expect(keys.spendingPubKey).toBe(
      "0x03fc30bd43dee3ddfc9764d079f805a6ecd223d99abd00acce9e3aa23c0c99689d",
    );
    expect(keys.viewingPubKey).toBe(
      "0x028a8f72bc054f5f84d440df710bf00f80bf519f0419921909eca05c5d2a3b4d34",
    );
    expect(encodeMetaAddress({ ...keys, chainId: 1 })).toBe(
      `st:eth:0x${keys.spendingPubKey.slice(2)}${keys.viewingPubKey.slice(2)}`,
    );
  });

  it("derives a different namespace from the harness's old message", () => {
    // Proof that the drift mattered: signing a different message is a different
    // key namespace, not a cosmetic difference.
    const appKeys = deriveStealthKeys(SIGNATURE);
    const otherKeys = deriveStealthKeys(`0x${"cd".repeat(65)}`);
    expect(otherKeys.spendingPubKey).not.toBe(appKeys.spendingPubKey);
    expect(otherKeys.viewingPubKey).not.toBe(appKeys.viewingPubKey);
  });
});
