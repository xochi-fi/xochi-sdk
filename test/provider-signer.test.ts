/**
 * Provider signer end-to-end test.
 *
 * Exercises the off-chain signing path:
 *   1. Load a deterministic test key
 *   2. Compute a signed-signals bundle for a known payload
 *   3. Verify the signature *off-circuit* via @noble/curves to catch any
 *      r/s/lowS-normalization bugs before they reach the in-circuit verifier
 *   4. Confirm the replay DB refuses a duplicate request
 *
 * In-circuit verification (the canonical correctness check) is exercised by
 * the V1.4 integration test once compliance_signed fixtures are available.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Barretenberg } from "@aztec/bb.js";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  RawKeyLoader,
  loadSignerKey,
  signSignals,
  signSignalsWithReplayProtection,
  MemoryReplayDb,
  ReplayDetected,
  formatSignSignalsResult,
  bytesToHex,
  type SignSignalsRequest,
} from "../src/provider/index.js";

let api: Barretenberg;

// Deterministic 32-byte test key. NOT a secret -- this is in source.
// secp256k1 group order constraint: must be < n.
const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20

const SAMPLE_REQUEST: SignSignalsRequest = {
  providerSetHash: 0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2n,
  signals: [25n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
  weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
  timestamp: 1700000000n,
  submitter: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n,
};

beforeAll(async () => {
  api = await Barretenberg.new();
}, 30_000);

afterAll(async () => {
  await api.destroy();
});

describe("signSignals", () => {
  it("produces a signature that ECDSA-verifies off-chain", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "test-fixed"));
    const result = await signSignals(api, key, SAMPLE_REQUEST);

    expect(result.signature.length).toBe(64);
    expect(result.pubkeyX.length).toBe(32);
    expect(result.pubkeyY.length).toBe(32);
    expect(result.signerPubkeyHash.length).toBe(32);
    expect(result.payloadHash.length).toBe(32);

    // Reconstruct compressed pubkey for noble: 0x02|0x03 + x.
    // We have uncompressed (x, y) so use 0x04 prefix variant verify.
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(result.pubkeyX, 1);
    uncompressed.set(result.pubkeyY, 33);

    const valid = secp256k1.verify(result.signature, result.payloadHash, uncompressed);
    expect(valid).toBe(true);
  });

  it("is deterministic for identical inputs (RFC6979 nonce)", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "test"));
    const a = await signSignals(api, key, SAMPLE_REQUEST);
    const b = await signSignals(api, key, SAMPLE_REQUEST);
    expect(bytesToHex(a.signature)).toBe(bytesToHex(b.signature));
    expect(bytesToHex(a.signerPubkeyHash)).toBe(bytesToHex(b.signerPubkeyHash));
  });

  it("changes signature when any field of the request changes", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "test"));
    const baseline = await signSignals(api, key, SAMPLE_REQUEST);
    const altered = await signSignals(api, key, {
      ...SAMPLE_REQUEST,
      signals: [26n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
    });
    expect(bytesToHex(altered.signature)).not.toBe(bytesToHex(baseline.signature));
    expect(bytesToHex(altered.payloadHash)).not.toBe(bytesToHex(baseline.payloadHash));
  });

  it("formats result as hex without losing data", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY));
    const result = await signSignals(api, key, SAMPLE_REQUEST);
    const formatted = formatSignSignalsResult(result);
    expect(formatted.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(formatted.signerPubkeyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("signSignalsWithReplayProtection", () => {
  it("signs once, refuses replay of identical request", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb();

    const first = await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    expect(first.signature.length).toBe(64);

    await expect(signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST)).rejects.toThrow(
      ReplayDetected,
    );

    expect(await db.size()).toBe(1);
  });

  it("permits a different submitter with otherwise-identical inputs", async () => {
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb();

    await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    const altSubmitter = await signSignalsWithReplayProtection(api, key, db, {
      ...SAMPLE_REQUEST,
      submitter: 0xa0ee7a142d267c1f36714e4a8f75612f20a79720n,
    });
    expect(altSubmitter.signature.length).toBe(64);
    expect(await db.size()).toBe(2);
  });

  it("permits the same submitter with a different timestamp", async () => {
    // Different timestamp -> different payload hash -> different replay key.
    const key = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb();

    await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    const later = await signSignalsWithReplayProtection(api, key, db, {
      ...SAMPLE_REQUEST,
      timestamp: SAMPLE_REQUEST.timestamp + 60n,
    });
    expect(later.signature.length).toBe(64);
    expect(await db.size()).toBe(2);
  });
});

describe("RawKeyLoader validation", () => {
  it("rejects key of wrong length", async () => {
    expect(() => new RawKeyLoader(new Uint8Array(31))).toThrow();
  });

  it("rejects an out-of-range private key", async () => {
    // n - 0 == 0; key of all zeros is invalid.
    const zero = new Uint8Array(32);
    await expect(loadSignerKey(new RawKeyLoader(zero, "zero-key"))).rejects.toThrow(
      /invalid secp256k1 key/,
    );
  });
});
