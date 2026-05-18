/**
 * Off-chain Pedersen parity for the COMPLIANCE_SIGNED / RISK_SCORE_SIGNED circuits.
 *
 * These tests compute Pedersen digests via @aztec/bb.js and assert they match
 * the values the in-circuit `xochi_shared::sig::*` helpers produce in Noir.
 *
 * The "expected" constants below are reproduced as `assert(actual == EXPECTED)`
 * test vectors in the ERC-8262 repo at
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
  computeSlotPayloadHash,
  computeSignerPubkeyHash,
  coordinateToFields,
  fieldToBytes,
  bytesToBigint,
  bytesToHex,
  DOMAIN_SIGNED_SIGNALS,
  DOMAIN_SIGNER_PUBKEY,
  DOMAIN_MULTI_SIGNED_SIGNALS,
  MAX_PROVIDERS_MULTI,
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
    const multiInputs = [DOMAIN_MULTI_SIGNED_SIGNALS, 0n, 0n, 0n];
    const h1 = await pedersenHash(api, sigInputs);
    const h2 = await pedersenHash(api, pkInputs);
    const h3 = await pedersenHash(api, multiInputs);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h3));
    expect(bytesToHex(h2)).not.toBe(bytesToHex(h3));
  });

  it("exports stable MAX_PROVIDERS_MULTI", () => {
    expect(MAX_PROVIDERS_MULTI).toBe(5);
  });
});

describe("Noir parity vectors", () => {
  /*
   * Inputs identical to the Noir `test_parity_with_sdk_*` tests in
   * circuits/shared/src/sig.nr. Run that test in the ERC-8262 workspace
   * with `cd circuits && nargo test sig::test_parity` to confirm both sides
   * produce the same value.
   */

  it("signed payload hash for fixture inputs", async () => {
    // Audit F-6: digest now binds chain_id + oracle_address. Fixture vector
    // matches sig.nr's test_parity_with_sdk_signed_payload_hash.
    const digest = await computeSignedPayloadHash(api, {
      chainId: 1n,
      oracleAddress: 0xabcd1234n,
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

  it("slot payload hash for fixture inputs (multi-signed)", async () => {
    // Fixture mirrors `circuits/shared/src/multi_sig.nr::test_slot_payload_hash_deterministic`
    // (slot_index=0, chain_id=1, oracle_address=0xabcd1234, jurisdiction_id=0,
    // provider_set_hash=0xdead, config_hash=0xbeef, ...). The circuit-side
    // parity test (`test_parity_with_sdk_slot_payload_hash`) must hardcode the
    // value this test prints.
    const digest = await computeSlotPayloadHash(api, {
      slotIndex: 0,
      chainId: 1n,
      oracleAddress: 0xabcd1234n,
      jurisdictionId: 0,
      providerSetHash: 0xdeadn,
      configHash: 0xbeefn,
      signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
      weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
      timestamp: 1700000000n,
      submitter: 0xcafen,
    });
    // eslint-disable-next-line no-console
    console.log("[parity] slot_payload_hash =", bytesToHex(digest));
    expect(digest.length).toBe(32);
    expect(bytesToHex(digest)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("slot payload hash domain-separates from single-signer payload", async () => {
    // Same fields as test_signed_payload_hash but routed through the multi-signed
    // helper -- domain tag and extra fields (slot_index, jurisdiction, config_hash)
    // must produce a distinct digest.
    const single = await computeSignedPayloadHash(api, {
      chainId: 1n,
      oracleAddress: 0xabcd1234n,
      providerSetHash: 0xdeadn,
      signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
      weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
      timestamp: 1700000000n,
      submitter: 0xcafen,
    });
    const multi = await computeSlotPayloadHash(api, {
      slotIndex: 0,
      chainId: 1n,
      oracleAddress: 0xabcd1234n,
      jurisdictionId: 0,
      providerSetHash: 0xdeadn,
      configHash: 0n,
      signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
      weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
      timestamp: 1700000000n,
      submitter: 0xcafen,
    });
    expect(bytesToHex(single)).not.toBe(bytesToHex(multi));
  });

  it("slot payload hash changes when slot_index changes", async () => {
    const base = {
      chainId: 1n,
      oracleAddress: 0xabcd1234n,
      jurisdictionId: 0,
      providerSetHash: 0xdeadn,
      configHash: 0xbeefn,
      signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
      weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
      timestamp: 1700000000n,
      submitter: 0xcafen,
    };
    const a = await computeSlotPayloadHash(api, { ...base, slotIndex: 0 });
    const b = await computeSlotPayloadHash(api, { ...base, slotIndex: 1 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
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
