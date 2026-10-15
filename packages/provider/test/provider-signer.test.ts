/**
 * Provider signer end-to-end test.
 *
 * Exercises the off-chain signing path:
 *   1. Load a deterministic test key
 *   2. Compute a signed-signals bundle for a known payload
 *   3. Verify the signature *off-circuit* via @noble/curves to catch any
 *      r/s/lowS-normalization bugs before they reach the in-circuit verifier
 *   4. Confirm the signing ledger returns the same retained bytes for an identical retry
 *
 * In-circuit verification is exercised by @xochi/sdk's integration-signed tests.
 */

import vm from "node:vm";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Barretenberg } from "@aztec/bb.js";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  RawPrivateKeyLoader,
  loadLocalSigner,
  signSignals,
  signSignalsWithReplayProtection,
  MemoryReplayDb,
  bytesToHex,
  computeSignedPayloadHash,
  type DigestSigner,
  type ReplayDb,
  type SignSignalsRequest,
  type SignSignalsResult,
} from "../src/index.js";

let api: Barretenberg;

// Deterministic 32-byte test key. NOT a secret -- this is in source.
// secp256k1 group order constraint: must be < n.
const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20

const SAMPLE_REQUEST: SignSignalsRequest = {
  proofType: 0x07,
  // Audit F-6: chain_id + oracle_address bind the signed digest to a
  // specific deployment.
  chainId: 1n,
  oracleAddress: 0xabcd1234n,
  providerSetHash: 0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2n,
  signals: [25n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
  weights: [50n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
  timestamp: 1700000000n,
  submitter: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n,
};

function makeCounterEntropySigner(): DigestSigner {
  const publicKey = secp256k1.getPublicKey(TEST_PRIVATE_KEY, false);
  let counter = 0;
  return {
    label: "counter-entropy-test-key",
    publicKeyX: publicKey.slice(1, 33),
    publicKeyY: publicKey.slice(33, 65),
    async signDigest(digest) {
      counter += 1;
      const extraEntropy = new Uint8Array(32);
      new DataView(extraEntropy.buffer).setUint32(28, counter, false);
      return secp256k1
        .sign(digest, TEST_PRIVATE_KEY, { lowS: true, extraEntropy })
        .toCompactRawBytes();
    },
  };
}

function expectValidLowSSignature(result: SignSignalsResult): void {
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(result.pubkeyX, 1);
  publicKey.set(result.pubkeyY, 33);
  expect(secp256k1.Signature.fromCompact(result.signature).hasHighS()).toBe(false);
  expect(secp256k1.verify(result.signature, result.payloadHash, publicKey)).toBe(true);
}

beforeAll(async () => {
  api = await Barretenberg.new();
}, 30_000);

afterAll(async () => {
  await api.destroy();
});

describe("signSignals", () => {
  it("produces a signature that ECDSA-verifies off-chain", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY, "test-fixed"));
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

  it("signs through a non-exportable digest signer contract", async () => {
    const publicKey = secp256k1.getPublicKey(TEST_PRIVATE_KEY, false);
    let signedDigest: Uint8Array | undefined;
    const signer: DigestSigner = {
      label: "kms-test-key",
      publicKeyX: publicKey.slice(1, 33),
      publicKeyY: publicKey.slice(33, 65),
      async signDigest(digest) {
        signedDigest = digest.slice();
        return secp256k1.sign(digest, TEST_PRIVATE_KEY, { lowS: true }).toCompactRawBytes();
      },
    };

    expect("privateKey" in signer).toBe(false);
    const result = await signSignals(api, signer, SAMPLE_REQUEST);
    if (signedDigest === undefined) throw new Error("digest signer was not called");
    expect(bytesToHex(signedDigest)).toBe(bytesToHex(result.payloadHash));
    expect(secp256k1.verify(result.signature, result.payloadHash, publicKey)).toBe(true);
  });

  it("refuses a digest signer whose signature belongs to another key", async () => {
    const publicKey = secp256k1.getPublicKey(TEST_PRIVATE_KEY, false);
    const otherKey = new Uint8Array(32).fill(7);
    const signer: DigestSigner = {
      label: "misconfigured-kms-key",
      publicKeyX: publicKey.slice(1, 33),
      publicKeyY: publicKey.slice(33, 65),
      async signDigest(digest) {
        return secp256k1.sign(digest, otherKey, { lowS: true }).toCompactRawBytes();
      },
    };

    await expect(signSignals(api, signer, SAMPLE_REQUEST)).rejects.toThrow(
      /signature for a different key/,
    );
  });

  it("accepts distinct valid low-S signatures for repeated direct signing", async () => {
    const signer = makeCounterEntropySigner();
    const first = await signSignals(api, signer, SAMPLE_REQUEST);
    const second = await signSignals(api, signer, SAMPLE_REQUEST);

    expect(bytesToHex(second.payloadHash)).toBe(bytesToHex(first.payloadHash));
    expect(bytesToHex(second.signature)).not.toBe(bytesToHex(first.signature));
    expectValidLowSSignature(first);
    expectValidLowSSignature(second);
  });

  it("changes signature when any field of the request changes", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY, "test"));
    const baseline = await signSignals(api, key, SAMPLE_REQUEST);
    const altered = await signSignals(api, key, {
      ...SAMPLE_REQUEST,
      signals: [26n, 30n, 20n, 0n, 0n, 0n, 0n, 0n],
    });
    expect(bytesToHex(altered.signature)).not.toBe(bytesToHex(baseline.signature));
    expect(bytesToHex(altered.payloadHash)).not.toBe(bytesToHex(baseline.payloadHash));
  });

  it("binds the signature to the proof type", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY, "test"));
    const forCompliance = await signSignals(api, key, SAMPLE_REQUEST);
    const forRiskScore = await signSignals(api, key, { ...SAMPLE_REQUEST, proofType: 0x08 });
    expect(bytesToHex(forRiskScore.payloadHash)).not.toBe(bytesToHex(forCompliance.payloadHash));

    // A 0x07 signature does not verify over the 0x08 digest the circuit checks.
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(forCompliance.pubkeyX, 1);
    uncompressed.set(forCompliance.pubkeyY, 33);
    expect(secp256k1.verify(forCompliance.signature, forRiskScore.payloadHash, uncompressed)).toBe(
      false,
    );
  });
});

describe("signSignalsWithReplayProtection", () => {
  // The ledger evicts by the signed timestamp, so pin its clock to the fixture's.
  const atSampleTime = (): number => Number(SAMPLE_REQUEST.timestamp);

  it("replays retained bytes and may re-sign differently after removal", async () => {
    const signer = makeCounterEntropySigner();
    const db = new MemoryReplayDb({ now: atSampleTime });

    const first = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);
    expect(first.replayed).toBe(false);

    const retry = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);
    expect(retry.replayed).toBe(true);
    expect(bytesToHex(retry.signature)).toBe(bytesToHex(first.signature));
    expect(bytesToHex(retry.pubkeyX)).toBe(bytesToHex(first.pubkeyX));
    expect(bytesToHex(retry.pubkeyY)).toBe(bytesToHex(first.pubkeyY));
    expect(bytesToHex(retry.signerPubkeyHash)).toBe(bytesToHex(first.signerPubkeyHash));
    expect(bytesToHex(retry.payloadHash)).toBe(bytesToHex(first.payloadHash));
    expect(await db.size()).toBe(1);

    db.reset();
    const afterRemoval = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);
    expect(afterRemoval.replayed).toBe(false);
    expect(bytesToHex(afterRemoval.signature)).not.toBe(bytesToHex(first.signature));
    expect(bytesToHex(afterRemoval.payloadHash)).toBe(bytesToHex(first.payloadHash));
    expectValidLowSSignature(first);
    expectValidLowSSignature(afterRemoval);
  });

  it("publishes one canonical bundle for concurrent nondeterministic attempts", async () => {
    const publicKey = secp256k1.getPublicKey(TEST_PRIVATE_KEY, false);
    let calls = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstEntered!: () => void;
    let markSecondEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      markSecondEntered = resolve;
    });
    const signer: DigestSigner = {
      label: "concurrent-counter-entropy",
      publicKeyX: publicKey.slice(1, 33),
      publicKeyY: publicKey.slice(33, 65),
      async signDigest(digest) {
        calls += 1;
        const call = calls;
        const gate = new Promise<void>((resolve) => {
          if (call === 1) {
            releaseFirst = resolve;
            markFirstEntered();
          } else {
            releaseSecond = resolve;
            markSecondEntered();
          }
        });
        await gate;
        const extraEntropy = new Uint8Array(32);
        new DataView(extraEntropy.buffer).setUint32(28, call, false);
        return secp256k1
          .sign(digest, TEST_PRIVATE_KEY, { lowS: true, extraEntropy })
          .toCompactRawBytes();
      },
    };
    const db = new MemoryReplayDb({ now: atSampleTime });

    const firstPromise = signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);
    await firstEntered;
    const secondPromise = signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);
    await secondEntered;
    releaseFirst();
    const first = await firstPromise;
    releaseSecond();
    const second = await secondPromise;

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(bytesToHex(second.signature)).toBe(bytesToHex(first.signature));
    expect(bytesToHex(second.payloadHash)).toBe(bytesToHex(first.payloadHash));
    expect(calls).toBe(2);
  });

  it("signs the digest used for lookup even if the request mutates while awaiting the DB", async () => {
    const signer = makeCounterEntropySigner();
    const req: SignSignalsRequest = {
      ...SAMPLE_REQUEST,
      signals: [...SAMPLE_REQUEST.signals],
      weights: [...SAMPLE_REQUEST.weights],
    };
    const expected = await computeSignedPayloadHash(api, {
      ...req,
      signals: [...req.signals],
      weights: [...req.weights],
    });
    const db: ReplayDb = {
      async lookup() {
        req.signals[0] = 26n;
        return undefined;
      },
      async recordCanonical(_submitter, _payloadHash, _timestamp, result) {
        return { result, inserted: true };
      },
      async size() {
        return 0;
      },
    };

    const result = await signSignalsWithReplayProtection(api, signer, db, req);

    expect(bytesToHex(result.payloadHash)).toBe(bytesToHex(expected));
    expectValidLowSSignature(result);
  });

  it("uses one submitter and timestamp snapshot for hashing and replay metadata", async () => {
    const signer = makeCounterEntropySigner();
    let submitterReads = 0;
    let timestampReads = 0;
    let lookupSubmitter: bigint | undefined;
    let recordedSubmitter: bigint | undefined;
    let recordedTimestamp: bigint | undefined;
    const req: SignSignalsRequest = {
      ...SAMPLE_REQUEST,
      get submitter() {
        submitterReads += 1;
        return submitterReads === 1 ? SAMPLE_REQUEST.submitter : SAMPLE_REQUEST.submitter + 1n;
      },
      get timestamp() {
        timestampReads += 1;
        return timestampReads === 1 ? SAMPLE_REQUEST.timestamp : 0n;
      },
    };
    const db: ReplayDb = {
      async lookup(submitter) {
        lookupSubmitter = submitter;
        return undefined;
      },
      async recordCanonical(submitter, _payloadHash, timestamp, result) {
        recordedSubmitter = submitter;
        recordedTimestamp = timestamp;
        return { result, inserted: true };
      },
      async size() {
        return 0;
      },
    };

    await signSignalsWithReplayProtection(api, signer, db, req);

    expect(submitterReads).toBe(1);
    expect(timestampReads).toBe(1);
    expect(lookupSubmitter).toBe(SAMPLE_REQUEST.submitter);
    expect(recordedSubmitter).toBe(SAMPLE_REQUEST.submitter);
    expect(recordedTimestamp).toBe(SAMPLE_REQUEST.timestamp);
  });

  it("keeps the authoritative digest private from replay storage", async () => {
    const signer = makeCounterEntropySigner();
    const expected = await computeSignedPayloadHash(api, SAMPLE_REQUEST);
    const db: ReplayDb = {
      async lookup(_submitter, payloadHash) {
        payloadHash.fill(0);
        return undefined;
      },
      async recordCanonical(_submitter, payloadHash, _timestamp, result) {
        payloadHash.fill(0xff);
        return { result, inserted: true };
      },
      async size() {
        return 0;
      },
    };

    const result = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);

    expect(bytesToHex(result.payloadHash)).toBe(bytesToHex(expected));
    expectValidLowSSignature(result);
  });

  it("accepts valid replay byte arrays from another JavaScript realm", async () => {
    const signer = makeCounterEntropySigner();
    const valid = await signSignals(api, signer, SAMPLE_REQUEST);
    const fromOtherRealm = (bytes: Uint8Array): Uint8Array =>
      vm.runInNewContext("Uint8Array.from(bytes)", { bytes: [...bytes] }) as Uint8Array;
    const retained: SignSignalsResult = {
      signature: fromOtherRealm(valid.signature),
      pubkeyX: fromOtherRealm(valid.pubkeyX),
      pubkeyY: fromOtherRealm(valid.pubkeyY),
      signerPubkeyHash: fromOtherRealm(valid.signerPubkeyHash),
      payloadHash: fromOtherRealm(valid.payloadHash),
    };
    const db: ReplayDb = {
      async lookup() {
        return retained;
      },
      async recordCanonical() {
        throw new Error("valid replay row must be returned");
      },
      async size() {
        return 1;
      },
    };

    const result = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);

    expect(result.replayed).toBe(true);
    expect(bytesToHex(result.signature)).toBe(bytesToHex(valid.signature));
  });

  it("refuses a canonical store that claims it retained a different candidate", async () => {
    const signer = makeCounterEntropySigner();
    const otherValid = await signSignals(api, signer, SAMPLE_REQUEST);
    const db: ReplayDb = {
      async lookup() {
        return undefined;
      },
      async recordCanonical() {
        return { result: otherValid, inserted: true };
      },
      async size() {
        return 0;
      },
    };

    await expect(signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST)).rejects.toThrow(
      /claimed to retain the candidate/,
    );
  });

  it("refuses non-boolean canonical insertion metadata", async () => {
    const signer = makeCounterEntropySigner();
    const db: ReplayDb = {
      async lookup() {
        return undefined;
      },
      async recordCanonical(_submitter, _payloadHash, _timestamp, result) {
        return { result, inserted: undefined as unknown as boolean };
      },
      async size() {
        return 0;
      },
    };

    await expect(signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST)).rejects.toThrow(
      /invalid inserted metadata/,
    );
  });

  it("fails closed on corrupt retained replay bundles", async () => {
    const signer = makeCounterEntropySigner();
    const valid = await signSignals(api, signer, SAMPLE_REQUEST);
    const corruptions: Array<[string, (result: SignSignalsResult) => void]> = [
      ["field lengths", (result) => (result.signature = new Uint8Array(63))],
      ["signature", (result) => result.signature.fill(0)],
      ["payload hash", (result) => result.payloadHash.fill(0)],
      ["signer commitment", (result) => result.signerPubkeyHash.fill(0)],
    ];

    for (const [label, corrupt] of corruptions) {
      const retained: SignSignalsResult = {
        signature: valid.signature.slice(),
        pubkeyX: valid.pubkeyX.slice(),
        pubkeyY: valid.pubkeyY.slice(),
        signerPubkeyHash: valid.signerPubkeyHash.slice(),
        payloadHash: valid.payloadHash.slice(),
      };
      corrupt(retained);
      const db: ReplayDb = {
        async lookup() {
          return retained;
        },
        async recordCanonical() {
          throw new Error("corrupt matching record must not be replaced");
        },
        async size() {
          return 1;
        },
      };

      await expect(
        signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST),
        label,
      ).rejects.toThrow(/replay DB returned/);
    }
  });

  it("uses one copied signer identity throughout a signing attempt", async () => {
    const publicKey = secp256k1.getPublicKey(TEST_PRIVATE_KEY, false);
    const sourceX = publicKey.slice(1, 33);
    const sourceY = publicKey.slice(33, 65);
    const expectedX = sourceX.slice();
    const expectedY = sourceY.slice();
    let publicKeyXReads = 0;
    let publicKeyYReads = 0;
    const signer: DigestSigner = {
      label: "mutable-identity-test-key",
      get publicKeyX() {
        publicKeyXReads += 1;
        return sourceX;
      },
      get publicKeyY() {
        publicKeyYReads += 1;
        return sourceY;
      },
      async signDigest(digest) {
        return secp256k1.sign(digest, TEST_PRIVATE_KEY, { lowS: true }).toCompactRawBytes();
      },
    };
    const db = new MemoryReplayDb({
      now: () => {
        sourceX.fill(0);
        sourceY.fill(0);
        return Number(SAMPLE_REQUEST.timestamp);
      },
    });

    const result = await signSignalsWithReplayProtection(api, signer, db, SAMPLE_REQUEST);

    expect(publicKeyXReads).toBe(1);
    expect(publicKeyYReads).toBe(1);
    expect(bytesToHex(result.pubkeyX)).toBe(bytesToHex(expectedX));
    expect(bytesToHex(result.pubkeyY)).toBe(bytesToHex(expectedY));
    expectValidLowSSignature(result);
  });

  it("records a different submitter with otherwise-identical inputs separately", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb({ now: atSampleTime });

    const base = await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    const altSubmitter = await signSignalsWithReplayProtection(api, key, db, {
      ...SAMPLE_REQUEST,
      submitter: 0xa0ee7a142d267c1f36714e4a8f75612f20a79720n,
    });
    expect(altSubmitter.replayed).toBe(false);
    expect(bytesToHex(altSubmitter.signature)).not.toBe(bytesToHex(base.signature));
    expect(await db.size()).toBe(2);
  });

  it("records the same submitter with a different timestamp separately", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb({ now: atSampleTime });

    await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    const later = await signSignalsWithReplayProtection(api, key, db, {
      ...SAMPLE_REQUEST,
      timestamp: SAMPLE_REQUEST.timestamp + 60n,
    });
    expect(later.replayed).toBe(false);
    expect(await db.size()).toBe(2);
  });

  it("keeps local RFC 6979 signatures stable after eviction", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY));
    let now = Number(SAMPLE_REQUEST.timestamp);
    const db = new MemoryReplayDb({ retentionSeconds: 600, now: () => now });

    const first = await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    now += 600;
    expect(await db.size()).toBe(1); // exactly at the retention edge: kept
    now += 1;
    expect(await db.size()).toBe(0);

    const again = await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    expect(again.replayed).toBe(false);
    expect(bytesToHex(again.signature)).toBe(bytesToHex(first.signature));
  });

  it("caps retained records, dropping the oldest first", async () => {
    const key = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY));
    const db = new MemoryReplayDb({ maxEntries: 1, now: atSampleTime });
    const later = { ...SAMPLE_REQUEST, timestamp: SAMPLE_REQUEST.timestamp + 1n };

    const first = await signSignalsWithReplayProtection(api, key, db, SAMPLE_REQUEST);
    await signSignalsWithReplayProtection(api, key, db, later);
    expect(await db.size()).toBe(1);
    expect(await db.lookup(SAMPLE_REQUEST.submitter, first.payloadHash)).toBeUndefined();
    expect((await signSignalsWithReplayProtection(api, key, db, later)).replayed).toBe(true);
  });

  it("does not serve a record signed by a different key", async () => {
    const oldKey = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY));
    const rotatedBytes = new Uint8Array(32).fill(7);
    const newKey = await loadLocalSigner(new RawPrivateKeyLoader(rotatedBytes));
    const db = new MemoryReplayDb({ now: atSampleTime });

    await signSignalsWithReplayProtection(api, oldKey, db, SAMPLE_REQUEST);
    const rotated = await signSignalsWithReplayProtection(api, newKey, db, SAMPLE_REQUEST);
    expect(rotated.replayed).toBe(false);
    expect(bytesToHex(rotated.pubkeyX)).toBe(bytesToHex(newKey.publicKeyX));

    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(newKey.publicKeyX, 1);
    uncompressed.set(newKey.publicKeyY, 33);
    expect(secp256k1.verify(rotated.signature, rotated.payloadHash, uncompressed)).toBe(true);
  });
});

describe("RawPrivateKeyLoader validation", () => {
  it("rejects key of wrong length", async () => {
    expect(() => new RawPrivateKeyLoader(new Uint8Array(31))).toThrow();
  });

  it("rejects an out-of-range private key", async () => {
    // n - 0 == 0; key of all zeros is invalid.
    const zero = new Uint8Array(32);
    await expect(loadLocalSigner(new RawPrivateKeyLoader(zero, "zero-key"))).rejects.toThrow(
      /invalid secp256k1 key/,
    );
  });
});
