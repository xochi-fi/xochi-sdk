/**
 * Off-chain Pedersen parity for the COMPLIANCE_SIGNED / RISK_SCORE_SIGNED circuits.
 *
 * These tests compute Pedersen digests via @aztec/bb.js and assert they match
 * the values the in-circuit `xochi_shared::sig::*` helpers produce in Noir.
 *
 * The expected constants below are hard-coded as `assert(actual == expected)`
 * test vectors in the ERC-8262 repo at
 *   circuits/shared/src/sig.nr       (test_parity_with_sdk_signed_payload_hash,
 *                                     test_parity_with_sdk_risk_signed_payload_hash,
 *                                     test_parity_with_sdk_signer_pubkey_hash)
 *   circuits/shared/src/multi_sig.nr (test_parity_with_sdk_slot_payload_hash)
 * and those Noir tests pass under nargo 1.0.0-beta.20
 * (`cd circuits/shared && nargo test parity`).
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
  DOMAIN_RISK_SIGNED_SIGNALS,
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
    const tags = [
      DOMAIN_SIGNED_SIGNALS,
      DOMAIN_RISK_SIGNED_SIGNALS,
      DOMAIN_SIGNER_PUBKEY,
      DOMAIN_MULTI_SIGNED_SIGNALS,
    ];
    const digests = await Promise.all(tags.map((t) => pedersenHash(api, [t, 0n, 0n, 0n])));
    expect(new Set(digests.map(bytesToHex)).size).toBe(tags.length);
  });

  it("exports stable MAX_PROVIDERS_MULTI", () => {
    expect(MAX_PROVIDERS_MULTI).toBe(5);
  });
});

describe("Noir parity vectors", () => {
  /*
   * Inputs AND expected digests identical to the Noir `test_parity_with_sdk_*`
   * tests in ERC-8262 circuits/shared/src/{sig,multi_sig}.nr. Run
   * `cd circuits/shared && nargo test parity` in the ERC-8262 workspace to
   * confirm the circuit side produces the same values.
   */

  /** sig.nr::test_parity_with_sdk_signed_payload_hash `expected` (COMPLIANCE_SIGNED). */
  const SIGNED_PAYLOAD_HASH = "0x161ce9164a86defd6b8c44e9923690407bea0488eb15bd91b99ce71438dae106";
  /** sig.nr::test_parity_with_sdk_risk_signed_payload_hash `expected` (RISK_SCORE_SIGNED). */
  const RISK_SIGNED_PAYLOAD_HASH =
    "0x237db3dd775fcc4721519a93dbab793d4971ddba8ed977495de3d4ea88088007";
  /** multi_sig.nr::test_parity_with_sdk_slot_payload_hash `expected`. */
  const SLOT_PAYLOAD_HASH = "0x2fb6d465edad72085a6d9cdd0fa2bba97c6f946e55762c0d53d96abe5d8e547f";
  /** sig.nr::test_parity_with_sdk_signer_pubkey_hash `expected`. */
  const SIGNER_PUBKEY_HASH = "0x058715a847c033508c9f675ad51831993ea45169b097bd064942295ee24e4f19";

  /** Inputs shared by the sig.nr parity tests; only the domain differs. */
  const SIGNED_FIXTURE = {
    chainId: 1n,
    oracleAddress: 0xabcd1234n,
    providerSetHash: 0xdeadn,
    signals: [10n, 20n, 30n, 0n, 0n, 0n, 0n, 0n],
    weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
    timestamp: 1700000000n,
    submitter: 0xcafen,
  };

  it("signed payload hash for fixture inputs (COMPLIANCE_SIGNED)", async () => {
    // Audit F-6: digest binds chain_id + oracle_address. Fixture vector
    // matches sig.nr's test_parity_with_sdk_signed_payload_hash.
    const digest = await computeSignedPayloadHash(api, { ...SIGNED_FIXTURE, proofType: 0x07 });
    // Printed so a deliberate layout change can be copied into sig.nr; the
    // assertion below fails on any drift from the circuit-side constant.
    // eslint-disable-next-line no-console
    console.log("[parity] signed_payload_hash =", bytesToHex(digest));
    expect(bytesToHex(digest)).toBe(SIGNED_PAYLOAD_HASH);
  });

  it("signed payload hash for fixture inputs (RISK_SCORE_SIGNED)", async () => {
    // Review #5: 0x08 signs under its own domain tag, so the same bundle has a
    // different digest than for 0x07. Matches
    // sig.nr's test_parity_with_sdk_risk_signed_payload_hash.
    const digest = await computeSignedPayloadHash(api, { ...SIGNED_FIXTURE, proofType: 0x08 });
    // eslint-disable-next-line no-console
    console.log("[parity] risk_signed_payload_hash =", bytesToHex(digest));
    expect(bytesToHex(digest)).toBe(RISK_SIGNED_PAYLOAD_HASH);
  });

  it("rejects a proof type without a signed-signals domain", async () => {
    await expect(
      computeSignedPayloadHash(api, {
        ...SIGNED_FIXTURE,
        proofType: 0x09 as unknown as 0x07,
      }),
    ).rejects.toThrow(/proofType must be 0x07 .* or 0x08/);
  });

  it("slot payload hash for fixture inputs (multi-signed)", async () => {
    // Fixture mirrors `circuits/shared/src/multi_sig.nr::test_parity_with_sdk_slot_payload_hash`
    // (slot_index=0, chain_id=1, oracle_address=0xabcd1234, jurisdiction_id=0,
    // provider_set_hash=0xdead, config_hash=0xbeef, ...), which hard-codes the
    // same expected digest.
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
    expect(bytesToHex(digest)).toBe(SLOT_PAYLOAD_HASH);
  });

  it("slot payload hash domain-separates from single-signer payload", async () => {
    // Same fields as test_signed_payload_hash but routed through the multi-signed
    // helper -- domain tag and extra fields (slot_index, jurisdiction, config_hash)
    // must produce a distinct digest.
    const single = await computeSignedPayloadHash(api, { ...SIGNED_FIXTURE, proofType: 0x07 });
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
    // Same pattern as sig.nr::test_parity_with_sdk_signer_pubkey_hash
    // (x = 0x00..0x1F, y = 0x40..0x5F). NOT a real key.
    const pubkeyX = new Uint8Array(32);
    const pubkeyY = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      pubkeyX[i] = i;
      pubkeyY[i] = 0x40 + i;
    }
    const digest = await computeSignerPubkeyHash(api, pubkeyX, pubkeyY);
    // eslint-disable-next-line no-console
    console.log("[parity] signer_pubkey_hash =", bytesToHex(digest));
    expect(bytesToHex(digest)).toBe(SIGNER_PUBKEY_HASH);
  });
});
