import { ProvingError, SimulationError } from "@aztec-labs/stdlib/errors";
import { NoRetryError } from "@aztec-labs/foundation/retry";
import { describe, expect, it } from "vitest";

import {
  ALLOWLISTED_PRE_SUBMISSION_PHASES,
  createSubmissionDiagnosticState,
  operatorDiagnosticLine,
  safeOperationDiagnostic,
  safeOperationError,
  type PreSubmissionPhase,
} from "../src/core/safe-diagnostic.js";

describe("safe operation diagnostic allowlists", () => {
  it.each(ALLOWLISTED_PRE_SUBMISSION_PHASES)("preserves the allowlisted %s phase", (phase) => {
    const state = createSubmissionDiagnosticState("exit");
    state.phase = phase;

    const error = safeOperationError(
      "recipient operation failed before Aztec node submission",
      new SimulationError("private", []),
      state,
    );

    expect(safeOperationDiagnostic(error)?.phase).toBe(phase);
  });

  it.each([
    {
      error: new SimulationError("private", []),
      category: "unknown",
      errorClass: "UnknownError",
      errorCode: undefined,
    },
    {
      error: new ProvingError("private"),
      category: "unknown",
      errorClass: "UnknownError",
      errorCode: undefined,
    },
    {
      error: new NoRetryError("private"),
      category: "unknown",
      errorClass: "UnknownError",
      errorCode: undefined,
    },
    {
      error: Object.assign(new Error("private"), { code: "AZTEC_SIMULATION_FAILED" }),
      category: "unknown",
      errorClass: "UnknownError",
      errorCode: undefined,
    },
  ] as const)("normalizes $errorClass without raw error fields", (expected) => {
    const state = createSubmissionDiagnosticState("spend");
    state.phase = "prove" as PreSubmissionPhase;
    state.sendTxReached = true;

    const error = safeOperationError("generic", expected.error, state);
    const diagnostic = safeOperationDiagnostic(error);

    expect(diagnostic).toEqual({
      operationKind: "spend",
      phase: "prove",
      category: expected.category,
      errorClass: expected.errorClass,
      ...(expected.errorCode === undefined ? {} : { errorCode: expected.errorCode }),
      submissionBoundaryReached: false,
      sendTxReached: true,
    });
    expect(Object.keys(diagnostic ?? {}).sort()).toEqual(
      [
        "operationKind",
        "phase",
        "category",
        "errorClass",
        ...(expected.errorCode === undefined ? [] : ["errorCode"]),
        "submissionBoundaryReached",
        "sendTxReached",
      ].sort(),
    );
    const line = operatorDiagnosticLine(error);
    expect(line).not.toContain("private");
    expect(line).not.toContain("cause");
    expect(line).not.toContain("stack");
  });
});
