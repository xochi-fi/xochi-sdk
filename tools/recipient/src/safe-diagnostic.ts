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
}

interface SafeErrorIdentity {
  category: SafeErrorCategory;
  errorClass: SafeErrorClass;
  errorCode?: SafeErrorCode;
}

const classify = (error: unknown): SafeErrorIdentity => {
  if (error instanceof SimulationError) {
    return {
      category: "simulation",
      errorClass: "SimulationError",
      errorCode: "AZTEC_SIMULATION_FAILED",
    };
  }
  if (error instanceof ProvingError) {
    return {
      category: "proving",
      errorClass: "ProvingError",
      errorCode: "AZTEC_PROVING_FAILED",
    };
  }
  if (error instanceof NoRetryError) {
    return {
      category: "submission-ambiguous",
      errorClass: "NoRetryError",
      errorCode: "AZTEC_SUBMISSION_AMBIGUOUS",
    };
  }
  return { category: "unknown", errorClass: "UnknownError" };
};

export class SafeOperationError extends Error {
  constructor(
    message: string,
    readonly diagnostic: Readonly<SafeOperationDiagnostic>,
  ) {
    super(message);
    this.name = "SafeOperationError";
  }
}

export function safeOperationError(
  message: string,
  error: unknown,
  state: SubmissionDiagnosticState,
  boundaries: { submissionBoundaryReached: boolean; sendTxReached: boolean },
): SafeOperationError {
  const existing = safeOperationDiagnostic(error);
  const diagnostic: SafeOperationDiagnostic = existing ?? {
    operationKind: state.operationKind,
    phase: state.phase,
    ...classify(error),
    submissionBoundaryReached: boundaries.submissionBoundaryReached,
    sendTxReached: boundaries.sendTxReached,
  };
  return new SafeOperationError(message, Object.freeze({ ...diagnostic }));
}

export function safeOperationDiagnostic(error: unknown): Readonly<SafeOperationDiagnostic> | null {
  return error instanceof SafeOperationError ? error.diagnostic : null;
}

export function preserveSafeOperationDiagnostic(message: string, error: unknown): Error {
  const diagnostic = safeOperationDiagnostic(error);
  return diagnostic === null ? new Error(message) : new SafeOperationError(message, diagnostic);
}

export function operatorDiagnosticLine(error: unknown): string | null {
  const diagnostic = safeOperationDiagnostic(error);
  return diagnostic === null
    ? null
    : `xochi-recipient operator diagnostic: ${JSON.stringify(diagnostic)}`;
}
