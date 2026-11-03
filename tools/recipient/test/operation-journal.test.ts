import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationJournal } from "../src/operation-journal.js";

function durableWrite(path: string, value: unknown): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function crashAfterTerminalSync(journal: OperationJournal, id: string): void {
  durableWrite(journal.path(id), {
    ...journal.get(id),
    status: "complete",
    updatedAt: new Date().toISOString(),
  });
}

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

  it("recovers a crash after the terminal record sync but before lock removal", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const crashed = new OperationJournal(dir);
      const finished = crashed.begin("exit", { amount: "100" });
      crashAfterTerminalSync(crashed, finished.id);

      const restarted = new OperationJournal(dir);
      const next = restarted.begin("spend", { amount: "1" });
      expect(next.id).not.toBe(finished.id);
      expect(restarted.get(finished.id).status).toBe("complete");
      restarted.update(next.id, { status: "aborted" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("serializes concurrent recovery before removing the terminal lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const crashed = new OperationJournal(dir);
      const finished = crashed.begin("exit", { amount: "100" });
      crashAfterTerminalSync(crashed, finished.id);

      const competitor = new OperationJournal(dir);
      let competitorBlocked = false;
      const restarted = new OperationJournal(dir, () => {
        expect(() => competitor.begin("spend", { amount: "2" })).toThrow(/already claimed/);
        competitorBlocked = true;
      });

      const next = restarted.begin("spend", { amount: "1" });
      expect(competitorBlocked).toBe(true);
      expect(restarted.unresolved()?.id).toBe(next.id);
      expect(() => competitor.begin("exit", { amount: "3" })).toThrow(/reconcile/);
      restarted.update(next.id, { status: "aborted" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a terminal lock whose release claimant crashed", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const crashed = new OperationJournal(dir);
      const finished = crashed.begin("exit", { amount: "100" });
      crashAfterTerminalSync(crashed, finished.id);
      const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      if (deadProcess.pid === undefined) throw new Error("failed to start crash claimant");
      durableWrite(join(dir, `released-${finished.id}.lock`), {
        id: finished.id,
        pid: deadProcess.pid,
        nonce: "10000000-0000-4000-8000-000000000000",
      });

      const competitor = new OperationJournal(dir);
      let competitorBlocked = false;
      const restarted = new OperationJournal(dir, () => {
        expect(() => competitor.begin("exit", { amount: "2" })).toThrow(/already claimed/);
        competitorBlocked = true;
      });
      const next = restarted.begin("spend", { amount: "1" });
      expect(competitorBlocked).toBe(true);
      expect(next.id).not.toBe(finished.id);
      restarted.update(next.id, { status: "aborted" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps stale, nonterminal, and unknown locks held across recovery", () => {
    const fixtures = [
      {
        name: "nonterminal",
        corrupt(journal: OperationJournal, _dir: string, id: string) {
          journal.update(id, { status: "sending" });
        },
      },
      {
        name: "stale",
        corrupt(journal: OperationJournal, _dir: string, id: string) {
          crashAfterTerminalSync(journal, id);
          const orphan = journal.get(id);
          durableWrite(journal.path("orphan"), {
            ...orphan,
            id: "orphan",
            status: "building",
          });
        },
      },
      {
        name: "unknown",
        corrupt(journal: OperationJournal, dir: string, id: string) {
          unlinkSync(journal.path(id));
          durableWrite(join(dir, "active.lock"), { id: "missing", kind: "spend" });
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const dir = mkdtempSync(join(tmpdir(), `xochi-operation-${fixture.name}-`));
      try {
        const crashed = new OperationJournal(dir);
        const operation = crashed.begin("spend", { amount: "1" });
        fixture.corrupt(crashed, dir, operation.id);

        expect(
          () => new OperationJournal(dir).begin("exit", { amount: "2" }),
          fixture.name,
        ).toThrow();
        expect(statSync(join(dir, "active.lock")).isFile(), fixture.name).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
