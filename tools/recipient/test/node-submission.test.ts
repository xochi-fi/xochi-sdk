import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { TxHash, type Tx } from "@aztec-labs/stdlib/tx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSubmission, singleAttemptJsonRpcFetch } from "../src/node-submission.js";
import { OperationJournal } from "../src/operation-journal.js";

const HASH = TxHash.fromString(`0x${"12".repeat(32)}`);
const TX = { getTxHash: () => HASH } as Tx;

class SimulatedCrash extends Error {}
afterEach(() => vi.unstubAllGlobals());

describe("Aztec node submission journal boundary", () => {
  it("makes exactly one HTTP attempt when an Aztec submission response is lost", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection closed after request"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      singleAttemptJsonRpcFetch("http://aztec-node.invalid", {
        jsonrpc: "2.0",
        id: 1,
        method: "aztec_sendTx",
        params: [],
      }),
    ).rejects.toThrow("connection closed after request");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://aztec-node.invalid",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
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
          throw new SimulatedCrash("crash after the node submission boundary");
        },
      } as unknown as AztecNode;
      const submission = new NodeSubmission(rawNode);

      await expect(
        submission.run(
          async (txHash) => {
            journal.update(operation.id, { status: "broadcast", txHash: txHash.toString() });
          },
          () => submission.node.sendTx(TX),
        ),
      ).rejects.toThrow(SimulatedCrash);

      expect(nodeCalls).toBe(1);
      const restarted = new OperationJournal(dir);
      expect(() => restarted.begin("exit", { amount: "2" })).toThrow(/broadcast/);
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
      const proofFailure = new Error("proof failed before node submission");

      await expect(
        submission.run(
          async () => {
            journaled = true;
          },
          async () => {
            throw proofFailure;
          },
        ),
      ).rejects.toThrow(proofFailure);
      journal.failOrAbort(operation.id, proofFailure);

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

    await expect(
      submission.run(
        async () => {
          throw new Error("journal fsync failed");
        },
        () => submission.node.sendTx(TX),
      ),
    ).rejects.toThrow("journal fsync failed");
    expect(nodeCalls).toBe(0);
  });

  it("refuses a second node submission while one operation owns the journal boundary", async () => {
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
      ),
    ).rejects.toThrow("more than one Aztec node submission");
    expect(nodeCalls).toBe(1);
  });
});
