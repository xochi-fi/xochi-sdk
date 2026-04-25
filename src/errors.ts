/**
 * Typed contract errors.
 *
 * Solidity custom errors thrown by XochiZKPOracle, XochiZKPVerifier, and
 * SettlementRegistry are decoded into named JavaScript classes so consumers
 * can `instanceof` them in error handlers instead of regex-matching messages.
 *
 * Usage:
 *   try { await oracle.submitCompliance(...) }
 *   catch (err) {
 *     if (err instanceof SubmitterMismatchError) { ... }
 *     if (err instanceof ProofAlreadyUsedError) { ... }
 *     if (err instanceof XochiContractError) { ... }  // any decoded revert
 *   }
 */

import type { Abi } from "viem";
import { BaseError, ContractFunctionRevertedError } from "viem";

/** Base class for all decoded contract errors. */
export class XochiContractError extends Error {
  readonly errorName: string;
  readonly args: readonly unknown[];

  constructor(errorName: string, args: readonly unknown[], message?: string) {
    super(message ?? `Contract reverted: ${errorName}`);
    this.name = this.constructor.name;
    this.errorName = errorName;
    this.args = args;
  }
}

// ============================================================
// Oracle errors
// ============================================================

export class SubmitterMismatchError extends XochiContractError {
  constructor() {
    super("SubmitterMismatch", [], "Proof submitter does not match msg.sender (anti-frontrun)");
  }
}

export class ProofAlreadyUsedError extends XochiContractError {
  readonly proofHash: string;
  constructor(proofHash: string) {
    super("ProofAlreadyUsed", [proofHash], `Proof already submitted: ${proofHash}`);
    this.proofHash = proofHash;
  }
}

export class ProofTimestampStaleError extends XochiContractError {
  readonly proofTimestamp: bigint;
  readonly blockTimestamp: bigint;
  constructor(proofTimestamp: bigint, blockTimestamp: bigint) {
    super(
      "ProofTimestampStale",
      [proofTimestamp, blockTimestamp],
      `Proof timestamp ${String(proofTimestamp)} too old (block ${String(blockTimestamp)}, max age 1h)`,
    );
    this.proofTimestamp = proofTimestamp;
    this.blockTimestamp = blockTimestamp;
  }
}

export class TimeWindowTooSmallError extends XochiContractError {
  readonly timeWindow: bigint;
  readonly minimum: bigint;
  constructor(timeWindow: bigint, minimum: bigint) {
    super(
      "TimeWindowTooSmall",
      [timeWindow, minimum],
      `Pattern time_window ${String(timeWindow)} below minimum ${String(minimum)}`,
    );
    this.timeWindow = timeWindow;
    this.minimum = minimum;
  }
}

export class EmptyBatchError extends XochiContractError {
  constructor() {
    super("EmptyBatch", [], "Cannot submit empty batch");
  }
}

export class BatchTooLargeError extends XochiContractError {
  constructor() {
    super("BatchTooLarge", [], "Batch exceeds MAX_BATCH_SIZE (100)");
  }
}

export class BatchLengthMismatchError extends XochiContractError {
  constructor() {
    super("BatchLengthMismatch", [], "Batch arrays have inconsistent lengths");
  }
}

// ============================================================
// Verifier errors
// ============================================================

export class VersionRevokedError extends XochiContractError {
  readonly proofType: number;
  readonly version: bigint;
  constructor(proofType: number, version: bigint) {
    super(
      "VersionRevoked",
      [proofType, version],
      `Verifier version ${String(version)} for proofType ${String(proofType)} has been revoked`,
    );
    this.proofType = proofType;
    this.version = version;
  }
}

export class TimelockNotElapsedError extends XochiContractError {
  readonly proofType: number;
  readonly readyAt: bigint;
  constructor(proofType: number, readyAt: bigint) {
    super(
      "TimelockNotElapsed",
      [proofType, readyAt],
      `Verifier update timelock not elapsed for proofType ${String(proofType)} (ready at ${String(readyAt)})`,
    );
    this.proofType = proofType;
    this.readyAt = readyAt;
  }
}

// ============================================================
// Settlement registry errors
// ============================================================

export class TradeAlreadyExistsError extends XochiContractError {
  readonly tradeId: string;
  constructor(tradeId: string) {
    super("TradeAlreadyExists", [tradeId], `Trade already registered: ${tradeId}`);
    this.tradeId = tradeId;
  }
}

export class TradeNotFoundError extends XochiContractError {
  readonly tradeId: string;
  constructor(tradeId: string) {
    super("TradeNotFound", [tradeId], `Trade not found: ${tradeId}`);
    this.tradeId = tradeId;
  }
}

export class AttestationNotFoundError extends XochiContractError {
  readonly proofHash: string;
  constructor(proofHash: string) {
    super("AttestationNotFound", [proofHash], `Attestation not found for proof: ${proofHash}`);
    this.proofHash = proofHash;
  }
}

// ============================================================
// Decoder
// ============================================================

/**
 * Walk a viem error chain to find the `ContractFunctionRevertedError`,
 * decode it against the supplied ABI, and return a typed error.
 *
 * Returns `null` if the error is not a contract revert (e.g., network issue,
 * gas estimation failure with no revert data) so callers can rethrow.
 */
export function decodeContractError(err: unknown, abi: Abi): XochiContractError | null {
  if (!(err instanceof BaseError)) return null;

  const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | undefined;
  if (!revertError) return null;

  const data = revertError.data;
  if (!data) {
    return new XochiContractError("UnknownRevert", [], revertError.shortMessage);
  }

  const errorName = data.errorName;
  const args = (data.args ?? []) as readonly unknown[];

  switch (errorName) {
    case "SubmitterMismatch":
      return new SubmitterMismatchError();
    case "ProofAlreadyUsed":
      return new ProofAlreadyUsedError(args[0] as string);
    case "ProofTimestampStale":
      return new ProofTimestampStaleError(args[0] as bigint, args[1] as bigint);
    case "TimeWindowTooSmall":
      return new TimeWindowTooSmallError(args[0] as bigint, args[1] as bigint);
    case "EmptyBatch":
      return new EmptyBatchError();
    case "BatchTooLarge":
      return new BatchTooLargeError();
    case "BatchLengthMismatch":
      return new BatchLengthMismatchError();
    case "VersionRevoked":
      return new VersionRevokedError(Number(args[0]), args[1] as bigint);
    case "TimelockNotElapsed":
      return new TimelockNotElapsedError(Number(args[0]), args[1] as bigint);
    case "TradeAlreadyExists":
      return new TradeAlreadyExistsError(args[0] as string);
    case "TradeNotFound":
      return new TradeNotFoundError(args[0] as string);
    case "AttestationNotFound":
      return new AttestationNotFoundError(args[0] as string);
    default:
      return new XochiContractError(errorName, args, `Contract reverted: ${errorName}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void abi;
}

/**
 * Run an async contract call and rethrow contract reverts as typed errors.
 */
export async function withDecodedErrors<T>(abi: Abi, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const decoded = decodeContractError(err, abi);
    if (decoded) throw decoded;
    throw err;
  }
}
