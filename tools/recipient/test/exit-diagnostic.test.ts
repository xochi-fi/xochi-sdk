import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { SimulationError } from "@aztec-labs/stdlib/errors";
import { describe, expect, it } from "vitest";

import { failOrAbortWithSafeDiagnostic } from "../src/chain.js";
import { formatCliFailure } from "../src/cli.js";
import { NodeSubmission } from "../src/node-submission.js";
import { OperationJournal } from "../src/operation-journal.js";
import { safeOperationDiagnostic, type SubmissionDiagnosticState } from "../src/safe-diagnostic.js";

const SENSITIVE_VALUES = [
  "arbitrary simulation message",
  "arbitrary cause",
  "arbitrary stack",
  "arbitrary data",
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "987654321",
  "arbitrary transaction material",
] as const;

describe("privacy-safe exit failure diagnostics", () => {
  it("preserves a simulation category while the journal and CLI discard private error material", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-diagnostic-"));
    try {
      const journal = new OperationJournal(directory);
      const operation = journal.begin("exit", { fixture: "safe-request-marker" });
      const calls = {
        simulate: 0,
        prove: 0,
        teeSign: 0,
        accountSign: 0,
        sendTx: 0,
      };
      const rawCause = new Error(SENSITIVE_VALUES[1]);
      rawCause.stack = SENSITIVE_VALUES[2];
      const rawError = new SimulationError(SENSITIVE_VALUES[0], [], [], undefined, {
        cause: rawCause,
      });
      Object.assign(rawError, {
        code: "UNAPPROVED_PRIVATE_CODE",
        data: { private: SENSITIVE_VALUES[3] },
        address: SENSITIVE_VALUES[4],
        amount: SENSITIVE_VALUES[5],
        transaction: SENSITIVE_VALUES[6],
      });
      const wallet = {
        async simulateTx(): Promise<never> {
          calls.simulate += 1;
          throw rawError;
        },
      };
      const rawNode = {
        async sendTx(): Promise<void> {
          calls.sendTx += 1;
        },
      } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);
      const state: SubmissionDiagnosticState = { operationKind: "exit", phase: "pre-send" };

      let nodeSubmissionError: unknown;
      try {
        await submission.run(
          async () => {
            throw new Error("transaction hash persistence must be unreachable");
          },
          async () => {
            state.phase = "simulate";
            await wallet.simulateTx();
            calls.teeSign += 1;
            calls.prove += 1;
            calls.accountSign += 1;
          },
          state,
        );
      } catch (error) {
        nodeSubmissionError = error;
      }

      expect(safeOperationDiagnostic(nodeSubmissionError)).toEqual({
        operationKind: "exit",
        phase: "simulate",
        category: "simulation",
        errorClass: "SimulationError",
        errorCode: "AZTEC_SIMULATION_FAILED",
        submissionBoundaryReached: false,
        sendTxReached: false,
      });

      const finalError = failOrAbortWithSafeDiagnostic(journal, operation.id, nodeSubmissionError);
      expect(safeOperationDiagnostic(finalError)).toEqual(
        safeOperationDiagnostic(nodeSubmissionError),
      );
      const record = journal.get(operation.id);
      expect(record).toMatchObject({
        status: "aborted",
        error: "operation failed before Aztec node submission",
      });
      expect(record.txHash).toBeUndefined();
      expect(journal.activeUnresolved()).toBeNull();
      expect(existsSync(join(directory, "active.lock"))).toBe(false);
      expect(calls).toEqual({ simulate: 1, prove: 0, teeSign: 0, accountSign: 0, sendTx: 0 });

      const cliOutput = formatCliFailure(finalError);
      expect(cliOutput).toContain("xochi-recipient: operation failed before Aztec node submission");
      expect(cliOutput).toContain(
        'xochi-recipient operator diagnostic: {"operationKind":"exit","phase":"simulate","category":"simulation","errorClass":"SimulationError","errorCode":"AZTEC_SIMULATION_FAILED","submissionBoundaryReached":false,"sendTxReached":false}',
      );
      const durableJournal = readFileSync(journal.path(operation.id), "utf8");
      const serializedSafeError = JSON.stringify(finalError);
      for (const secret of SENSITIVE_VALUES) {
        expect(cliOutput).not.toContain(secret);
        expect(durableJournal).not.toContain(secret);
        expect(serializedSafeError).not.toContain(secret);
      }
      expect(durableJournal).not.toContain("UNAPPROVED_PRIVATE_CODE");
      expect(cliOutput).not.toContain("UNAPPROVED_PRIVATE_CODE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps a spoofed class and code to the generic unknown identity", async () => {
    const rawNode = { sendTx: async () => undefined } as unknown as AztecNode;
    const submission = new NodeSubmission(rawNode);
    const state: SubmissionDiagnosticState = { operationKind: "exit", phase: "simulate" };
    const spoofed = Object.assign(new Error("private unknown message"), {
      name: "SimulationError",
      code: "AZTEC_SIMULATION_FAILED",
    });

    let caught: unknown;
    try {
      await submission.run(
        async () => undefined,
        async () => {
          throw spoofed;
        },
        state,
      );
    } catch (error) {
      caught = error;
    }

    expect(safeOperationDiagnostic(caught)).toEqual({
      operationKind: "exit",
      phase: "simulate",
      category: "unknown",
      errorClass: "UnknownError",
      submissionBoundaryReached: false,
      sendTxReached: false,
    });
    const output = formatCliFailure(caught);
    expect(output).not.toContain("private unknown message");
    expect(output).not.toContain("AZTEC_SIMULATION_FAILED");
  });
});
