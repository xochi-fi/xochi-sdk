import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationJournal } from "../src/operation-journal.js";

describe("fund-moving operation journal", () => {
  it("blocks a second operation until the first is durably complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const journal = new OperationJournal(dir);
      const first = journal.begin("exit", { amount: "100" });
      expect(statSync(journal.path(first.id)).mode & 0o777).toBe(0o600);
      journal.update(first.id, { status: "sending" });
      journal.update(first.id, {
        status: "broadcast",
        txHash: `0x${"12".repeat(32)}`,
        withdrawals: [{ withdrawalIndex: 0, finalizationData: `0x${"34".repeat(32)}` }],
      });
      const competingProcess = new OperationJournal(dir);
      expect(() => competingProcess.begin("spend", { amount: "1" })).toThrow(/reconcile/);
      journal.update(first.id, { status: "complete" });
      expect(() => competingProcess.begin("spend", { amount: "1" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps failures in doubt rather than enabling a blind retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const journal = new OperationJournal(dir);
      const operation = journal.begin("spend", { amount: "1" });
      journal.update(operation.id, { status: "sending" });
      journal.failOrAbort(operation.id, new Error("connection closed during send"));
      expect(journal.records()[0]).toMatchObject({
        id: operation.id,
        status: "in_doubt",
        error: "connection closed during send",
      });
      expect(() => journal.begin("spend", { amount: "2" })).toThrow(/in_doubt/);
      const preSend = journal.records().find((record) => record.status === "in_doubt")!;
      journal.update(preSend.id, { status: "complete" });
      const aborted = journal.begin("spend", { amount: "3" });
      journal.failOrAbort(aborted.id, new Error("simulation rejected"));
      expect(journal.get(aborted.id).status).toBe("aborted");
      expect(() => journal.begin("spend", { amount: "4" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
