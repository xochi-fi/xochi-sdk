import type { Address } from "viem";
import { PATTERN_TIME_WINDOW_MIN, PATTERN_TIME_WINDOW_MAX } from "../constants.js";
import { validateReportingThreshold, validateSubmitter, validateTimestamp } from "./validate.js";

/** Pattern analysis identifiers (must match circuits/pattern). */
export const PATTERN_STRUCTURING = 1;
export const PATTERN_VELOCITY = 2;
export const PATTERN_ROUND_AMOUNT = 3;

/**
 * `buildPatternInputs` / `provePattern` refused before proving: the explicit
 * `timestamp` is before `notBefore` (the trade's `createdAt`), so
 * `SettlementRegistry.finalizeTrade` would revert `PatternProofPredatesTrade`
 * after the Oracle had consumed the proof. Client-side; the contract's revert
 * decodes to `PatternProofPredatesTradeError`.
 */
export class PatternTimestampPredatesTradeError extends Error {
  constructor(
    /** The explicit proof timestamp (unix seconds). */
    readonly proofTimestamp: bigint,
    /** The earliest allowed proof timestamp (unix seconds). */
    readonly notBefore: bigint,
  ) {
    super(
      `PATTERN proof timestamp ${String(proofTimestamp)} predates notBefore ${String(notBefore)}: finalizeTrade would revert PatternProofPredatesTrade. Date it at or after the trade's createdAt, or omit timestamp to stamp max(default, notBefore).`,
    );
    this.name = "PatternTimestampPredatesTradeError";
  }
}

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
  /**
   * Audit H-1: opaque declarative binding to a downstream settlement.
   *
   * The Oracle does not validate this (it's transparent on `submitCompliance`),
   * but `SettlementRegistry.finalizeTrade` enforces
   * `settlement_root == computeSettlementRoot(tradeId)` -- a `bytes32(uint256(...) % BN254_FR_MODULUS)`
   * reduction of `keccak256(abi.encode(subTradeCount, proofHashes))`.
   *
   * For PATTERN proofs that are NOT used for a SettlementRegistry finalization,
   * pass `"0x" + "0".repeat(64)`. For finalizing trades, call
   * `SettlementRegistryClient.computeSettlementRoot(tradeId)` BEFORE generating
   * the proof and pass that value here.
   */
  settlementRoot: string;
  /**
   * Proof timestamp (unix seconds, default the local clock), not a transaction
   * time. Public input 7, after `settlement_root`; the Oracle rejects it when
   * after `block.timestamp` (`ProofTimestampInFuture`) or more than
   * `MAX_PROOF_AGE` (1 hour) before it (`ProofTimestampStale`), so a local
   * clock ahead of the chain head makes the default revert. Prefer
   * `await chainProofTimestamp(client)`, or `new ERC8262Prover(loader, { client })`,
   * which stamps with it. The circuit requires every active transaction
   * timestamp to lie in `[timestamp - timeWindow, timestamp]`; the builder
   * throws for a transaction dated after a chain stamp that trails the clock.
   */
  timestamp?: string;
  /**
   * Earliest allowed proof timestamp (unix seconds). For
   * `SettlementRegistry.finalizeTrade` pass the trade's `createdAt`, e.g.
   * `(await registry.getSettlement(tradeId)).createdAt`. Without `timestamp`
   * the stamp is `max(default stamp, notBefore)` (the local clock here, the
   * chain stamp in a prover built with `client`); `createdAt` is a mined
   * block's time, so it never exceeds the block that includes the submission.
   * An explicit `timestamp` before it throws
   * {@link PatternTimestampPredatesTradeError} before proving.
   */
  notBefore?: string | bigint;
}

/** Validated `notBefore` in unix seconds, or undefined when unset. */
function parseNotBefore(notBefore: string | bigint | undefined): number | undefined {
  if (notBefore === undefined) return undefined;
  const value = Number(notBefore);
  validateTimestamp(value);
  return value;
}

/**
 * The PATTERN stamp for `opts`: the explicit `timestamp` (validated, refused
 * below `notBefore`), else `max(defaultStamp, notBefore)`.
 */
export function resolvePatternTimestamp(
  opts: Pick<PatternInput, "timestamp" | "notBefore">,
  defaultStamp: string,
): string {
  const notBefore = parseNotBefore(opts.notBefore);
  if (opts.timestamp !== undefined) {
    const timestamp = Number(opts.timestamp);
    validateTimestamp(timestamp);
    if (notBefore !== undefined && timestamp < notBefore) {
      throw new PatternTimestampPredatesTradeError(BigInt(timestamp), BigInt(notBefore));
    }
    return opts.timestamp;
  }
  validateTimestamp(Number(defaultStamp));
  return notBefore !== undefined && Number(defaultStamp) < notBefore
    ? String(notBefore)
    : defaultStamp;
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
  const timestamp = resolvePatternTimestamp(opts, String(Math.floor(Date.now() / 1000)));

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

  // Mirrors circuits/pattern: every active transaction lies in the window ending
  // at the proof timestamp, [timestamp - timeWindow, timestamp]. Failing here
  // saves a proof generation the circuit would reject.
  const proofTs = Number(timestamp);
  for (let i = 0; i < opts.numTransactions; i++) {
    if (opts.amounts[i] <= 0) {
      throw new Error(`Amount[${String(i)}] must be > 0 for active transaction`);
    }
    if (opts.timestamps[i] <= 0) {
      throw new Error(`Timestamp[${String(i)}] must be > 0 for active transaction`);
    }
    if (opts.timestamps[i] > proofTs) {
      throw new Error(
        `Timestamp[${String(i)}] ${String(opts.timestamps[i])} is after the proof timestamp ${timestamp}`,
      );
    }
    if (proofTs - opts.timestamps[i] > opts.timeWindow) {
      throw new Error(
        `Timestamp[${String(i)}] ${String(opts.timestamps[i])} is outside the ${String(opts.timeWindow)}s window ending at ${timestamp}`,
      );
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
    settlement_root: opts.settlementRoot,
    timestamp,
  };
}
