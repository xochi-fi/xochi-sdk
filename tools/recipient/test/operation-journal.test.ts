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
import type { OperationJournal } from "../src/core/operation-journal.js";
import { openNodeJournals } from "../src/node/data-dir.js";

const TX_HASH = `0x${"12".repeat(32)}`;
const ORPHAN_ID = "10000000-0000-4000-8000-000000000000";
const ORPHAN_NONCE = "20000000-0000-4000-8000-000000000000";
const MISSING_ID = "30000000-0000-4000-8000-000000000000";
const MISSING_NONCE = "40000000-0000-4000-8000-000000000000";
const OTHER_NONCE = "50000000-0000-4000-8000-000000000000";

/** A data directory's `operations/` journal, through the CLI's Node adapter. */
function operationsDirectory(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "operations");
}

function journalAt(
  dir: string,
  afterReleaseClaimed?: (id: string) => void | Promise<void>,
): OperationJournal {
  return openNodeJournals(dirname(dir), { afterReleaseClaimed }).operations;
}

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

async function crashAfterTerminalSync(journal: OperationJournal, id: string): Promise<void> {
  durableWrite(journal.path(id), {
    ...(await journal.get(id)),
    status: "complete",
    txHash: TX_HASH,
    updatedAt: new Date().toISOString(),
  });
}

describe("fund-moving operation journal", () => {
  it("blocks a second operation until the first is durably complete", async () => {
    const dir = operationsDirectory("xochi-operation-journal-");
    try {
      const journal = journalAt(dir);
      const first = await journal.begin("exit", { amount: "100" });
      expect(statSync(journal.path(first.id)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      await journal.update(first.id, {
        status: "broadcast",
        txHash: TX_HASH,
        withdrawals: [{ withdrawalIndex: 0, finalizationData: `0x${"34".repeat(32)}` }],
      });
      const competingProcess = journalAt(dir);
      await expect(competingProcess.begin("spend", { amount: "1" })).rejects.toThrow(/reconcile/);
      await journal.update(first.id, { status: "complete" });
      const next = await competingProcess.begin("spend", { amount: "1" });
      await competingProcess.failOrAbort(next.id);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("recovers a crash after the terminal record sync but before lock removal", async () => {
    const dir = operationsDirectory("xochi-operation-journal-");
    try {
      const crashed = journalAt(dir);
      const finished = await crashed.begin("exit", { amount: "100" });
      await crashAfterTerminalSync(crashed, finished.id);

      const restarted = journalAt(dir);
      const next = await restarted.begin("spend", { amount: "1" });
      expect(next.id).not.toBe(finished.id);
      expect((await restarted.get(finished.id)).status).toBe("complete");
      await restarted.failOrAbort(next.id);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("serializes concurrent recovery before removing the terminal lock", async () => {
    const dir = operationsDirectory("xochi-operation-journal-");
    try {
      const crashed = journalAt(dir);
      const finished = await crashed.begin("exit", { amount: "100" });
      await crashAfterTerminalSync(crashed, finished.id);

      const competitor = journalAt(dir);
      let competitorBlocked = false;
      const restarted = journalAt(dir, async () => {
        await expect(competitor.begin("spend", { amount: "2" })).rejects.toThrow(/already claimed/);
        competitorBlocked = true;
      });

      const next = await restarted.begin("spend", { amount: "1" });
      expect(competitorBlocked).toBe(true);
      expect((await restarted.unresolved())?.id).toBe(next.id);
      await expect(competitor.begin("exit", { amount: "3" })).rejects.toThrow(/reconcile/);
      await restarted.failOrAbort(next.id);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("recovers a terminal lock whose release claimant crashed", async () => {
    const dir = operationsDirectory("xochi-operation-journal-");
    try {
      const crashed = journalAt(dir);
      const finished = await crashed.begin("exit", { amount: "100" });
      await crashAfterTerminalSync(crashed, finished.id);
      const deadPid = 2_147_483_647;
      durableWrite(join(dir, `released-${finished.id}-${finished.lockNonce}.lock`), {
        id: finished.id,
        lockNonce: finished.lockNonce,
        pid: deadPid,
        nonce: ORPHAN_ID,
      });

      const competitor = journalAt(dir);
      let competitorBlocked = false;
      const restarted = journalAt(dir, async () => {
        await expect(competitor.begin("exit", { amount: "2" })).rejects.toThrow(/already claimed/);
        competitorBlocked = true;
      });
      const next = await restarted.begin("spend", { amount: "1" });
      expect(competitorBlocked).toBe(true);
      expect(next.id).not.toBe(finished.id);
      await restarted.failOrAbort(next.id);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("keeps stale, nonterminal, unknown, and corrupt ownership held across recovery", async () => {
    const fixtures = [
      {
        name: "nonterminal",
        corrupt: async () => undefined,
      },
      {
        name: "stale",
        async corrupt(journal: OperationJournal, _dir: string, id: string) {
          await crashAfterTerminalSync(journal, id);
          const orphan = await journal.get(id);
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
        async corrupt(journal: OperationJournal, dir: string, id: string) {
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
        async corrupt(journal: OperationJournal, dir: string, id: string) {
          await crashAfterTerminalSync(journal, id);
          const lock = JSON.parse(readFileSync(join(dir, "active.lock"), "utf8")) as {
            id: string;
            kind: string;
          };
          durableWrite(join(dir, "active.lock"), { ...lock, lockNonce: OTHER_NONCE });
        },
      },
      {
        name: "corrupt-record",
        async corrupt(journal: OperationJournal, _dir: string, id: string) {
          durableWrite(journal.path(id), {
            ...(await journal.get(id)),
            status: "complete",
            unexpected: "tampered",
          });
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const dir = operationsDirectory(`xochi-operation-${fixture.name}-`);
      try {
        const crashed = journalAt(dir);
        const operation = await crashed.begin("spend", { amount: "1" });
        await fixture.corrupt(crashed, dir, operation.id);

        await expect(journalAt(dir).begin("exit", { amount: "2" }), fixture.name).rejects.toThrow();
        expect(statSync(join(dir, "active.lock")).isFile(), fixture.name).toBe(true);
      } finally {
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    }
  });

  it("keeps post-boundary failures in doubt and safely aborts pre-boundary failures", async () => {
    const dir = operationsDirectory("xochi-operation-journal-");
    try {
      const journal = journalAt(dir);
      const operation = await journal.begin("spend", { amount: "1" });
      await journal.update(operation.id, { status: "broadcast", txHash: TX_HASH });
      expect((await journal.failOrAbort(operation.id)).message).toBe(
        "operation outcome requires transaction reconciliation",
      );
      expect((await journal.records())[0]).toMatchObject({
        id: operation.id,
        status: "in_doubt",
        error: "operation outcome requires transaction reconciliation",
      });
      await expect(journal.begin("spend", { amount: "2" })).rejects.toThrow(/in_doubt/);
      await journal.update(operation.id, { status: "complete", receiptStatus: "checkpointed" });

      const aborted = await journal.begin("spend", { amount: "3" });
      expect((await journal.failOrAbort(aborted.id)).message).toBe(
        "operation failed before Aztec node submission",
      );
      expect((await journal.get(aborted.id)).status).toBe("aborted");
      const next = await journal.begin("spend", { amount: "4" });
      await journal.failOrAbort(next.id);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("restores the exact unresolved operation and lock on an independent host", async () => {
    const sourceDir = operationsDirectory("xochi-operation-source-");
    const restoredDir = operationsDirectory("xochi-operation-restored-");
    try {
      const source = journalAt(sourceDir);
      const operation = await source.begin("exit", { amount: "100" });
      await source.update(operation.id, { status: "broadcast", txHash: TX_HASH });

      const restored = journalAt(restoredDir);
      await restored.restore(await source.records());
      expect(await restored.activeUnresolved()).toEqual(await source.activeUnresolved());
      await expect(restored.begin("spend", { amount: "1" })).rejects.toThrow(/reconcile/);
      await expect(restored.restore(await source.records())).rejects.toThrow(/empty destination/);
    } finally {
      rmSync(dirname(sourceDir), { recursive: true, force: true });
      rmSync(dirname(restoredDir), { recursive: true, force: true });
    }
  });

  it("keeps today's on-disk lock bytes: the compact recoverable lock, then the owner", async () => {
    const dir = operationsDirectory("xochi-operation-bytes-");
    try {
      let firstLock = "";
      const journal = openNodeJournals(dirname(dir), {
        afterInitialLockSynced: () => {
          firstLock = readFileSync(join(dir, "active.lock"), "utf8");
        },
      }).operations;
      const operation = await journal.begin("spend", { amount: "1" });
      expect(firstLock).toBe(
        `${JSON.stringify({
          id: operation.id,
          lockNonce: operation.lockNonce,
          kind: "spend",
          record: operation,
        })}\n`,
      );
      expect(readFileSync(join(dir, "active.lock"), "utf8")).toBe(
        `${JSON.stringify({ id: operation.id, lockNonce: operation.lockNonce, kind: "spend" }, null, 2)}\n`,
      );
      expect(readFileSync(journal.path(operation.id), "utf8")).toBe(
        `${JSON.stringify(operation, null, 2)}\n`,
      );
      await journal.failOrAbort(operation.id);
      expect(
        JSON.parse(
          readFileSync(join(dir, `released-${operation.id}-${operation.lockNonce}.lock`), "utf8"),
        ),
      ).toMatchObject({ id: operation.id, lockNonce: operation.lockNonce, pid: process.pid });
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });
});
