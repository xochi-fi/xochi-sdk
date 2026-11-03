import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationJournal } from "../src/operation-journal.js";

const TX_HASH = `0x${"12".repeat(32)}`;
const ORPHAN_ID = "10000000-0000-4000-8000-000000000000";
const ORPHAN_NONCE = "20000000-0000-4000-8000-000000000000";
const MISSING_ID = "30000000-0000-4000-8000-000000000000";
const MISSING_NONCE = "40000000-0000-4000-8000-000000000000";
const OTHER_NONCE = "50000000-0000-4000-8000-000000000000";

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
    txHash: TX_HASH,
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
      journal.update(first.id, {
        status: "broadcast",
        txHash: TX_HASH,
        withdrawals: [{ withdrawalIndex: 0, finalizationData: `0x${"34".repeat(32)}` }],
      });
      const competingProcess = new OperationJournal(dir);
      expect(() => competingProcess.begin("spend", { amount: "1" })).toThrow(/reconcile/);
      journal.update(first.id, { status: "complete" });
      const next = competingProcess.begin("spend", { amount: "1" });
      competingProcess.failOrAbort(next.id);
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
      restarted.failOrAbort(next.id);
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
      restarted.failOrAbort(next.id);
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
      const deadPid = 2_147_483_647;
      durableWrite(join(dir, `released-${finished.id}-${finished.lockNonce}.lock`), {
        id: finished.id,
        lockNonce: finished.lockNonce,
        pid: deadPid,
        nonce: ORPHAN_ID,
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
      restarted.failOrAbort(next.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps stale, nonterminal, unknown, and corrupt ownership held across recovery", () => {
    const fixtures = [
      {
        name: "nonterminal",
        corrupt: () => undefined,
      },
      {
        name: "stale",
        corrupt(journal: OperationJournal, _dir: string, id: string) {
          crashAfterTerminalSync(journal, id);
          const orphan = journal.get(id);
          durableWrite(journal.path(ORPHAN_ID), {
            ...orphan,
            id: ORPHAN_ID,
            lockNonce: ORPHAN_NONCE,
            status: "building",
            txHash: undefined,
          });
        },
      },
      {
        name: "unknown",
        corrupt(journal: OperationJournal, dir: string, id: string) {
          unlinkSync(journal.path(id));
          durableWrite(join(dir, "active.lock"), {
            id: MISSING_ID,
            lockNonce: MISSING_NONCE,
            kind: "spend",
          });
        },
      },
      {
        name: "owner-mismatch",
        corrupt(journal: OperationJournal, dir: string, id: string) {
          crashAfterTerminalSync(journal, id);
          const lock = JSON.parse(readFileSync(join(dir, "active.lock"), "utf8")) as {
            id: string;
            kind: string;
          };
          durableWrite(join(dir, "active.lock"), { ...lock, lockNonce: OTHER_NONCE });
        },
      },
      {
        name: "corrupt-record",
        corrupt(journal: OperationJournal, _dir: string, id: string) {
          durableWrite(journal.path(id), {
            ...journal.get(id),
            status: "complete",
            unexpected: "tampered",
          });
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

  it("keeps post-boundary failures in doubt and safely aborts pre-boundary failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-operation-journal-"));
    try {
      const journal = new OperationJournal(dir);
      const operation = journal.begin("spend", { amount: "1" });
      journal.update(operation.id, { status: "broadcast", txHash: TX_HASH });
      expect(journal.failOrAbort(operation.id).message).toBe(
        "operation outcome requires transaction reconciliation",
      );
      expect(journal.records()[0]).toMatchObject({
        id: operation.id,
        status: "in_doubt",
        error: "operation outcome requires transaction reconciliation",
      });
      expect(() => journal.begin("spend", { amount: "2" })).toThrow(/in_doubt/);
      journal.update(operation.id, { status: "complete", receiptStatus: "checkpointed" });

      const aborted = journal.begin("spend", { amount: "3" });
      expect(journal.failOrAbort(aborted.id).message).toBe(
        "operation failed before Aztec node submission",
      );
      expect(journal.get(aborted.id).status).toBe("aborted");
      const next = journal.begin("spend", { amount: "4" });
      journal.failOrAbort(next.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
