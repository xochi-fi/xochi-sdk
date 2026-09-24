/**
 * OracleLite -- lightweight oracle client using raw fetch + ABI encoding.
 *
 * Runs anywhere (Cloudflare Workers, Node.js, browser) without viem.
 * Ported from xochi/workers/counter/src/oracle.ts.
 */

import type { ProofType, JurisdictionId } from "./constants.js";
import { COMPLIANCE_PROOF_TYPES, JURISDICTIONS } from "./constants.js";

// ============================================================
// Types
// ============================================================

export interface OracleLiteConfig {
  /** Oracle contract address (0x-prefixed) */
  address: string;
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /** Timeout applied to every eth_call, in milliseconds (default 15000). */
  timeoutMs?: number;
}

export interface CheckComplianceOptions {
  /**
   * Proof types whose attestation counts as compliance. Defaults to
   * {@link COMPLIANCE_PROOF_TYPES} (0x01, 0x07, 0x09). Must be non-empty.
   */
  acceptedProofTypes?: readonly number[];
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
  /**
   * The Oracle reports a live (existing, unexpired) attestation AND its proof
   * type is one of the accepted compliance types. See COMPLIANCE_PROOF_TYPES for
   * why the on-chain flag alone is not a compliance verdict.
   */
  valid: boolean;
  /** Latest attestation for (subject, jurisdiction), or null when none exists. */
  attestation: ComplianceAttestationLite | null;
  source: "on-chain";
}

export interface ProofVerificationResult {
  /**
   * The simulated `submitCompliance` succeeded (the on-chain verifier accepted
   * the proof and the Oracle's public-input validation passed) and the returned
   * attestation is bound to the requested subject, jurisdiction and proof type.
   *
   * This is NOT a compliance verdict and says nothing about WHAT was proven: the
   * Oracle attests any positive proof of any type. Read the claim from
   * `publicInputs` (e.g. `decodeTierProofClaim` for tier proofs).
   */
  valid: boolean;
  attestation: ComplianceAttestationLite | null;
  /**
   * The verified public inputs, one 0x-prefixed 32-byte word per field in
   * circuit order (see PUBLIC_INPUT_COUNTS). Null when the supplied
   * `publicInputs` hex was malformed.
   */
  publicInputs: string[] | null;
  error?: string;
}

// ============================================================
// OracleLite Client
// ============================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_HEX = 64;
const ATTESTATION_WORDS = 10;

// keccak256 selectors (verified against viem.toFunctionSelector in the tests)
const SELECTOR_CHECK_COMPLIANCE = "0xd1e8eba9"; // checkCompliance(address,uint8)
const SELECTOR_CHECK_COMPLIANCE_BY_TYPE = "0x0916d812"; // checkComplianceByType(address,uint8,uint8)
const SELECTOR_SUBMIT_COMPLIANCE = "0xf33bc62b"; // submitCompliance(uint8,uint8,bytes,bytes,bytes32)

export class OracleLite {
  private readonly timeoutMs: number;

  constructor(private config: OracleLiteConfig) {
    assertAddress(config.address, "config.address");
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `OracleLite: config.timeoutMs must be a positive integer, got ${String(timeoutMs)}`,
      );
    }
    this.timeoutMs = timeoutMs;
  }

  /**
   * Check on-chain compliance status for a wallet via checkCompliance(address,uint8).
   *
   * `valid` is true only when the Oracle reports a live attestation whose proof
   * type is in `options.acceptedProofTypes` (default COMPLIANCE_PROOF_TYPES).
   * Returns null when the eth_call returns no data (no contract at the address).
   */
  async checkCompliance(
    wallet: string,
    jurisdictionId: JurisdictionId = JURISDICTIONS.EU,
    options: CheckComplianceOptions = {},
  ): Promise<ComplianceCheckResult | null> {
    const accepted: readonly number[] = options.acceptedProofTypes ?? COMPLIANCE_PROOF_TYPES;
    if (accepted.length === 0) {
      throw new Error("OracleLite.checkCompliance: acceptedProofTypes must not be empty");
    }
    const result = await this.queryAttestation(
      "checkCompliance",
      SELECTOR_CHECK_COMPLIANCE,
      wallet,
      jurisdictionId,
    );
    if (!result) return null;
    const valid =
      result.onChainValid &&
      result.attestation !== null &&
      accepted.includes(result.attestation.proofType);
    return { valid, attestation: result.attestation, source: "on-chain" };
  }

  /**
   * Check on-chain status for one proof type via
   * checkComplianceByType(address,uint8,uint8). `valid` is the Oracle's answer:
   * a live attestation of exactly `proofType` (whatever that type proves). The
   * returned attestation is the latest for (subject, jurisdiction) and may be
   * of another type. Returns null when the eth_call returns no data.
   */
  async checkComplianceByType(
    wallet: string,
    jurisdictionId: JurisdictionId,
    proofType: ProofType,
  ): Promise<ComplianceCheckResult | null> {
    assertUint8(proofType, "proofType");
    const result = await this.queryAttestation(
      "checkComplianceByType",
      SELECTOR_CHECK_COMPLIANCE_BY_TYPE,
      wallet,
      jurisdictionId,
      proofType,
    );
    if (!result) return null;
    const valid =
      result.onChainValid &&
      result.attestation !== null &&
      result.attestation.proofType === proofType;
    return { valid, attestation: result.attestation, source: "on-chain" };
  }

  /**
   * Verify a ZK proof by simulating submitCompliance() via eth_call.
   *
   * Runs the on-chain UltraHonk verifier without gas. The `from` field
   * is set to `wallet` because the oracle uses msg.sender as subject.
   *
   * Throws on an invalid `wallet`, `proofType` or `jurisdictionId` (caller
   * error). Every failure of the evidence itself (malformed hex, revert, RPC
   * failure, attestation not bound to the request) returns `valid: false` with
   * `error` set.
   */
  async verifyProof(
    wallet: string,
    proofType: ProofType,
    proof: string,
    publicInputs: string,
    providerSetHash: string = "0x" + "0".repeat(64),
    jurisdictionId: JurisdictionId = JURISDICTIONS.EU,
  ): Promise<ProofVerificationResult> {
    assertAddress(wallet, "wallet");
    assertUint8(proofType, "proofType");
    assertUint8(jurisdictionId, "jurisdictionId");

    const decodedInputs = splitWords(publicInputs);
    let data: string;
    try {
      data = encodeSubmitCompliance(
        jurisdictionId,
        proofType,
        proof,
        publicInputs,
        providerSetHash,
      );
    } catch (err) {
      return {
        valid: false,
        attestation: null,
        publicInputs: decodedInputs,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let result: string | null;
    try {
      result = await this.ethCall({ from: wallet, to: this.config.address, data });
    } catch (err) {
      return {
        valid: false,
        attestation: null,
        publicInputs: decodedInputs,
        error: err instanceof Error ? err.message : "RPC request failed",
      };
    }

    if (!result) {
      return {
        valid: false,
        attestation: null,
        publicInputs: decodedInputs,
        error: "Empty result from oracle",
      };
    }

    // submitCompliance returns ComplianceAttestation (static tuple, encoded inline)
    const hex = result.slice(2);
    if (hex.length !== WORD_HEX * ATTESTATION_WORDS) {
      return {
        valid: false,
        attestation: null,
        publicInputs: decodedInputs,
        error: `Malformed submitCompliance result: expected ${String(ATTESTATION_WORDS)} words, got ${String(hex.length / WORD_HEX)}`,
      };
    }
    const attestation = decodeAttestation(hex);

    const mismatch = bindingMismatch(attestation, wallet, jurisdictionId, proofType);
    if (mismatch) {
      return { valid: false, attestation, publicInputs: decodedInputs, error: mismatch };
    }
    return { valid: true, attestation, publicInputs: decodedInputs };
  }

  // ============================================================
  // Private
  // ============================================================

  /**
   * Shared eth_call + decode for checkCompliance / checkComplianceByType.
   * Validates the query, requires the exact `(bool, ComplianceAttestation)`
   * response width, and asserts a present attestation is bound to the queried
   * subject and jurisdiction.
   */
  private async queryAttestation(
    method: string,
    selector: string,
    wallet: string,
    jurisdictionId: number,
    proofType?: number,
  ): Promise<{ onChainValid: boolean; attestation: ComplianceAttestationLite | null } | null> {
    assertAddress(wallet, "wallet");
    assertUint8(jurisdictionId, "jurisdictionId");

    const words = [wallet.slice(2).toLowerCase().padStart(WORD_HEX, "0"), uintWord(jurisdictionId)];
    if (proofType !== undefined) words.push(uintWord(proofType));

    const result = await this.ethCall({ to: this.config.address, data: selector + words.join("") });
    if (!result) return null;

    const hex = result.slice(2);
    if (hex.length !== WORD_HEX * (1 + ATTESTATION_WORDS)) {
      throw new Error(
        `OracleLite.${method}: malformed response, expected ${String(1 + ATTESTATION_WORDS)} words, got ${String(hex.length / WORD_HEX)}`,
      );
    }

    const onChainValid = BigInt(`0x${hex.slice(0, WORD_HEX)}`) !== 0n;
    // Struct with all static fields is encoded inline (no offset pointer)
    const attestation = decodeAttestation(hex.slice(WORD_HEX));

    // The Oracle returns a zeroed struct when no attestation exists.
    if (attestation.timestamp === 0n) {
      if (onChainValid) {
        throw new Error(`OracleLite.${method}: Oracle reported valid with no attestation`);
      }
      return { onChainValid: false, attestation: null };
    }

    // Both queries return the LATEST attestation for (subject, jurisdiction),
    // whatever its type, so only subject and jurisdiction must match.
    const mismatch = bindingMismatch(attestation, wallet, jurisdictionId, undefined);
    if (mismatch) throw new Error(`OracleLite.${method}: ${mismatch}`);

    return { onChainValid, attestation };
  }

  private async ethCall(params: {
    from?: string;
    to: string;
    data: string;
  }): Promise<string | null> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [params, "latest"],
    });

    const response = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${String(response.status)}`);
    }

    const json = (await response.json()) as {
      result?: unknown;
      error?: { message?: string; data?: unknown };
    };

    if (json.error) {
      const data = typeof json.error.data === "string" ? ` (data: ${json.error.data})` : "";
      throw new Error(`${json.error.message ?? "RPC error"}${data}`);
    }

    if (json.result === undefined || json.result === "0x") {
      return null;
    }
    if (typeof json.result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(json.result)) {
      throw new Error(`RPC returned a non-hex eth_call result: ${String(json.result)}`);
    }

    return json.result;
  }
}

// ============================================================
// Validation
// ============================================================

function assertAddress(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(
      `OracleLite: ${name} must be a 0x-prefixed 20-byte hex address, got ${String(value)}`,
    );
  }
}

function assertUint8(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`OracleLite: ${name} must be an integer in [0, 255], got ${String(value)}`);
  }
}

/** Describe how an attestation fails to bind to the request, or null when it binds. */
function bindingMismatch(
  attestation: ComplianceAttestationLite,
  wallet: string,
  jurisdictionId: number,
  proofType: number | undefined,
): string | null {
  if (attestation.subject.toLowerCase() !== wallet.toLowerCase()) {
    return `attestation subject ${attestation.subject} does not match wallet ${wallet}`;
  }
  if (attestation.jurisdictionId !== jurisdictionId) {
    return `attestation jurisdiction ${String(attestation.jurisdictionId)} does not match requested ${String(jurisdictionId)}`;
  }
  if (proofType !== undefined && attestation.proofType !== proofType) {
    return `attestation proofType ${String(attestation.proofType)} does not match requested ${String(proofType)}`;
  }
  return null;
}

// ============================================================
// ABI Encoding
// ============================================================

function uintWord(value: number): string {
  return value.toString(16).padStart(WORD_HEX, "0");
}

function stripHex(value: string, name: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`${name} must be even-length hex, got ${value.slice(0, 20)}...`);
  }
  return hex;
}

/** Split public-inputs hex into 32-byte words, or null when it is not word-aligned hex. */
function splitWords(publicInputs: string): string[] | null {
  const hex = publicInputs.startsWith("0x") ? publicInputs.slice(2) : publicInputs;
  if (!/^([0-9a-fA-F]{64})*$/.test(hex)) return null;
  const words: string[] = [];
  for (let i = 0; i < hex.length; i += WORD_HEX) {
    words.push(`0x${hex.slice(i, i + WORD_HEX).toLowerCase()}`);
  }
  return words;
}

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
  const proofHex = stripHex(proof, "proof");
  const piHex = stripHex(publicInputs, "publicInputs");
  if (piHex.length % WORD_HEX !== 0) {
    throw new Error(
      `publicInputs must be a whole number of 32-byte words, got ${String(piHex.length / 2)} bytes`,
    );
  }
  const hashHex = stripHex(providerSetHash, "providerSetHash");
  if (hashHex.length !== WORD_HEX) {
    throw new Error(`providerSetHash must be 32 bytes, got ${String(hashHex.length / 2)}`);
  }

  // Head: 5 slots (jurisdictionId, proofType, offset_proof, offset_pi, providerSetHash)
  const headSize = 5 * 32; // 160 bytes

  // Proof bytes
  const proofBytes = proofHex.length / 2;
  const proofPadded = proofHex.padEnd(Math.ceil(proofHex.length / WORD_HEX) * WORD_HEX, "0");

  // Public inputs bytes (already word-aligned)
  const piBytes = piHex.length / 2;

  // Offsets (bytes from start of params)
  const proofOffset = headSize;
  const piOffset = proofOffset + 32 + proofPadded.length / 2;

  const head = [
    uintWord(jurisdictionId),
    uintWord(proofType),
    uintWord(proofOffset),
    uintWord(piOffset),
    hashHex,
  ].join("");

  const tail = uintWord(proofBytes) + proofPadded + uintWord(piBytes) + piHex;

  return SELECTOR_SUBMIT_COMPLIANCE + head + tail;
}

// ============================================================
// ABI Decoding
// ============================================================

/** Decode the 10-word static ComplianceAttestation tuple. Caller checks the width. */
function decodeAttestation(hex: string): ComplianceAttestationLite {
  const word = (i: number): string => hex.slice(i * WORD_HEX, (i + 1) * WORD_HEX);
  return {
    subject: `0x${word(0).slice(24)}`,
    jurisdictionId: Number(BigInt(`0x${word(1)}`)),
    proofType: Number(BigInt(`0x${word(2)}`)),
    meetsThreshold: BigInt(`0x${word(3)}`) !== 0n,
    timestamp: BigInt(`0x${word(4)}`),
    expiresAt: BigInt(`0x${word(5)}`),
    proofHash: `0x${word(6)}`,
    providerSetHash: `0x${word(7)}`,
    publicInputsHash: `0x${word(8)}`,
    verifierUsed: `0x${word(9).slice(24)}`,
  };
}
