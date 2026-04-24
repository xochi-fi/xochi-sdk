/**
 * OracleLite -- lightweight oracle client using raw fetch + ABI encoding.
 *
 * Runs anywhere (Cloudflare Workers, Node.js, browser) without viem.
 * Ported from xochi/workers/counter/src/oracle.ts.
 */

import type { ProofType, JurisdictionId } from "./constants.js";
import { JURISDICTIONS } from "./constants.js";

// ============================================================
// Types
// ============================================================

export interface OracleLiteConfig {
  /** Oracle contract address (0x-prefixed) */
  address: string;
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
}

export interface ComplianceAttestationLite {
  subject: string;
  jurisdictionId: number;
  proofType: number;
  meetsThreshold: boolean;
  timestamp: bigint;
  expiresAt: bigint;
  proofHash: string;
  providerSetHash: string;
  publicInputsHash: string;
  verifierUsed: string;
}

export interface ComplianceCheckResult {
  valid: boolean;
  attestation: ComplianceAttestationLite | null;
  source: "on-chain";
}

export interface ProofVerificationResult {
  valid: boolean;
  attestation: ComplianceAttestationLite | null;
  error?: string;
}

// ============================================================
// OracleLite Client
// ============================================================

export class OracleLite {
  constructor(private config: OracleLiteConfig) {}

  /**
   * Check on-chain compliance status for a wallet.
   * Encodes checkCompliance(address,uint8) as eth_call.
   */
  async checkCompliance(
    wallet: string,
    jurisdictionId: JurisdictionId = JURISDICTIONS.EU,
  ): Promise<ComplianceCheckResult | null> {
    // selector: keccak256("checkCompliance(address,uint8)") = 0xd1e8eba9
    const selector = "0xd1e8eba9";
    const paddedAddress = wallet.slice(2).toLowerCase().padStart(64, "0");
    const paddedJurisdiction = jurisdictionId.toString(16).padStart(64, "0");
    const data = `${selector}${paddedAddress}${paddedJurisdiction}`;

    const result = await this.ethCall({ to: this.config.address, data });
    if (!result) return null;

    const hex = result.slice(2);
    if (hex.length < 64) {
      return { valid: false, attestation: null, source: "on-chain" };
    }

    const valid = BigInt(`0x${hex.slice(0, 64)}`) !== 0n;
    // Struct with all static fields is encoded inline (no offset pointer)
    const attestation = decodeAttestation(hex.slice(64));

    return { valid, attestation, source: "on-chain" };
  }

  /**
   * Verify a ZK proof by simulating submitCompliance() via eth_call.
   *
   * Runs the on-chain UltraHonk verifier without gas. The `from` field
   * is set to `wallet` because the oracle uses msg.sender as subject.
   */
  async verifyProof(
    wallet: string,
    proofType: ProofType,
    proof: string,
    publicInputs: string,
    providerSetHash: string = "0x" + "0".repeat(64),
    jurisdictionId: JurisdictionId = JURISDICTIONS.EU,
  ): Promise<ProofVerificationResult> {
    const data = encodeSubmitCompliance(
      jurisdictionId,
      proofType,
      proof,
      publicInputs,
      providerSetHash,
    );

    let result: string | null;
    try {
      result = await this.ethCall({ from: wallet, to: this.config.address, data }, 15_000);
    } catch (err) {
      return {
        valid: false,
        attestation: null,
        error: err instanceof Error ? err.message : "RPC request failed",
      };
    }

    if (!result) {
      return { valid: false, attestation: null, error: "Empty result from oracle" };
    }

    const hex = result.slice(2);
    if (hex.length < 64) {
      return { valid: false, attestation: null, error: "Response too short" };
    }

    // submitCompliance returns ComplianceAttestation (static tuple, encoded inline)
    const attestation = decodeAttestation(hex);

    if (!attestation) {
      return { valid: false, attestation: null, error: "Failed to decode attestation" };
    }

    return { valid: attestation.meetsThreshold, attestation };
  }

  // ============================================================
  // Private
  // ============================================================

  private async ethCall(
    params: { from?: string; to: string; data: string },
    timeoutMs?: number,
  ): Promise<string | null> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [params, "latest"],
    });

    const fetchOpts: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };

    if (timeoutMs) {
      fetchOpts.signal = AbortSignal.timeout(timeoutMs);
    }

    const response = await fetch(this.config.rpcUrl, fetchOpts);

    if (!response.ok) {
      throw new Error(`RPC HTTP ${String(response.status)}`);
    }

    const json = (await response.json()) as {
      result?: string;
      error?: { message: string };
    };

    if (json.error) {
      throw new Error(json.error.message);
    }

    if (!json.result || json.result === "0x") {
      return null;
    }

    return json.result;
  }
}

// ============================================================
// ABI Encoding
// ============================================================

/**
 * ABI-encode submitCompliance(uint8,uint8,bytes,bytes,bytes32).
 */
function encodeSubmitCompliance(
  jurisdictionId: number,
  proofType: ProofType,
  proof: string,
  publicInputs: string,
  providerSetHash: string,
): string {
  // selector: keccak256("submitCompliance(uint8,uint8,bytes,bytes,bytes32)")
  const selector = "0xf33bc62b";

  const proofHex = proof.startsWith("0x") ? proof.slice(2) : proof;
  const piHex = publicInputs.startsWith("0x") ? publicInputs.slice(2) : publicInputs;
  const hashHex = (
    providerSetHash.startsWith("0x") ? providerSetHash.slice(2) : providerSetHash
  ).padStart(64, "0");

  // Head: 5 slots (jurisdictionId, proofType, offset_proof, offset_pi, providerSetHash)
  const headSize = 5 * 32; // 160 bytes

  // Proof bytes
  const proofBytes = Math.ceil(proofHex.length / 2);
  const proofLenHex = proofBytes.toString(16).padStart(64, "0");
  const proofPadded = proofHex.padEnd(Math.ceil(proofHex.length / 64) * 64, "0");

  // Public inputs bytes
  const piBytes = Math.ceil(piHex.length / 2);
  const piLenHex = piBytes.toString(16).padStart(64, "0");
  const piPadded = piHex.padEnd(Math.ceil(piHex.length / 64) * 64, "0");

  // Offsets (bytes from start of params)
  const proofOffset = headSize;
  const piOffset = proofOffset + 32 + Math.ceil(proofHex.length / 64) * 32;

  const head = [
    jurisdictionId.toString(16).padStart(64, "0"),
    proofType.toString(16).padStart(64, "0"),
    proofOffset.toString(16).padStart(64, "0"),
    piOffset.toString(16).padStart(64, "0"),
    hashHex,
  ].join("");

  const tail = proofLenHex + proofPadded + piLenHex + piPadded;

  return selector + head + tail;
}

// ============================================================
// ABI Decoding
// ============================================================

function decodeAttestation(hex: string): ComplianceAttestationLite | null {
  // 10 fields x 32 bytes = 640 hex chars minimum
  if (hex.length < 64 * 10) return null;

  return {
    subject: `0x${hex.slice(24, 64)}`,
    jurisdictionId: Number(BigInt(`0x${hex.slice(64, 128)}`)),
    proofType: Number(BigInt(`0x${hex.slice(128, 192)}`)),
    meetsThreshold: BigInt(`0x${hex.slice(192, 256)}`) !== 0n,
    timestamp: BigInt(`0x${hex.slice(256, 320)}`),
    expiresAt: BigInt(`0x${hex.slice(320, 384)}`),
    proofHash: `0x${hex.slice(384, 448)}`,
    providerSetHash: `0x${hex.slice(448, 512)}`,
    publicInputsHash: `0x${hex.slice(512, 576)}`,
    verifierUsed: `0x${hex.slice(600, 640)}`,
  };
}
