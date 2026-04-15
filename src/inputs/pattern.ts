import { PATTERN_TIME_WINDOW_MIN, PATTERN_TIME_WINDOW_MAX } from "../constants.js";
import { validateReportingThreshold, validateTimestamp } from "./validate.js";

export interface PatternInput {
  amounts: number[];
  timestamps: number[];
  numTransactions: number;
  analysisType: 1 | 2 | 3; // 1=structuring, 2=velocity, 3=round amounts
  reportingThreshold: number;
  timeWindow: number;
  txSetHash: string;
}

export function buildPatternInputs(opts: PatternInput): Record<string, string | string[]> {
  if (opts.amounts.length > 16 || opts.timestamps.length > 16) {
    throw new Error("Max 16 transactions supported");
  }

  validateReportingThreshold(opts.reportingThreshold);

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
  };
}
