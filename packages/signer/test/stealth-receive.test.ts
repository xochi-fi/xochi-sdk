/**
 * Receive-side stealth crypto (ERC-5564) round-trip tests.
 *
 * Pins the core invariant: the address the SENDER derives for a payment
 * (computeStealthAddress) must equal the owner EOA the RECEIVER derives from the
 * announcement (deriveStealthOwner), and the receiver's view-tag filter must
 * match. This guards the scalar-reduction rule: reducing every secp256k1 scalar
 * mod n is behaviour-preserving, so these derivations still agree.
 */

import { describe, it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { ethers } from "ethers";
import {
  deriveStealthKeys,
  computeMetaAddressFromKeys,
  computeStealthAddress,
  deriveStealthOwner,
  checkViewTag,
  extractViewTag,
  decodeAnnouncementMetadata,
  encodeMetaAddress,
  type StealthAnnouncement,
} from "@xochi/signer";

// A deterministic 65-byte signature-like hex (0x + 130 hex). Any stable input
// works; deriveStealthKeys is a pure keccak-based derivation.
const SIGNATURE = "0x" + "ab".repeat(65);

// A fixed, valid ephemeral private key (< n). Stable so the test is deterministic.
const EPHEMERAL_PRIV = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));

function announcementFrom(
  ephemeralPubKey: string,
  viewTag: number,
  stealthAddress: string,
): StealthAnnouncement {
  return {
    schemeId: 1,
    stealthAddress,
    caller: "0x0000000000000000000000000000000000000000",
    ephemeralPubKey,
    // Metadata's first byte is the view tag (extractViewTag reads it).
    metadata: "0x" + viewTag.toString(16).padStart(2, "0") + "00".repeat(31),
    blockNumber: 1,
    txHash: "0x" + "00".repeat(32),
    logIndex: 0,
  };
}

describe("stealth ECDH sender/receiver round-trip", () => {
  it("receiver derives the same stealth EOA the sender computed", () => {
    const keys = deriveStealthKeys(SIGNATURE);
    const metaAddress = computeMetaAddressFromKeys(keys, 8453);

    const sent = computeStealthAddress(metaAddress, EPHEMERAL_PRIV);
    const announcement = announcementFrom(sent.ephemeralPubKey, sent.viewTag, sent.stealthAddress);

    const derived = deriveStealthOwner(announcement, keys.spendingKey, keys.viewingKey);

    expect(derived.stealthEOA.toLowerCase()).toBe(sent.stealthAddress.toLowerCase());
  });

  it("receiver's view-tag filter matches the sender's announcement", () => {
    const keys = deriveStealthKeys(SIGNATURE);
    const metaAddress = computeMetaAddressFromKeys(keys, 8453);

    const sent = computeStealthAddress(metaAddress, EPHEMERAL_PRIV);
    const announcement = announcementFrom(sent.ephemeralPubKey, sent.viewTag, sent.stealthAddress);

    expect(checkViewTag(announcement, keys.viewingKey)).toBe(true);
  });

  it("derives deterministically for a stable signature", () => {
    const a = deriveStealthKeys(SIGNATURE);
    const b = deriveStealthKeys(SIGNATURE);
    expect(a.spendingPubKey).toBe(b.spendingPubKey);
    expect(a.viewingPubKey).toBe(b.viewingPubKey);
  });
});

describe("private scalars as bytes or hex", () => {
  const keys = deriveStealthKeys(SIGNATURE);
  const meta = computeMetaAddressFromKeys(keys, 1);
  const ephemeralHex = ethers.hexlify(EPHEMERAL_PRIV);

  it("computeStealthAddress gives the same output for either form", () => {
    expect(computeStealthAddress(meta, ephemeralHex)).toEqual(
      computeStealthAddress(meta, EPHEMERAL_PRIV),
    );
    expect(computeStealthAddress(meta, ephemeralHex.slice(2))).toEqual(
      computeStealthAddress(meta, EPHEMERAL_PRIV),
    );
  });

  it("checkViewTag and deriveStealthOwner accept hex keys", () => {
    const sent = computeStealthAddress(meta, EPHEMERAL_PRIV);
    const announcement = announcementFrom(sent.ephemeralPubKey, sent.viewTag, sent.stealthAddress);
    const spendingHex = ethers.hexlify(keys.spendingKey);
    const viewingHex = ethers.hexlify(keys.viewingKey);

    expect(checkViewTag(announcement, viewingHex)).toBe(true);
    expect(deriveStealthOwner(announcement, spendingHex, viewingHex)).toEqual(
      deriveStealthOwner(announcement, keys.spendingKey, keys.viewingKey),
    );
  });

  it("accepts bytes from another realm", () => {
    // A jsdom test environment or an iframe hands over a Uint8Array that fails
    // ethers' `instanceof` check; the result must not depend on the realm.
    const sent = computeStealthAddress(meta, EPHEMERAL_PRIV);
    const announcement = announcementFrom(sent.ephemeralPubKey, sent.viewTag, sent.stealthAddress);
    const foreign = (bytes: Uint8Array): Uint8Array =>
      runInNewContext("Uint8Array.from(source)", { source: Array.from(bytes) });
    expect(foreign(keys.spendingKey) instanceof Uint8Array).toBe(false);

    expect(computeStealthAddress(meta, foreign(EPHEMERAL_PRIV))).toEqual(sent);
    expect(checkViewTag(announcement, foreign(keys.viewingKey))).toBe(true);
    expect(
      deriveStealthOwner(announcement, foreign(keys.spendingKey), foreign(keys.viewingKey)),
    ).toEqual(deriveStealthOwner(announcement, keys.spendingKey, keys.viewingKey));
  });

  it("deriveStealthOwner refuses a zero spending key", () => {
    const sent = computeStealthAddress(meta, EPHEMERAL_PRIV);
    const announcement = announcementFrom(sent.ephemeralPubKey, sent.viewTag, sent.stealthAddress);
    expect(() => deriveStealthOwner(announcement, new Uint8Array(32), keys.viewingKey)).toThrow(
      "spendingPrivHex must be a valid secp256k1 private key",
    );
  });
});

describe("announcement metadata", () => {
  const token = "0x" + "11".repeat(20);
  const selector = "0xa9059cbb";
  const factory = "0x13e9ed32155810fdbd067d4522c492d6f68e5944";
  const full =
    "0x" +
    "7f" +
    token.slice(2) +
    selector.slice(2) +
    (1_965_845).toString(16).padStart(64, "0") +
    factory.slice(2) +
    "00".repeat(32);

  it("decodes every field of the full layout", () => {
    expect(decodeAnnouncementMetadata(full)).toEqual({
      viewTag: 0x7f,
      token,
      selector,
      amount: 1_965_845n,
      factory,
      salt: 0n,
    });
  });

  it("returns null for a view-tag-only or non-hex blob", () => {
    expect(decodeAnnouncementMetadata("0x7f")).toBeNull();
    expect(decodeAnnouncementMetadata(full.replace("11", "zz"))).toBeNull();
  });

  it("extractViewTag reads the first byte, 0 when absent, throws on non-hex", () => {
    expect(extractViewTag(full)).toBe(0x7f);
    expect(extractViewTag("0x")).toBe(0);
    expect(() => extractViewTag("0xzz")).toThrow("Invalid view tag hex: zz");
  });
});

describe("encodeMetaAddress", () => {
  it("refuses a key that is not a compressed public key", () => {
    const keys = deriveStealthKeys(SIGNATURE);
    expect(() =>
      encodeMetaAddress({
        spendingPubKey: "0x04" + "00".repeat(32),
        viewingPubKey: keys.viewingPubKey,
        chainId: 1,
      }),
    ).toThrow("Invalid spending public key");
    expect(() => encodeMetaAddress({ ...keys, viewingPubKey: "0x02", chainId: 1 })).toThrow(
      "Invalid viewing public key",
    );
  });
});
