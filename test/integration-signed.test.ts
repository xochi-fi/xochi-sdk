/**
 * Integration: provider signing -> COMPLIANCE_SIGNED proof -> off-chain verify.
 *
 * End-to-end exercise of the provider-signed signals path:
 *   1. Load a fixed test secp256k1 key
 *   2. Sign a screening-signal bundle via the provider helpers
 *   3. Generate a COMPLIANCE_SIGNED proof using the signed bundle
 *   4. Verify the proof off-chain via UltraHonk (in-circuit signature
 *      verification is what binds steps 2 and 3 together)
 *
 * If this passes, the off-chain Pedersen + ECDSA flow exactly matches what
 * the in-circuit verifier expects -- the contract that the signer module
 * promises to providers.
 *
 * Requires Barretenberg (~30s).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Address } from "viem";
import { Barretenberg } from "@aztec/bb.js";
import { BundledCircuitLoader } from "../src/circuits.js";
import { XochiProver, PUBLIC_INPUT_COUNTS, PROOF_TYPES } from "../src/index.js";
import { RawKeyLoader, loadSignerKey, signSignals, type SignerKey } from "../src/provider/index.js";

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const SUBMITTER = "0x000000000000000000000000000000000000dEaD" as Address;
const TIMESTAMP = 1700000000n;

// Fixed test private key (NOT a secret).
const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20

let api: Barretenberg;
let signerKey: SignerKey;
const loader = new BundledCircuitLoader();
const prover = new XochiProver(loader);

beforeAll(async () => {
  api = await Barretenberg.new();
  signerKey = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "integration-signed"));
}, 60_000);

afterAll(async () => {
  await prover.destroy();
  await api.destroy();
});

describe("compliance_signed end-to-end", () => {
  it("signs a payload, generates a proof, and verifies it", async () => {
    // The signer needs the same payload values the circuit will compute its
    // digest from. signals/weights match the single-provider Prover.toml that
    // pinned PROVIDER_SET_HASH, score=25 stays under EU's 7100 bps threshold.
    const signed = await signSignals(api, signerKey, {
      providerSetHash: BigInt(PROVIDER_SET_HASH),
      signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      timestamp: TIMESTAMP,
      submitter: BigInt(SUBMITTER),
    });

    expect(signed.signature.length).toBe(64);
    expect(signed.signerPubkeyHash.length).toBe(32);

    const result = await prover.proveComplianceSigned({
      score: 25,
      jurisdictionId: 0, // EU
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      timestamp: TIMESTAMP.toString(),
      signedBundle: signed,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.COMPLIANCE_SIGNED]);

    const valid = await prover.verify("compliance_signed", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  }, 180_000);

  it("rejects a proof when signature is over a different payload", async () => {
    // Sign payload A, then try to use that signature with payload B inputs.
    // Witness generation should fail in the in-circuit ECDSA verify.
    const signed = await signSignals(api, signerKey, {
      providerSetHash: BigInt(PROVIDER_SET_HASH),
      signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      timestamp: TIMESTAMP,
      submitter: BigInt(SUBMITTER),
    });

    // Same signed bundle but submit with score=20 -- different signals_hash,
    // signature won't verify against the recomputed in-circuit digest.
    await expect(
      prover.proveComplianceSigned({
        score: 20,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        timestamp: TIMESTAMP.toString(),
        signedBundle: signed,
      }),
    ).rejects.toThrow();
  }, 180_000);
});

describe("risk_score_signed end-to-end", () => {
  it("signs and proves a threshold/GT claim", async () => {
    const signed = await signSignals(api, signerKey, {
      providerSetHash: BigInt(PROVIDER_SET_HASH),
      signals: [60n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
      timestamp: TIMESTAMP,
      submitter: BigInt(SUBMITTER),
    });

    const result = await prover.proveRiskScoreSigned({
      type: "threshold",
      direction: "gt",
      threshold: 5000,
      score: 60,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      signedTimestamp: TIMESTAMP.toString(),
      signedBundle: signed,
    });

    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.RISK_SCORE_SIGNED]);

    const valid = await prover.verify("risk_score_signed", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  }, 180_000);
});
