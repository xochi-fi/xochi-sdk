/**
 * Typed contract errors.
 *
 * Solidity custom errors thrown by ERC8262Oracle, ERC8262Verifier, and
 * SettlementRegistry are decoded into named JavaScript classes so consumers
 * can `instanceof` them in error handlers instead of regex-matching messages.
 *
 * Usage:
 *   try { await oracle.submitCompliance(...) }
 *   catch (err) {
 *     if (err instanceof SubmitterMismatchError) { ... }
 *     if (err instanceof ProofAlreadyUsedError) { ... }
 *     if (err instanceof ERC8262ContractError) { ... }  // any decoded revert
 *   }
 */

import type { Abi } from "viem";
import { BaseError, ContractFunctionRevertedError } from "viem";

/** Base class for all decoded contract errors. */
export class ERC8262ContractError extends Error {
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

export class SubmitterMismatchError extends ERC8262ContractError {
  constructor() {
    super("SubmitterMismatch", [], "Proof submitter does not match msg.sender (anti-frontrun)");
  }
}

export class ProofAlreadyUsedError extends ERC8262ContractError {
  readonly proofHash: string;
  constructor(proofHash: string) {
    super("ProofAlreadyUsed", [proofHash], `Proof already submitted: ${proofHash}`);
    this.proofHash = proofHash;
  }
}

export class ProofTimestampStaleError extends ERC8262ContractError {
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

export class TimeWindowTooSmallError extends ERC8262ContractError {
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

export class EmptyBatchError extends ERC8262ContractError {
  constructor() {
    super("EmptyBatch", [], "Cannot submit empty batch");
  }
}

export class BatchTooLargeError extends ERC8262ContractError {
  constructor() {
    super("BatchTooLarge", [], "Batch exceeds MAX_BATCH_SIZE (10)");
  }
}

export class SignedSignalsRequiredError extends ERC8262ContractError {
  readonly jurisdictionId: number;
  readonly proofType: number;
  constructor(jurisdictionId: number, proofType: number) {
    super(
      "SignedSignalsRequired",
      [jurisdictionId, proofType],
      `Jurisdiction ${String(jurisdictionId)} requires a signed-variant proof; got proofType ${String(proofType)}`,
    );
    this.jurisdictionId = jurisdictionId;
    this.proofType = proofType;
  }
}

export class InvalidSignerPubkeyHashError extends ERC8262ContractError {
  readonly signerPubkeyHash: string;
  constructor(signerPubkeyHash: string) {
    super(
      "InvalidSignerPubkeyHash",
      [signerPubkeyHash],
      `Signer pubkey hash not registered with the Oracle: ${signerPubkeyHash}`,
    );
    this.signerPubkeyHash = signerPubkeyHash;
  }
}

export class BatchLengthMismatchError extends ERC8262ContractError {
  constructor() {
    super("BatchLengthMismatch", [], "Batch arrays have inconsistent lengths");
  }
}

// COMPLIANCE_MULTI_SIGNED (0x09)

export class InsufficientSignersError extends ERC8262ContractError {
  readonly active: number;
  readonly required: number;
  constructor(active: number, required: number) {
    super(
      "InsufficientSigners",
      [active, required],
      `Multi-signed proof has ${String(active)} active signer(s); need at least ${String(required)}`,
    );
    this.active = active;
    this.required = required;
  }
}

export class BelowJurisdictionMinProvidersError extends ERC8262ContractError {
  readonly jurisdictionId: number;
  readonly m: number;
  readonly floor: number;
  constructor(jurisdictionId: number, m: number, floor: number) {
    super(
      "BelowJurisdictionMinProviders",
      [jurisdictionId, m, floor],
      `threshold_m=${String(m)} below jurisdiction ${String(jurisdictionId)} floor=${String(floor)}`,
    );
    this.jurisdictionId = jurisdictionId;
    this.m = m;
    this.floor = floor;
  }
}

export class DuplicateSignerError extends ERC8262ContractError {
  readonly signerPubkeyHash: string;
  constructor(signerPubkeyHash: string) {
    super(
      "DuplicateSigner",
      [signerPubkeyHash],
      `Duplicate signer pubkey hash across active slots: ${signerPubkeyHash}`,
    );
    this.signerPubkeyHash = signerPubkeyHash;
  }
}

export class InvalidThresholdMError extends ERC8262ContractError {
  readonly thresholdM: number;
  constructor(thresholdM: number) {
    super(
      "InvalidThresholdM",
      [thresholdM],
      `threshold_m must be in [1, 5]; got ${String(thresholdM)}`,
    );
    this.thresholdM = thresholdM;
  }
}

// Public-input shape errors (ProofTypes library)

export class InvalidPublicInputLengthError extends ERC8262ContractError {
  readonly proofType: number;
  readonly expected: bigint;
  readonly actual: bigint;
  constructor(proofType: number, expected: bigint, actual: bigint) {
    super(
      "InvalidPublicInputLength",
      [proofType, expected, actual],
      `proofType=${String(proofType)} expected ${String(expected)} public inputs, got ${String(actual)}`,
    );
    this.proofType = proofType;
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnalignedPublicInputsError extends ERC8262ContractError {
  readonly length: bigint;
  constructor(length: bigint) {
    super(
      "UnalignedPublicInputs",
      [length],
      `publicInputs length ${String(length)} is not a multiple of 32`,
    );
    this.length = length;
  }
}

// ============================================================
// Verifier errors
// ============================================================

export class VersionRevokedError extends ERC8262ContractError {
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

export class TimelockNotElapsedError extends ERC8262ContractError {
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

export class TradeAlreadyExistsError extends ERC8262ContractError {
  readonly tradeId: string;
  constructor(tradeId: string) {
    super("TradeAlreadyExists", [tradeId], `Trade already registered: ${tradeId}`);
    this.tradeId = tradeId;
  }
}

export class TradeNotFoundError extends ERC8262ContractError {
  readonly tradeId: string;
  constructor(tradeId: string) {
    super("TradeNotFound", [tradeId], `Trade not found: ${tradeId}`);
    this.tradeId = tradeId;
  }
}

export class AttestationNotFoundError extends ERC8262ContractError {
  readonly proofHash: string;
  constructor(proofHash: string) {
    super("AttestationNotFound", [proofHash], `Attestation not found for proof: ${proofHash}`);
    this.proofHash = proofHash;
  }
}

export class SettlementRootMismatchError extends ERC8262ContractError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      "SettlementRootMismatch",
      [expected, actual],
      `pattern settlement_root mismatch (audit H-1): expected ${expected}, got ${actual}`,
    );
    this.expected = expected;
    this.actual = actual;
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
export function decodeContractError(err: unknown, abi: Abi): ERC8262ContractError | null {
  if (!(err instanceof BaseError)) return null;

  const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | undefined;
  if (!revertError) return null;

  const data = revertError.data;
  if (!data) {
    return new ERC8262ContractError("UnknownRevert", [], revertError.shortMessage);
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
    case "SignedSignalsRequired":
      return new SignedSignalsRequiredError(Number(args[0]), Number(args[1]));
    case "InvalidSignerPubkeyHash":
      return new InvalidSignerPubkeyHashError(args[0] as string);
    case "InsufficientSigners":
      return new InsufficientSignersError(Number(args[0]), Number(args[1]));
    case "BelowJurisdictionMinProviders":
      return new BelowJurisdictionMinProvidersError(
        Number(args[0]),
        Number(args[1]),
        Number(args[2]),
      );
    case "DuplicateSigner":
      return new DuplicateSignerError(args[0] as string);
    case "InvalidThresholdM":
      return new InvalidThresholdMError(Number(args[0]));
    case "InvalidPublicInputLength":
      return new InvalidPublicInputLengthError(
        Number(args[0]),
        args[1] as bigint,
        args[2] as bigint,
      );
    case "UnalignedPublicInputs":
      return new UnalignedPublicInputsError(args[0] as bigint);
    case "SettlementRootMismatch":
      return new SettlementRootMismatchError(args[0] as string, args[1] as string);
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
      return new ERC8262ContractError(errorName, args, `Contract reverted: ${errorName}`);
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
