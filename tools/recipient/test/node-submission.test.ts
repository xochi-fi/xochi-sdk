import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { NoRetryError } from "@aztec-labs/foundation/retry";
import { ProvingError } from "@aztec-labs/stdlib/errors";
import { TxHash, type Tx } from "@aztec-labs/stdlib/tx";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSingleAttemptAztecNodeBroadcaster,
  NodeSubmission,
  singleAttemptJsonRpcFetch,
} from "../src/node-submission.js";
import { OperationJournal } from "../src/operation-journal.js";
import {
  createSubmissionDiagnosticState,
  safeOperationDiagnostic,
  type SubmissionDiagnosticState,
} from "../src/safe-diagnostic.js";

const diagnosticState = (
  operationKind: SubmissionDiagnosticState["operationKind"] = "spend",
): SubmissionDiagnosticState => createSubmissionDiagnosticState(operationKind);

const HASH = TxHash.fromString(`0x${"12".repeat(32)}`);
const TX = { getTxHash: () => HASH } as Tx;

afterEach(() => vi.unstubAllGlobals());

describe("Aztec node submission journal boundary", () => {
  it("makes exactly one non-redirecting HTTP attempt when a response is lost", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection closed after request"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      createSingleAttemptAztecNodeBroadcaster("http://aztec-node.invalid").sendTx(TX),
    ).rejects.toThrow("may have been written");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://aztec-node.invalid",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("does not expose a partial node response in the submission error", async () => {
    const secretResponse = "recipient-note-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(secretResponse, {
          status: 502,
          statusText: "Bad Gateway",
        }),
      ),
    );

    let message = "";
    try {
      await singleAttemptJsonRpcFetch("http://aztec-node.invalid", []);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 502");
    expect(message).not.toContain(secretResponse);
  });

  it("syncs the tx hash before the real node submit and keeps a boundary crash blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-node-submit-"));
    try {
      const journal = new OperationJournal(dir);
      const operation = journal.begin("spend", { amount: "1" });
      let nodeCalls = 0;
      const rawNode = {
        async sendTx(tx: Tx) {
          nodeCalls += 1;
          expect(tx.getTxHash().equals(HASH)).toBe(true);
          expect(journal.get(operation.id)).toMatchObject({
            status: "broadcast",
            txHash: HASH.toString(),
          });
          throw new NoRetryError("private transaction material must not escape");
        },
      } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);
      const state = diagnosticState();

      let caught: unknown;
      try {
        await submission.run(
          async (txHash) => {
            journal.update(operation.id, { status: "broadcast", txHash: txHash.toString() });
          },
          () => submission.node.sendTx(TX),
          state,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "Aztec transaction submission or receipt outcome requires journal reconciliation",
      );
      expect((caught as Error).message).not.toContain("private transaction material");
      expect(safeOperationDiagnostic(caught)).toEqual({
        operationKind: "spend",
        phase: "pre-send",
        category: "submission-ambiguous",
        errorClass: "NoRetryError",
        errorCode: "AZTEC_SUBMISSION_AMBIGUOUS",
        submissionBoundaryReached: true,
        sendTxReached: true,
      });
      expect(nodeCalls).toBe(1);
      journal.failOrAbort(operation.id);

      const restarted = new OperationJournal(dir);
      expect(() => restarted.begin("exit", { amount: "2" })).toThrow(/in_doubt/);
      expect(restarted.get(operation.id).txHash).toBe(HASH.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not cross the may-have-sent boundary when proving fails before node submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-node-submit-"));
    try {
      const journal = new OperationJournal(dir);
      const operation = journal.begin("spend", { amount: "1" });
      let journaled = false;
      const rawNode = { sendTx: async (_tx: Tx) => undefined } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);
      const state = diagnosticState();
      state.phase = "prove";

      let caught: unknown;
      try {
        await submission.run(
          async () => {
            journaled = true;
          },
          async () => {
            throw new ProvingError("proof contains private note data");
          },
          state,
        );
      } catch (error) {
        caught = error;
      }
      expect(safeOperationDiagnostic(caught)).toEqual({
        operationKind: "spend",
        phase: "prove",
        category: "proving",
        errorClass: "ProvingError",
        errorCode: "AZTEC_PROVING_FAILED",
        submissionBoundaryReached: false,
        sendTxReached: false,
      });
      journal.failOrAbort(operation.id);

      expect(journaled).toBe(false);
      expect(journal.get(operation.id).status).toBe("aborted");
      const next = new OperationJournal(dir).begin("exit", { amount: "2" });
      expect(next.kind).toBe("exit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never calls the node when durable tx-hash journaling fails", async () => {
    let nodeCalls = 0;
    const rawNode = {
      async sendTx(_tx: Tx) {
        nodeCalls += 1;
      },
    } as unknown as AztecNode;
    const submission = new NodeSubmission(rawNode);
    const state = diagnosticState();

    let caught: unknown;
    try {
      await submission.run(
        async () => {
          throw new Error("journal fsync failed");
        },
        () => submission.node.sendTx(TX),
        state,
      );
    } catch (error) {
      caught = error;
    }
    expect(safeOperationDiagnostic(caught)).toEqual({
      operationKind: "spend",
      phase: "pre-send",
      category: "unknown",
      errorClass: "UnknownError",
      submissionBoundaryReached: false,
      sendTxReached: true,
    });
    expect(nodeCalls).toBe(0);
  });

  it("refuses a second node submission while one operation owns the boundary", async () => {
    let nodeCalls = 0;
    const rawNode = {
      async sendTx(_tx: Tx) {
        nodeCalls += 1;
      },
    } as unknown as AztecNode;
    const submission = new NodeSubmission(rawNode);

    await expect(
      submission.run(
        async () => undefined,
        async () => {
          await submission.node.sendTx(TX);
          await submission.node.sendTx(TX);
        },
        diagnosticState(),
      ),
    ).rejects.toThrow("requires journal reconciliation");
    expect(nodeCalls).toBe(1);
  });

  it("refuses an armed operation that never reaches node sendTx", async () => {
    const rawNode = { sendTx: async (_tx: Tx) => undefined } as unknown as AztecNode;
    const submission = new NodeSubmission(rawNode);

    await expect(
      submission.run(
        async () => undefined,
        async () => undefined,
        diagnosticState(),
      ),
    ).rejects.toThrow("recipient operation failed before Aztec node submission");
  });

  it("leaves unrelated unarmed wallet submissions on the original node", async () => {
    let targetCalls = 0;
    let broadcasterCalls = 0;
    const target = {
      async sendTx(_tx: Tx) {
        targetCalls += 1;
      },
    } as unknown as AztecNode;
    const broadcaster = {
      async sendTx(_tx: Tx) {
        broadcasterCalls += 1;
      },
    };
    const submission = new NodeSubmission(target, broadcaster);

    await submission.node.sendTx(TX);
    expect(targetCalls).toBe(1);
    expect(broadcasterCalls).toBe(0);
  });
});
