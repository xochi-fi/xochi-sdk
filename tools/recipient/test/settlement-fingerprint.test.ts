// pxe-bridge's settlement request fingerprint, ported for the recipient's own expected order
// fingerprint. Pinned by pxe-bridge's vendored `oxide.createNote` vector (test/vectors, blob
// pinned in order-fingerprint.test.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fingerprintLines, fingerprintTerms } from "../src/core/settlement-fingerprint.js";

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/pxe-bridge-settlement-v2.json", import.meta.url), "utf8"),
) as {
  oxide: {
    createNote: {
      canonicalTerms: Parameters<typeof fingerprintTerms>[0];
      fingerprintLines: string[];
      fingerprint: string;
    };
    orderFingerprint: { orderFingerprint: string };
  };
};
const v = vectors.oxide.createNote;

describe("settlement fingerprint (pxe-bridge oxide send)", () => {
  it("reproduces the vector's lines and fingerprint, which the payout meta carries", () => {
    expect(fingerprintLines(v.canonicalTerms)).toEqual(v.fingerprintLines);
    expect(fingerprintTerms(v.canonicalTerms)).toBe(v.fingerprint);
    expect(v.fingerprint).toBe(vectors.oxide.orderFingerprint.orderFingerprint);
  });

  it("is case-insensitive in every hex member, and moves with every term", () => {
    const upper = {
      ...v.canonicalTerms,
      recipient: v.canonicalTerms.recipient.toUpperCase().replace("0X", "0x"),
      network: {
        ...v.canonicalTerms.network,
        rollupAddress: v.canonicalTerms.network.rollupAddress.toUpperCase().replace("0X", "0x"),
      },
    };
    expect(fingerprintTerms(upper)).toBe(v.fingerprint);
    expect(fingerprintTerms({ ...v.canonicalTerms, amount: "1000000000000000001" })).not.toBe(
      v.fingerprint,
    );
    expect(fingerprintTerms({ ...v.canonicalTerms, validUntil: 1_900_000_001 })).not.toBe(
      v.fingerprint,
    );
  });
});
