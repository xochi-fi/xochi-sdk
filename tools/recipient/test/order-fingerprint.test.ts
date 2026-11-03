// The order-fingerprint case from pxe-bridge's settlement vectors, re-vendored byte for byte:
// xochi-fi/pxe-bridge#89 (branch oxide-wire; vector commit 241de03 after a rebase, first seen
// at fa574445), docs/vectors/settlement-v2.json, git blob
// f7393bdebce7c9c38b6c49e84dddcd84028f0aa5. The order fingerprint's value (the v2 request
// fingerprint) is PROPOSED by pxe-bridge; re-vendor from the pxe-bridge 0.4.0 release.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ORDER_FINGERPRINT_TAG, orderFingerprintFromMeta } from "../src/order-fingerprint.js";

const raw = readFileSync(new URL("./vectors/pxe-bridge-settlement-v2.json", import.meta.url));
const vectors = JSON.parse(raw.toString("utf8")) as {
  oxide: {
    orderFingerprint: {
      tag: string;
      orderFingerprint: string;
      transferMetaLen: number;
      meta: string[];
    };
  };
};
const v = vectors.oxide.orderFingerprint;

describe("order fingerprint in OXDAI transfer meta", () => {
  it("reads the vendored vector byte for byte", () => {
    const blob = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
    expect(blob).toBe("f7393bdebce7c9c38b6c49e84dddcd84028f0aa5");
  });

  it("decodes pxe-bridge's meta to its order fingerprint", () => {
    expect(v.tag).toBe(ORDER_FINGERPRINT_TAG);
    expect(v.meta).toHaveLength(v.transferMetaLen);
    expect(orderFingerprintFromMeta(v.meta)).toBe(v.orderFingerprint);
  });

  it("returns null for a transfer that carries no tag (another sender's, or zk.money's)", () => {
    expect(orderFingerprintFromMeta(Array(7).fill("0x00"))).toBeNull();
    expect(orderFingerprintFromMeta(v.meta.slice(1))).toBeNull();
  });

  it("refuses a tagged meta that is malformed", () => {
    const wide = [...v.meta];
    wide[1] = `0x1${"0".repeat(32)}`;
    expect(() => orderFingerprintFromMeta(wide)).toThrow(/128 bits/);
    const trailing = [...v.meta];
    trailing[6] = "0x01";
    expect(() => orderFingerprintFromMeta(trailing)).toThrow(/nonzero fields/);
  });
});
