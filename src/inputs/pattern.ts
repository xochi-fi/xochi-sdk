import type { Address } from "viem";
import { PATTERN_TIME_WINDOW_MIN, PATTERN_TIME_WINDOW_MAX } from "../constants.js";
import { validateReportingThreshold, validateSubmitter, validateTimestamp } from "./validate.js";

/** Pattern analysis identifiers (must match circuits/pattern). */
export const PATTERN_STRUCTURING = 1;
export const PATTERN_VELOCITY = 2;
export const PATTERN_ROUND_AMOUNT = 3;

export interface PatternInput {
  amounts: number[];
  timestamps: number[];
  numTransactions: number;
  /**
   * Analysis kind: 1 = STRUCTURING (anti-structuring), 2 = VELOCITY, 3 = ROUND_AMOUNT.
   *
   * Note: SettlementRegistry.finalizeTrade requires `analysisType === 1`
   * (audit fix H-2). VELOCITY and ROUND_AMOUNT proofs are valid for general
   * Oracle submission but are rejected by the settlement registry's
   * anti-structuring guard.
   */
  analysisType: typeof PATTERN_STRUCTURING | typeof PATTERN_VELOCITY | typeof PATTERN_ROUND_AMOUNT;
  reportingThreshold: number;
  timeWindow: number;
  txSetHash: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export function buildPatternInputs(opts: PatternInput): Record<string, string | string[]> {
  if (opts.amounts.length > 16 || opts.timestamps.length > 16) {
    throw new Error("Max 16 transactions supported");
  }

  // Defensive runtime check: H-2 enforces this on-chain too, but failing fast
  // off-chain saves a wasted proof generation if a TS caller bypasses the type.
  if (
    opts.analysisType !== PATTERN_STRUCTURING &&
    opts.analysisType !== PATTERN_VELOCITY &&
    opts.analysisType !== PATTERN_ROUND_AMOUNT
  ) {
    throw new Error(
      `Invalid analysisType ${String(opts.analysisType)}; must be 1 (STRUCTURING), 2 (VELOCITY), or 3 (ROUND_AMOUNT)`,
    );
  }

  validateReportingThreshold(opts.reportingThreshold);
  validateSubmitter(opts.submitter);

  if (opts.timeWindow < PATTERN_TIME_WINDOW_MIN) {
    throw new Error(
      `time_window ${String(opts.timeWindow)} below minimum ${String(PATTERN_TIME_WINDOW_MIN)}s (24h)`,
    );
  }
  if (opts.timeWindow > PATTERN_TIME_WINDOW_MAX) {
    throw new Error(
      `time_window ${String(opts.timeWindow)} exceeds maximum ${String(PATTERN_TIME_WINDOW_MAX)}s (90d)`,
    );
  }

  for (let i = 0; i < opts.numTransactions; i++) {
    if (opts.amounts[i] <= 0) {
      throw new Error(`Amount[${String(i)}] must be > 0 for active transaction`);
    }
    if (opts.timestamps[i] <= 0) {
      throw new Error(`Timestamp[${String(i)}] must be > 0 for active transaction`);
    }
  }

  // Pad to 16 elements
  const amounts = [...opts.amounts];
  const timestamps = [...opts.timestamps];
  while (amounts.length < 16) amounts.push(0);
  while (timestamps.length < 16) timestamps.push(0);

  return {
    amounts: amounts.map(String),
    timestamps: timestamps.map(String),
    num_transactions: String(opts.numTransactions),
    analysis_type: String(opts.analysisType),
    result: "1",
    reporting_threshold: String(opts.reportingThreshold),
    time_window: String(opts.timeWindow),
    tx_set_hash: opts.txSetHash,
    submitter: opts.submitter,
  };
}
