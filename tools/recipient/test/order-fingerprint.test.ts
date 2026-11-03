// The order-fingerprint case from pxe-bridge's settlement vectors, re-vendored byte for byte
// from pxe-bridge 0.4.3. The full vector includes the prepared Oxide payout-note
// commitment that consumers bind before authorizing broadcast; this test pins
// the request/order fingerprint subset used by the recipient tool.

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
    expect(blob).toBe("c95b99970c202996d8bc42910bf6f35b6e3ceddf");
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
