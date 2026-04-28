/**
 * Integration tests -- full prove + verify for all 6 circuit types,
 * tier proofs, encoding round-trips, and BrowserCircuitLoader.
 *
 * Requires Barretenberg (~3min total). Run with:
 *   npm run test:integration
 *
 * Test vectors sourced from erc-xochi-zkp Prover.toml files.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { BundledCircuitLoader } from "../src/circuits.js";
import {
  XochiProver,
  BrowserCircuitLoader,
  encodePublicInputs,
  decodePublicInputs,
  encodeProof,
  PUBLIC_INPUT_COUNTS,
  PROOF_TYPES,
  DEFAULT_CONFIG_HASH,
  generateTierProof,
  verifyTierProof,
} from "../src/index.js";

// ============================================================
// Shared loader + prover (one Barretenberg instance for all tests)
// ============================================================

const loader = new BundledCircuitLoader();
const prover = new XochiProver(loader);

afterAll(async () => {
  await prover.destroy();
});

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";

// Matches submitter="0xdead" in circuits/*/Prover.toml so the integration tests can
// re-use the regenerated fixture merkle roots without recomputing them in JS.
const SUBMITTER = "0x000000000000000000000000000000000000dEaD" as Address;

// ============================================================
// Risk Score (already in prover.test.ts, included here for completeness)
// ============================================================

describe("risk_score proof", () => {
  it("generates and verifies a threshold proof", async () => {
    const result = await prover.proveRiskScore({
      type: "threshold",
      score: 60,
      threshold: 5000,
      direction: "gt",
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.RISK_SCORE]);
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);
    expect(result.publicInputsHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("risk_score", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });

  it("generates and verifies a range proof", async () => {
    const result = await prover.proveRiskScore({
      type: "range",
      score: 50,
      lowerBound: 4000,
      upperBound: 7000,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.RISK_SCORE]);

    const valid = await prover.verify("risk_score", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });
});

// ============================================================
// Compliance
// ============================================================

describe("compliance proof", () => {
  it("generates and verifies an EU compliance proof", async () => {
    const result = await prover.proveCompliance({
      score: 25,
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.COMPLIANCE]);

    const valid = await prover.verify("compliance", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });

  // Drift detector: DEFAULT_CONFIG_HASH must equal pedersen_hash([100, 0, 0, 0, 0, 0, 0, 0])
  // as computed by the circuit in single-provider mode. If providers.nr changes the hash
  // function or the canonical single-provider weight vector, this test catches it
  // before downstream consumers silently break.
  it("DEFAULT_CONFIG_HASH matches the circuit-computed config_hash", async () => {
    const result = await prover.proveCompliance({
      score: 25,
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    // Public input order for compliance: [jurisdiction_id, provider_set_hash,
    // config_hash, timestamp, meets_threshold, submitter]
    const configHashInput = result.publicInputs[2];

    const normalize = (s: string) => {
      const hex = s.startsWith("0x") ? s.slice(2) : s;
      return ("0x" + hex.padStart(64, "0").toLowerCase()) as `0x${string}`;
    };

    expect(normalize(configHashInput)).toBe(normalize(DEFAULT_CONFIG_HASH));
  });
});

// ============================================================
// Pattern (test vector from erc-xochi-zkp/circuits/pattern/Prover.toml)
// ============================================================

describe("pattern proof", () => {
  it("generates and verifies a structuring analysis proof", async () => {
    const result = await prover.provePattern({
      amounts: [500, 1200, 3000, 7500],
      timestamps: [1700000000, 1700001000, 1700002000, 1700003000],
      numTransactions: 4,
      analysisType: 1,
      reportingThreshold: 10000,
      timeWindow: 86400,
      txSetHash: "0x2231d26d52515af30cbb6e91834cdb9e3d1d36575f160cbb4f6ebbb3c3dd8dad",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.PATTERN]);
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("pattern", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });
});

// ============================================================
// Attestation (test vector from erc-xochi-zkp/circuits/attestation/Prover.toml)
// ============================================================

describe("attestation proof", () => {
  it("generates and verifies a KYC attestation proof (post C-1: credentials tree)", async () => {
    // Test vector matches erc-xochi-zkp/circuits/attestation/Prover.toml
    // with submitter=0xdead, provider 42, KYC basic, attribute=999, expiry=2000000000
    const result = await prover.proveAttestation({
      credentialAttribute: "999",
      expiryTimestamp: 2000000000,
      merkleIndex: "0",
      merklePath: Array(20).fill("0"),
      providerId: "42",
      credentialType: 1,
      credentialRoot: "0x24ce58f9ed6ca066d25f66b15b0eb1dccebe6e457f5aa0fcd353d82d539f5ed5",
      currentTimestamp: 1700000000,
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.ATTESTATION]);
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("attestation", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });
});

// ============================================================
// Membership (test vector from erc-xochi-zkp/circuits/membership/Prover.toml)
// ============================================================

describe("membership proof", () => {
  it("generates and verifies a Merkle inclusion proof (post H-3: subject-bound)", async () => {
    // Test vector matches circuits/membership/Prover.toml: submitter=0xdead, salt=0, set 1.
    const result = await prover.proveMembership({
      subjectSalt: "0",
      merkleIndex: "0",
      merklePath: Array(20).fill("0"),
      merkleRoot: "0x1d7de002251083fdc312a329d46abde0680cbccc27935c33815c18b1beb3da8c",
      setId: "1",
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.MEMBERSHIP]);
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("membership", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });
});

// ============================================================
// Non-Membership (test vector from erc-xochi-zkp/circuits/non_membership/Prover.toml)
// ============================================================

describe("non_membership proof", () => {
  it("generates and verifies a sorted Merkle adjacency proof (post H-3 + M-2 + H-4)", async () => {
    // Test vector matches circuits/non_membership/Prover.toml:
    // submitter=0xdead is bracketed by low=0x100 and high=0x10000, indices 0/1.
    const result = await prover.proveNonMembership({
      lowLeaf: "0x100",
      lowLeafSalt: "0",
      highLeaf: "0x10000",
      highLeafSalt: "0",
      lowIndex: "0",
      lowPath: [
        "0x2e3a62a21fa1706df17be5649ad62e45a4dbdbe9a9ce3923058d940cdc6b929d",
        ...Array(19).fill("0"),
      ],
      highIndex: "1",
      highPath: [
        "0x0c57a3ac2ba9abef99b6ab714e307311687782f270b6517717e181e5cd50cce5",
        ...Array(19).fill("0"),
      ],
      merkleRoot: "0x138f818fd4f2eec91e4fd93e14bcc47bc06a3ba333e5a2e7795d0beb752d247c",
      setId: "1",
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(PUBLIC_INPUT_COUNTS[PROOF_TYPES.NON_MEMBERSHIP]);
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("non_membership", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });
});

// ============================================================
// Tier Proof (generate + verify round-trip)
// ============================================================

describe("tier proof", () => {
  it("generates and verifies a Verified tier proof (score 60, threshold 50)", async () => {
    const tierProof = await generateTierProof(loader, 60, 50, SUBMITTER);

    expect(tierProof.tierName).toBe("Verified");
    expect(tierProof.threshold).toBe(50);
    expect(tierProof.proof).toBeInstanceOf(Uint8Array);
    expect(tierProof.proofHex).toMatch(/^0x[0-9a-f]+$/);
    expect(tierProof.expiresAt).toBeGreaterThan(Date.now());

    const verification = await verifyTierProof(loader, tierProof);
    expect(verification.valid).toBe(true);
    expect(verification.tierName).toBe("Verified");
    expect(verification.feeRate).toBe(0.2);
  });
});

// ============================================================
// Encoding round-trip with real proof data
// ============================================================

describe("encoding round-trip", () => {
  it("encode -> decode public inputs preserves values", async () => {
    const result = await prover.proveRiskScore({
      type: "threshold",
      score: 60,
      threshold: 5000,
      direction: "gt",
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    const encoded = encodePublicInputs(result.publicInputs);
    const decoded = decodePublicInputs(encoded);

    // Decoded values should match original when both are normalized to 0x + 64 hex chars
    const normalize = (s: string) => {
      const hex = s.startsWith("0x") ? s.slice(2) : s;
      return "0x" + hex.padStart(64, "0");
    };

    expect(decoded).toHaveLength(result.publicInputs.length);
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]).toBe(normalize(result.publicInputs[i]));
    }
  });

  it("encodeProof produces valid hex from real proof bytes", async () => {
    const result = await prover.proveCompliance({
      score: 25,
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    const hex = encodeProof(result.proof);
    expect(hex).toMatch(/^0x[0-9a-f]+$/);
    // Proof hex length should be 2 (0x) + 2 * proof byte length
    expect(hex.length).toBe(2 + result.proof.length * 2);
  });
});

// ============================================================
// BrowserCircuitLoader (local HTTP server)
// ============================================================

describe("BrowserCircuitLoader", () => {
  let server: Server;
  let port: number;

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("loads a circuit via HTTP fetch", async () => {
    const circuitsDir = resolve(new URL(".", import.meta.url).pathname, "../circuits");

    server = createServer((req, res) => {
      const name = req.url?.replace("/", "") ?? "";
      try {
        const data = readFileSync(resolve(circuitsDir, name), "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to get server address");
    port = addr.port;

    const browserLoader = new BrowserCircuitLoader(`http://localhost:${String(port)}`);
    const circuit = await browserLoader.load("compliance");

    expect(circuit.bytecode).toBeDefined();
    expect(typeof circuit.bytecode).toBe("string");
    expect(circuit.bytecode.length).toBeGreaterThan(0);
  });
});
