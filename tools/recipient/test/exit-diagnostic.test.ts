import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { SimulateOptions, Wallet } from "@aztec-labs/aztec.js/wallet";
import { SimulationError } from "@aztec-labs/stdlib/errors";
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx";
import { TxHash, type Tx } from "@aztec-labs/stdlib/tx";
import { describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/account.js";
import { backupContents } from "../src/backup.js";
import { sanitizeFundMovementFailure } from "../src/chain.js";
import { closePortAfterCommand, formatCliFailure, writeCliFailure } from "../src/cli.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { NodeSubmission } from "../src/node-submission.js";
import { OperationJournal } from "../src/operation-journal.js";
import { simulateWalletTransaction } from "../src/oxide/vendor/oxide-client/l2_operations.js";
import {
  createSubmissionDiagnosticState,
  safeOperationDiagnostic,
  safeOperationError,
} from "../src/safe-diagnostic.js";
import { TEST_SECRETS } from "./fixtures.js";

const HASH = TxHash.fromString(`0x${"12".repeat(32)}`);
const TX = { getTxHash: () => HASH } as Tx;
const SENSITIVE = {
  message: "private-error-message",
  cause: "private-error-cause",
  stack: "private-error-stack",
  data: "private-error-data",
  address: "private-error-address",
  operationId: "private-error-operation-id",
  amount: "private-error-amount",
  fee: "private-error-fee",
  calldata: "private-error-calldata",
  note: "private-error-note",
  nullifier: "private-error-nullifier",
  witness: "private-error-witness",
  proof: "private-error-proof",
  recipient: "private-error-recipient",
  transaction: "private-error-transaction",
} as const;

const sensitiveValues = Object.values(SENSITIVE);

function privateSdkSimulationError(): SimulationError {
  const cause = new Error(SENSITIVE.cause);
  cause.stack = SENSITIVE.stack;
  return Object.assign(new SimulationError(SENSITIVE.message, [], [], undefined, { cause }), {
    code: "UNAPPROVED_PRIVATE_CODE",
    data: SENSITIVE.data,
    address: SENSITIVE.address,
    operationId: SENSITIVE.operationId,
    amount: SENSITIVE.amount,
    fee: SENSITIVE.fee,
    calldata: SENSITIVE.calldata,
    note: SENSITIVE.note,
    nullifier: SENSITIVE.nullifier,
    witness: SENSITIVE.witness,
    proof: SENSITIVE.proof,
    recipient: SENSITIVE.recipient,
    transaction: SENSITIVE.transaction,
  });
}

async function privateSimulationFailure(): Promise<Error> {
  try {
    await simulateWalletTransaction(
      {
        async simulateTx() {
          throw privateSdkSimulationError();
        },
      } as Pick<Wallet, "simulateTx">,
      {} as ExecutionPayload,
      {} as SimulateOptions,
    );
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("wallet simulation failure fixture did not fail");
}

describe("privacy-safe exit failure diagnostics", () => {
  it("preserves a simulation category through the production journal and CLI failure seams", async () => {
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
      const wallet = {
        async simulateTx(): Promise<never> {
          calls.simulate += 1;
          throw privateSdkSimulationError();
        },
      };
      const rawNode = {
        async sendTx(): Promise<void> {
          calls.sendTx += 1;
        },
      } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);
      const state = createSubmissionDiagnosticState("exit");

      let nodeSubmissionError: unknown;
      try {
        await submission.run(
          async () => {
            throw new Error("transaction hash persistence must be unreachable");
          },
          async () => {
            state.phase = "simulate";
            await simulateWalletTransaction(
              wallet as Pick<Wallet, "simulateTx">,
              {} as ExecutionPayload,
              {} as SimulateOptions,
            );
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

      const finalError = sanitizeFundMovementFailure(
        journal,
        operation,
        nodeSubmissionError,
        state,
      );
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

      let cliOutput = "";
      writeCliFailure(finalError, (output) => {
        cliOutput += output;
      });
      expect(cliOutput).toContain("xochi-recipient: operation failed before Aztec node submission");
      const durableJournal = readFileSync(journal.path(operation.id), "utf8");
      const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
      const serializedBackup = JSON.stringify(
        backupContents(OXDAI_MAINNET_REV2, TEST_SECRETS, account, null, null, 1_800_000_000, {
          operations: journal.records(),
          exits: [],
        }),
      );
      const serializedSafeError = JSON.stringify(finalError);
      for (const secret of sensitiveValues) {
        expect(cliOutput).not.toContain(secret);
        expect(durableJournal).not.toContain(secret);
        expect(serializedBackup).not.toContain(secret);
        expect(serializedSafeError).not.toContain(secret);
      }
      expect(durableJournal).not.toContain("UNAPPROVED_PRIVATE_CODE");
      expect(cliOutput).not.toContain("UNAPPROVED_PRIVATE_CODE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aborts and clears a hash persisted by a before-submit callback that then fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-pre-submit-"));
    try {
      const journal = new OperationJournal(directory);
      const operation = journal.begin("exit", { fixture: "partial-persistence" });
      let nodeCalls = 0;
      const rawNode = {
        async sendTx(): Promise<void> {
          nodeCalls += 1;
        },
      } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);
      const state = createSubmissionDiagnosticState("exit");
      state.phase = "prove";

      let caught: unknown;
      try {
        await submission.run(
          async (txHash) => {
            journal.update(operation.id, {
              status: "broadcast",
              txHash: txHash.toString(),
            });
            throw new Error("private post-rename fsync failure");
          },
          () => submission.node.sendTx(TX),
          state,
        );
      } catch (error) {
        caught = error;
      }

      const finalError = sanitizeFundMovementFailure(journal, operation, caught, state);
      expect(safeOperationDiagnostic(finalError)).toEqual({
        operationKind: "exit",
        phase: "pre-send",
        category: "unknown",
        errorClass: "UnknownError",
        submissionBoundaryReached: false,
        sendTxReached: true,
      });
      expect(journal.get(operation.id)).toMatchObject({
        status: "aborted",
        error: "operation failed before Aztec node submission",
      });
      expect(journal.get(operation.id).txHash).toBeUndefined();
      expect(existsSync(join(directory, "active.lock"))).toBe(false);
      expect(nodeCalls).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps post-submit failures in doubt with a sanitized true/true boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-post-submit-"));
    try {
      const journal = new OperationJournal(directory);
      const operation = journal.begin("exit", { fixture: "post-submit" });
      journal.update(operation.id, { status: "broadcast", txHash: HASH.toString() });
      const state = createSubmissionDiagnosticState("exit");
      state.phase = "pre-send";
      state.sendTxReached = true;
      state.submissionBoundaryReached = true;

      const finalError = sanitizeFundMovementFailure(
        journal,
        operation,
        new Error("private post-submit material"),
        state,
      );

      expect(safeOperationDiagnostic(finalError)).toEqual({
        operationKind: "exit",
        phase: "pre-send",
        category: "unknown",
        errorClass: "UnknownError",
        submissionBoundaryReached: true,
        sendTxReached: true,
      });
      expect(journal.get(operation.id)).toMatchObject({
        status: "in_doubt",
        txHash: HASH.toString(),
        error: "operation outcome requires transaction reconciliation",
      });
      expect(formatCliFailure(finalError)).not.toContain("private post-submit material");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains the safe diagnostic when terminal lock release is interrupted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-lock-release-"));
    try {
      let privateOperationId = "";
      const journal = new OperationJournal(directory, () => {
        throw new Error(`private lock path for ${privateOperationId}`);
      });
      const operation = journal.begin("exit", { fixture: "release-interruption" });
      privateOperationId = operation.id;
      const state = createSubmissionDiagnosticState("exit");
      state.phase = "simulate";

      const finalError = sanitizeFundMovementFailure(
        journal,
        operation,
        await privateSimulationFailure(),
        state,
      );
      const output = formatCliFailure(finalError);

      expect(journal.get(operation.id)).toMatchObject({
        status: "aborted",
        error: "operation failed before Aztec node submission",
      });
      expect(existsSync(join(directory, "active.lock"))).toBe(true);
      expect(safeOperationDiagnostic(finalError)?.category).toBe("simulation");
      expect(output).toContain(
        "operation journal abort or lock release failed before Aztec node submission",
      );
      expect(output).not.toContain(privateOperationId);
      expect(output).not.toContain("private lock path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps native prototype spoofing and throwing accessors to unknown before journal cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-spoof-"));
    try {
      const journal = new OperationJournal(directory);
      const operation = journal.begin("exit", { fixture: "native-spoof" });
      const state = createSubmissionDiagnosticState("exit");
      state.phase = "simulate";
      const spoofed = new Error("private unknown message");
      Object.setPrototypeOf(spoofed, SimulationError.prototype);
      Object.defineProperty(spoofed, "constructor", {
        get() {
          throw new Error("private constructor getter");
        },
      });
      Object.assign(spoofed, { code: "AZTEC_SIMULATION_FAILED" });

      const caught = sanitizeFundMovementFailure(journal, operation, spoofed, state);

      expect(safeOperationDiagnostic(caught)).toEqual({
        operationKind: "exit",
        phase: "simulate",
        category: "unknown",
        errorClass: "UnknownError",
        submissionBoundaryReached: false,
        sendTxReached: false,
      });
      expect(journal.get(operation.id).status).toBe("aborted");
      expect(existsSync(join(directory, "active.lock"))).toBe(false);
      const output = formatCliFailure(caught);
      expect(output).not.toContain("private unknown message");
      expect(output).not.toContain("private constructor getter");
      expect(output).not.toContain("AZTEC_SIMULATION_FAILED");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains a sanitized command failure when PXE shutdown also fails", async () => {
    const state = createSubmissionDiagnosticState("exit");
    state.phase = "simulate";
    const primary = safeOperationError(
      "operation failed before Aztec node submission",
      await privateSimulationFailure(),
      state,
    );
    expect(() =>
      Object.defineProperty(primary, "diagnostic", {
        get() {
          throw new Error("private diagnostic getter");
        },
      }),
    ).toThrow();
    expect(safeOperationDiagnostic(primary)?.category).toBe("simulation");
    const rawCloseMessage = "private wallet close material";
    const reports: string[] = [];
    let caught: unknown;
    let commandFailed = false;

    try {
      try {
        throw primary;
      } catch (error) {
        commandFailed = true;
        throw error;
      } finally {
        await closePortAfterCommand(
          {
            async close() {
              throw new Error(rawCloseMessage);
            },
          },
          commandFailed,
          (line) => reports.push(line),
        );
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(primary);
    expect(safeOperationDiagnostic(caught)?.category).toBe("simulation");
    expect(reports).toEqual([
      "close: PXE shutdown failed after command failure; original failure retained",
    ]);
    expect(reports.join("\n")).not.toContain(rawCloseMessage);

    let reportFailureCaught: unknown;
    try {
      try {
        throw primary;
      } finally {
        await closePortAfterCommand(
          {
            async close() {
              throw new Error(rawCloseMessage);
            },
          },
          true,
          () => {
            throw new Error("private report failure");
          },
        );
      }
    } catch (error) {
      reportFailureCaught = error;
    }
    expect(reportFailureCaught).toBe(primary);

    await expect(
      closePortAfterCommand(
        {
          async close() {
            throw new Error(rawCloseMessage);
          },
        },
        false,
        () => undefined,
      ),
    ).rejects.toThrow(
      "recipient PXE shutdown failed after command completion; inspect the operation journal before any retry",
    );
  });
});
