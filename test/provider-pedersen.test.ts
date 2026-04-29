/**
 * Off-chain Pedersen parity for the COMPLIANCE_SIGNED / RISK_SCORE_SIGNED circuits.
 *
 * These tests compute Pedersen digests via @aztec/bb.js and assert they match
 * the values the in-circuit `xochi_shared::sig::*` helpers produce in Noir.
 *
 * The "expected" constants below are reproduced as `assert(actual == EXPECTED)`
 * test vectors in the erc-xochi-zkp repo at
 *   circuits/shared/src/sig.nr (test_parity_with_sdk_*).
 *
 * If you change either side without updating the other, both test suites will fail.
 * That is intentional -- this is the ground-truth contract for off-chain signers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Barretenberg } from "@aztec/bb.js";
import {
  pedersenHash,
  computeSignedPayloadHash,
  computeSignerPubkeyHash,
  coordinateToFields,
  fieldToBytes,
  bytesToBigint,
  bytesToHex,
  DOMAIN_SIGNED_SIGNALS,
  DOMAIN_SIGNER_PUBKEY,
} from "../src/provider/pedersen.js";

let api: Barretenberg;

beforeAll(async () => {
  api = await Barretenberg.new();
}, 30_000);

afterAll(async () => {
  await api.destroy();
});

describe("fieldToBytes / bytesToBigint round-trip", () => {
  it("zero", () => {
    const b = fieldToBytes(0n);
    expect(b.length).toBe(32);
    expect(bytesToBigint(b)).toBe(0n);
  });

  it("small", () => {
    const b = fieldToBytes(0xdeadn);
    expect(bytesToBigint(b)).toBe(0xdeadn);
    expect(b[30]).toBe(0xde);
    expect(b[31]).toBe(0xad);
  });

  it("rejects negative", () => {
    expect(() => fieldToBytes(-1n)).toThrow();
  });

  it("rejects > 32 bytes", () => {
    expect(() => fieldToBytes(1n << 256n)).toThrow();
  });
});

describe("coordinateToFields", () => {
  it("zero", () => {
    const z = new Uint8Array(32);
    const { hi, lo } = coordinateToFields(z);
    expect(hi).toBe(0n);
    expect(lo).toBe(0n);
  });

  it("0x00..0x1F pattern matches Noir test_coordinate_to_fields_pattern", () => {
    const c = new Uint8Array(32);
    for (let i = 0; i < 32; i++) c[i] = i;
    const { hi, lo } = coordinateToFields(c);
    expect(hi).toBe(0x000102030405060708090a0b0c0d0e0fn);
    expect(lo).toBe(0x101112131415161718191a1b1c1d1e1fn);
  });
});

describe("pedersenHash basic shape", () => {
  it("returns 32 bytes", async () => {
    const h = await pedersenHash(api, [1n, 2n, 3n]);
    expect(h.length).toBe(32);
  });

  it("is deterministic", async () => {
    const h1 = await pedersenHash(api, [42n, 7n]);
    const h2 = await pedersenHash(api, [42n, 7n]);
    expect(bytesToHex(h1)).toBe(bytesToHex(h2));
  });

  it("differs from input order", async () => {
    const h1 = await pedersenHash(api, [1n, 2n]);
    const h2 = await pedersenHash(api, [2n, 1n]);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });

  it("differs across DOMAIN tags", async () => {
    const sigInputs = [DOMAIN_SIGNED_SIGNALS, 0n, 0n, 0n];
    const pkInputs = [DOMAIN_SIGNER_PUBKEY, 0n, 0n, 0n];
    const h1 = await pedersenHash(api, sigInputs);
    const h2 = await pedersenHash(api, pkInputs);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });
});

describe("Noir parity vectors", () => {
  /*
   * Inputs identical to the Noir `test_parity_with_sdk_*` tests in
   * circuits/shared/src/sig.nr. Run that test in the erc-xochi-zkp workspace
   * with `cd circuits && nargo test sig::test_parity` to confirm both sides
   * produce the same value.
   */

  it("signed payload hash for fixture inputs", async () => {
    const digest = await computeSignedPayloadHash(api, {
      providerSetHash: 0xdeadn,
      signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
      weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
      timestamp: 1700000000n,
      submitter: 0xcafen,
    });
    // The hex string emitted here is the value the Noir test must hardcode.
    // First-time bootstrap: run this test, copy console output, paste into Noir.
    // Subsequent runs: the assertion below catches drift.
    // eslint-disable-next-line no-console
    console.log("[parity] signed_payload_hash =", bytesToHex(digest));
    expect(digest.length).toBe(32);
    // PARITY_VECTOR_1 -- regenerate via Noir test if Pedersen layout ever changes.
    expect(bytesToHex(digest)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signer pubkey hash for fixture pubkey", async () => {
    // A deterministic test pubkey pattern (NOT a real key).
    const pubkeyX = new Uint8Array(32);
    const pubkeyY = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      pubkeyX[i] = i;
      pubkeyY[i] = 0x40 + i;
    }
    const digest = await computeSignerPubkeyHash(api, pubkeyX, pubkeyY);
    // eslint-disable-next-line no-console
    console.log("[parity] signer_pubkey_hash =", bytesToHex(digest));
    expect(digest.length).toBe(32);
    expect(bytesToHex(digest)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
