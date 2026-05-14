/**
 * Input builder for the COMPLIANCE_MULTI_SIGNED circuit (proof type 0x09).
 *
 * Mirrors `circuits/compliance_multi_signed/src/main.nr` witness layout exactly:
 *   - private: signals[5][8], weights[5][8], weight_sums[5],
 *              pubkey_xs[5][32], pubkey_ys[5][32], signatures[5][64]
 *   - public:  jurisdiction_id, provider_set_hash, config_hash, timestamp,
 *              meets_threshold, threshold_m,
 *              signer_pubkey_hash_0..4 (zero = inactive slot),
 *              chain_id, oracle_address, submitter
 *
 * Inactive-slot padding convention (must match the circuit):
 *   - signer_pubkey_hash_i = 0
 *   - weight_sum_i = 1, weights_i = [1, 0..0], signals_i = [0; 8]
 *     (compute_risk_score divides by weight_sum, so 0 is forbidden)
 *   - pubkey/sig: arbitrary 32/32/64 zero-bytes
 *
 * The caller passes one `MultiSignedSlot | null` per index; this builder
 * produces the witness padding for `null` slots so callers never have to
 * know the convention.
 */

import type { Address } from "viem";
import {
  DEFAULT_CONFIG_HASH,
  MAX_PROVIDERS_MULTI,
  MIN_MULTI_PROVIDER_THRESHOLDS,
} from "../constants.js";
import type { JurisdictionId } from "../constants.js";
import { bytesToHexField } from "../provider/pedersen.js";
import { validateSubmitter, validateTimestamp } from "./validate.js";

const SIGNALS_PER_SLOT = 8;
const ZERO_FIELD_HEX = "0x" + "0".repeat(64);

/**
 * Per-slot signing artifacts. Produced by `signSlotPayload()` in src/provider.
 * Caller orchestrates M independent daemon calls -- each daemon signs ONE slot.
 */
export interface MultiSignedSlot {
  /** Per-provider risk signals (0..100). MUST be length 8 (zero-pad inactive providers within the slot). */
  signals: number[];
  /** Per-provider weights. MUST be length 8. Must sum to a positive value. */
  weights: number[];
  /** 32-byte big-endian secp256k1 public key X coordinate. */
  pubkeyX: Uint8Array;
  /** 32-byte big-endian secp256k1 public key Y coordinate. */
  pubkeyY: Uint8Array;
  /** 64-byte ECDSA signature `r || s`, low-S normalized. */
  signature: Uint8Array;
  /**
   * Pedersen `signer_pubkey_hash` for this slot -- becomes a public input the
   * Oracle validates against `_validSignerPubkeyHashes`. MUST be 32 bytes.
   */
  signerPubkeyHash: Uint8Array;
}

export interface ComplianceMultiSignedInput {
  jurisdictionId: JurisdictionId;
  /** Runtime threshold M in [1, MAX_PROVIDERS_MULTI]. Floor enforced per jurisdiction. */
  thresholdM: number;
  providerSetHash: string;
  configHash?: string;
  timestamp?: string;
  submitter: Address;
  /** EVM chain ID of the consuming Oracle deployment (audit F-6). */
  chainId: bigint | string | number;
  /** Address of the consuming Oracle (audit F-6). */
  oracleAddress: Address;
  /**
   * Length = MAX_PROVIDERS_MULTI (5). Index 0..4 corresponds to the slot
   * position bound into the per-slot signed digest. `null` = inactive slot.
   * The number of non-null entries MUST be >= thresholdM.
   */
  slots: (MultiSignedSlot | null)[];
}

function ensureLen(arr: Uint8Array, expected: number, label: string): Uint8Array {
  if (arr.length !== expected) {
    throw new Error(`${label} must be ${String(expected)} bytes; got ${String(arr.length)}`);
  }
  return arr;
}

function bytesToNumStrings(bytes: Uint8Array): string[] {
  return Array.from(bytes, (b) => String(b));
}

function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

interface SlotWitness {
  signals: string[];
  weights: string[];
  weightSum: string;
  pubkeyX: string[];
  pubkeyY: string[];
  signature: string[];
  /** `ZERO_FIELD_HEX` for inactive slots. */
  signerPubkeyHash: string;
}

/**
 * Inactive-slot witness padding required by the circuit:
 * `weight_sum = 1, weights = [1, 0..0], signals = [0; 8]` so
 * `compute_risk_score` is well-defined; pubkey/sig are zero bytes.
 */
function paddingSlotWitness(): SlotWitness {
  return {
    signals: Array<string>(SIGNALS_PER_SLOT).fill("0"),
    weights: ["1", ...Array<string>(SIGNALS_PER_SLOT - 1).fill("0")],
    weightSum: "1",
    pubkeyX: Array<string>(32).fill("0"),
    pubkeyY: Array<string>(32).fill("0"),
    signature: Array<string>(64).fill("0"),
    signerPubkeyHash: ZERO_FIELD_HEX,
  };
}

function activeSlotWitness(slot: MultiSignedSlot, slotIndex: number): SlotWitness {
  if (slot.signals.length !== SIGNALS_PER_SLOT) {
    throw new Error(
      `slot ${String(slotIndex)}: signals must be length ${String(SIGNALS_PER_SLOT)}; got ${String(slot.signals.length)}`,
    );
  }
  if (slot.weights.length !== SIGNALS_PER_SLOT) {
    throw new Error(
      `slot ${String(slotIndex)}: weights must be length ${String(SIGNALS_PER_SLOT)}; got ${String(slot.weights.length)}`,
    );
  }
  for (let i = 0; i < SIGNALS_PER_SLOT; i++) {
    const s = slot.signals[i];
    if (!Number.isInteger(s) || s < 0 || s > 100) {
      throw new Error(
        `slot ${String(slotIndex)}: signals[${String(i)}] must be an integer in [0, 100]; got ${String(s)}`,
      );
    }
    const w = slot.weights[i];
    if (!Number.isInteger(w) || w < 0) {
      throw new Error(
        `slot ${String(slotIndex)}: weights[${String(i)}] must be a non-negative integer; got ${String(w)}`,
      );
    }
  }
  const weightSum = slot.weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    throw new Error(`slot ${String(slotIndex)}: weight_sum must be > 0`);
  }

  ensureLen(slot.pubkeyX, 32, `slot ${String(slotIndex)} pubkeyX`);
  ensureLen(slot.pubkeyY, 32, `slot ${String(slotIndex)} pubkeyY`);
  ensureLen(slot.signature, 64, `slot ${String(slotIndex)} signature`);
  ensureLen(slot.signerPubkeyHash, 32, `slot ${String(slotIndex)} signerPubkeyHash`);
  if (isAllZero(slot.signerPubkeyHash)) {
    throw new Error(
      `slot ${String(slotIndex)}: active slot signerPubkeyHash is zero (zero = inactive convention)`,
    );
  }

  return {
    signals: slot.signals.map(String),
    weights: slot.weights.map(String),
    weightSum: String(weightSum),
    pubkeyX: bytesToNumStrings(slot.pubkeyX),
    pubkeyY: bytesToNumStrings(slot.pubkeyY),
    signature: bytesToNumStrings(slot.signature),
    signerPubkeyHash: bytesToHexField(slot.signerPubkeyHash),
  };
}

export function buildComplianceMultiSignedInputs(
  opts: ComplianceMultiSignedInput,
): Record<string, unknown> {
  if (opts.slots.length !== MAX_PROVIDERS_MULTI) {
    throw new Error(
      `slots must have length ${String(MAX_PROVIDERS_MULTI)}; got ${String(opts.slots.length)}`,
    );
  }
  if (
    !Number.isInteger(opts.thresholdM) ||
    opts.thresholdM < 1 ||
    opts.thresholdM > MAX_PROVIDERS_MULTI
  ) {
    throw new Error(
      `thresholdM must be an integer in [1, ${String(MAX_PROVIDERS_MULTI)}]; got ${String(opts.thresholdM)}`,
    );
  }
  const floor = MIN_MULTI_PROVIDER_THRESHOLDS[opts.jurisdictionId];
  if (floor === undefined) {
    throw new Error(`Unknown jurisdiction ID: ${String(opts.jurisdictionId)}`);
  }
  if (opts.thresholdM < floor) {
    throw new Error(
      `thresholdM=${String(opts.thresholdM)} below jurisdiction ${String(opts.jurisdictionId)} floor=${String(floor)}`,
    );
  }

  const ts = Number(opts.timestamp ?? String(Math.floor(Date.now() / 1000)));
  validateTimestamp(ts);
  validateSubmitter(opts.submitter);

  const witnesses: SlotWitness[] = opts.slots.map((slot, i) =>
    slot === null ? paddingSlotWitness() : activeSlotWitness(slot, i),
  );

  const dupIdx = witnesses.findIndex(
    (w, i) =>
      w.signerPubkeyHash !== ZERO_FIELD_HEX &&
      witnesses.findIndex((x) => x.signerPubkeyHash === w.signerPubkeyHash) !== i,
  );
  if (dupIdx !== -1) {
    throw new Error(
      `slot ${String(dupIdx)}: duplicate signerPubkeyHash ${witnesses[dupIdx].signerPubkeyHash} across active slots`,
    );
  }

  const activeCount = witnesses.filter((w) => w.signerPubkeyHash !== ZERO_FIELD_HEX).length;
  if (activeCount < opts.thresholdM) {
    throw new Error(
      `Active slots=${String(activeCount)} below thresholdM=${String(opts.thresholdM)}`,
    );
  }

  const signerPubkeyHashes = witnesses.map((w) => w.signerPubkeyHash);
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;

  return {
    // Private witnesses (order matches main.nr signature)
    signals: witnesses.map((w) => w.signals),
    weights: witnesses.map((w) => w.weights),
    weight_sums: witnesses.map((w) => w.weightSum),
    pubkey_xs: witnesses.map((w) => w.pubkeyX),
    pubkey_ys: witnesses.map((w) => w.pubkeyY),
    signatures: witnesses.map((w) => w.signature),

    // Public inputs (order MUST match circuits/compliance_multi_signed/src/main.nr)
    jurisdiction_id: String(opts.jurisdictionId),
    provider_set_hash: opts.providerSetHash,
    config_hash: configHash,
    timestamp: String(ts),
    meets_threshold: "1",
    threshold_m: String(opts.thresholdM),
    signer_pubkey_hash_0: signerPubkeyHashes[0],
    signer_pubkey_hash_1: signerPubkeyHashes[1],
    signer_pubkey_hash_2: signerPubkeyHashes[2],
    signer_pubkey_hash_3: signerPubkeyHashes[3],
    signer_pubkey_hash_4: signerPubkeyHashes[4],
    chain_id: BigInt(opts.chainId).toString(),
    oracle_address: opts.oracleAddress,
    submitter: opts.submitter,
  };
}
