import { isNativeError } from "node:util/types";

import { NoRetryError } from "@aztec-labs/foundation/retry";
import { ProvingError, SimulationError } from "@aztec-labs/stdlib/errors";

export const ALLOWLISTED_PRE_SUBMISSION_PHASES = [
  "simulate",
  "hydrate",
  "tee-sign",
  "prove",
  "pre-send",
] as const;
export type PreSubmissionPhase = (typeof ALLOWLISTED_PRE_SUBMISSION_PHASES)[number];

export const ALLOWLISTED_ERROR_CATEGORIES = [
  "simulation",
  "proving",
  "submission-ambiguous",
  "unknown",
] as const;
export type SafeErrorCategory = (typeof ALLOWLISTED_ERROR_CATEGORIES)[number];

export const ALLOWLISTED_ERROR_CLASSES = [
  "SimulationError",
  "ProvingError",
  "NoRetryError",
  "UnknownError",
] as const;
export type SafeErrorClass = (typeof ALLOWLISTED_ERROR_CLASSES)[number];

export const ALLOWLISTED_ERROR_CODES = [
  "AZTEC_SIMULATION_FAILED",
  "AZTEC_PROVING_FAILED",
  "AZTEC_SUBMISSION_AMBIGUOUS",
] as const;
export type SafeErrorCode = (typeof ALLOWLISTED_ERROR_CODES)[number];

export type FundMovementOperationKind = "spend" | "exit";

export interface SafeOperationDiagnostic {
  operationKind: FundMovementOperationKind;
  phase: PreSubmissionPhase;
  category: SafeErrorCategory;
  errorClass: SafeErrorClass;
  errorCode?: SafeErrorCode;
  submissionBoundaryReached: boolean;
  sendTxReached: boolean;
}

export interface SubmissionDiagnosticState {
  readonly operationKind: FundMovementOperationKind;
  phase: PreSubmissionPhase;
  submissionBoundaryReached: boolean;
  sendTxReached: boolean;
}

interface SafeErrorIdentity {
  category: SafeErrorCategory;
  errorClass: SafeErrorClass;
  errorCode?: SafeErrorCode;
}

const OPERATION_KINDS = ["spend", "exit"] as const;
const DIAGNOSTIC_KEYS = [
  "operationKind",
  "phase",
  "category",
  "errorClass",
  "errorCode",
  "submissionBoundaryReached",
  "sendTxReached",
] as const;
const trustedSafeErrors = new WeakSet<Error>();

const isExactSdkError = <T extends Error>(
  error: unknown,
  errorClass: Function & { prototype: T },
): error is T =>
  isNativeError(error) &&
  Object.getPrototypeOf(error) === errorClass.prototype &&
  error.constructor === errorClass;

const classify = (error: unknown): SafeErrorIdentity => {
  if (isExactSdkError(error, SimulationError)) {
    return {
      category: "simulation",
      errorClass: "SimulationError",
      errorCode: "AZTEC_SIMULATION_FAILED",
    };
  }
  if (isExactSdkError(error, ProvingError)) {
    return {
      category: "proving",
      errorClass: "ProvingError",
      errorCode: "AZTEC_PROVING_FAILED",
    };
  }
  if (isExactSdkError(error, NoRetryError)) {
    return {
      category: "submission-ambiguous",
      errorClass: "NoRetryError",
      errorCode: "AZTEC_SUBMISSION_AMBIGUOUS",
    };
  }
  return { category: "unknown", errorClass: "UnknownError" };
};

const identityIsConsistent = (
  category: SafeErrorCategory,
  errorClass: SafeErrorClass,
  errorCode: unknown,
): errorCode is SafeErrorCode | undefined =>
  (category === "simulation" &&
    errorClass === "SimulationError" &&
    errorCode === "AZTEC_SIMULATION_FAILED") ||
  (category === "proving" &&
    errorClass === "ProvingError" &&
    errorCode === "AZTEC_PROVING_FAILED") ||
  (category === "submission-ambiguous" &&
    errorClass === "NoRetryError" &&
    errorCode === "AZTEC_SUBMISSION_AMBIGUOUS") ||
  (category === "unknown" && errorClass === "UnknownError" && errorCode === undefined);

const projectDiagnostic = (value: unknown): SafeOperationDiagnostic | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !DIAGNOSTIC_KEYS.includes(key as (typeof DIAGNOSTIC_KEYS)[number]),
    ) ||
    !OPERATION_KINDS.includes(candidate.operationKind as FundMovementOperationKind) ||
    !ALLOWLISTED_PRE_SUBMISSION_PHASES.includes(candidate.phase as PreSubmissionPhase) ||
    !ALLOWLISTED_ERROR_CATEGORIES.includes(candidate.category as SafeErrorCategory) ||
    !ALLOWLISTED_ERROR_CLASSES.includes(candidate.errorClass as SafeErrorClass) ||
    !identityIsConsistent(
      candidate.category as SafeErrorCategory,
      candidate.errorClass as SafeErrorClass,
      candidate.errorCode,
    ) ||
    typeof candidate.submissionBoundaryReached !== "boolean" ||
    typeof candidate.sendTxReached !== "boolean"
  ) {
    return null;
  }
  const projected: SafeOperationDiagnostic = {
    operationKind: candidate.operationKind as FundMovementOperationKind,
    phase: candidate.phase as PreSubmissionPhase,
    category: candidate.category as SafeErrorCategory,
    errorClass: candidate.errorClass as SafeErrorClass,
    submissionBoundaryReached: candidate.submissionBoundaryReached,
    sendTxReached: candidate.sendTxReached,
  };
  if (candidate.errorCode !== undefined) projected.errorCode = candidate.errorCode;
  return projected;
};

class SafeOperationError extends Error {
  constructor(
    message: string,
    readonly diagnostic: Readonly<SafeOperationDiagnostic>,
  ) {
    super(message);
    this.name = "SafeOperationError";
    trustedSafeErrors.add(this);
  }
}

export function createSubmissionDiagnosticState(
  operationKind: FundMovementOperationKind,
): SubmissionDiagnosticState {
  return {
    operationKind,
    phase: "pre-send",
    submissionBoundaryReached: false,
    sendTxReached: false,
  };
}

export function safeOperationError(
  message: string,
  error: unknown,
  state: SubmissionDiagnosticState,
): Error {
  const existing = safeOperationDiagnostic(error);
  const diagnostic = projectDiagnostic(
    existing ?? {
      operationKind: state.operationKind,
      phase: state.phase,
      ...classify(error),
      submissionBoundaryReached: state.submissionBoundaryReached,
      sendTxReached: state.sendTxReached,
    },
  );
  const safeDiagnostic =
    diagnostic ??
    ({
      operationKind: OPERATION_KINDS.includes(state.operationKind) ? state.operationKind : "exit",
      phase: ALLOWLISTED_PRE_SUBMISSION_PHASES.includes(state.phase) ? state.phase : "pre-send",
      category: "unknown",
      errorClass: "UnknownError",
      submissionBoundaryReached: state.submissionBoundaryReached === true,
      sendTxReached: state.sendTxReached === true,
    } satisfies SafeOperationDiagnostic);
  return new SafeOperationError(message, Object.freeze(safeDiagnostic));
}

export function safeOperationDiagnostic(error: unknown): Readonly<SafeOperationDiagnostic> | null {
  if (!isNativeError(error) || !trustedSafeErrors.has(error)) return null;
  const diagnostic = projectDiagnostic((error as SafeOperationError).diagnostic);
  return diagnostic === null ? null : Object.freeze(diagnostic);
}

export function operatorDiagnosticLine(error: unknown): string | null {
  const diagnostic = safeOperationDiagnostic(error);
  return diagnostic === null
    ? null
    : `xochi-recipient operator diagnostic: ${JSON.stringify(diagnostic)}`;
}
