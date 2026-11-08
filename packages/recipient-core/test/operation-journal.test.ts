import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TxHash, type Tx } from "@aztec-labs/stdlib/tx";
import { describe, expect, it } from "vitest";

import { beginExitAfterExecutorFeeCheck, recordBroadcastBeforeSend } from "../src/chain.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { NodeSubmission } from "../src/node-submission.js";
import {
  DuplicateOperationIdError,
  OperationJournal,
  operationsLockName,
  type JournalHolder,
} from "../src/operation-journal.js";
import { createSubmissionDiagnosticState } from "../src/safe-diagnostic.js";
import { FixedClock, MemoryKeyValueStore, MemoryLockManager } from "./support/memory.js";

const ADDRESS = `0x${"0a".repeat(32)}`;
const TX_HASH = `0x${"12".repeat(32)}`;
const TAB_A: JournalHolder = { pid: 101, host: "tab-a" };
const TAB_B: JournalHolder = { pid: 202, host: "tab-b" };

function journalFor(
  kv: MemoryKeyValueStore,
  locks: MemoryLockManager,
  holder: JournalHolder,
  clock = new FixedClock(),
): OperationJournal {
  return new OperationJournal({
    kv,
    locks,
    clock,
    lockName: operationsLockName(ADDRESS),
    holder,
  });
}

/** Holds one write of a key: a step between two of an operation's writes, made observable. */
class GatedKeyValueStore extends MemoryKeyValueStore {
  private gate: { key: string; reach: () => void; opened: Promise<void> } | null = null;

  /** The next `put` of `key` waits for `open`; `reached` resolves when it starts waiting. */
  hold(key: string): { reached: Promise<void>; open: () => void } {
    const reached = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<void>();
    this.gate = { key, reach: reached.resolve, opened: opened.promise };
    return { reached: reached.promise, open: opened.resolve };
  }

  override async put(key: string, value: Uint8Array): Promise<void> {
    const gate = this.gate;
    if (gate?.key === key) {
      this.gate = null;
      gate.reach();
      await gate.opened;
    }
    await super.put(key, value);
  }
}

/** Sends one transaction through `NodeSubmission` and records the journal as durable at send. */
async function submitSeeingDurable(
  kv: MemoryKeyValueStore,
  operationId: string,
  beforeSubmit: (txHash: TxHash) => Promise<void>,
): Promise<unknown[]> {
  const seenAtBroadcast: unknown[] = [];
  const broadcaster = {
    async sendTx() {
      seenAtBroadcast.push(kv.durableJson(`operations/${operationId}.json`));
    },
  } as unknown as AztecNode;
  const submission = new NodeSubmission(broadcaster);
  const hash = TxHash.fromString(TX_HASH);
  await submission.run(
    beforeSubmit,
    async () => submission.node.sendTx({ getTxHash: () => hash } as Tx),
    createSubmissionDiagnosticState("spend"),
  );
  return seenAtBroadcast;
}

describe("operation journal over the storage and lock ports", () => {
  it("lets the holder complete an operation a reconcile already completed with its tx hash", async () => {
    const kv = new MemoryKeyValueStore();
    const locks = new MemoryLockManager();
    const holder = journalFor(kv, locks, TAB_A);
    const reconciler = journalFor(kv, locks, TAB_B);
    const operation = await holder.begin("spend", { amount: "1" });
    await holder.update(operation.id, { status: "broadcast", txHash: TX_HASH });
    const reconciled = await reconciler.update(operation.id, {
      status: "complete",
      receiptStatus: "checkpointed",
    });

    expect(await holder.update(operation.id, { status: "complete", txHash: TX_HASH })).toEqual(
      reconciled,
    );
    await expect(
      holder.update(operation.id, { status: "complete", txHash: `0x${"34".repeat(32)}` }),
    ).rejects.toThrow();
    expect(await holder.get(operation.id)).toEqual(reconciled);
  });

  it("reports a caller-provided terminal id collision with a typed error", async () => {
    const journal = journalFor(new MemoryKeyValueStore(), new MemoryLockManager(), TAB_A);
    const id = "11111111-1111-4111-8111-111111111111";
    const operation = await journal.begin("spend", { amount: "1" }, id);
    await journal.update(operation.id, { status: "broadcast", txHash: TX_HASH });
    await journal.update(operation.id, { status: "complete", txHash: TX_HASH });

    await expect(journal.begin("spend", { amount: "2" }, id)).rejects.toEqual(
      new DuplicateOperationIdError(id),
    );
  });

  it("makes the transaction hash durable before the node can receive the transaction", async () => {
    const kv = new MemoryKeyValueStore();
    const journal = journalFor(kv, new MemoryLockManager(), TAB_A);
    const operation = await journal.begin("spend", { amount: "1" });

    const seen = await submitSeeingDurable(kv, operation.id, async (txHash) => {
      await journal.update(operation.id, { status: "broadcast", txHash: txHash.toString() });
    });

    expect(seen).toEqual([
      expect.objectContaining({ id: operation.id, status: "broadcast", txHash: TX_HASH }),
    ]);
  });

  it("LiveAztec's submit hook makes the transaction hash durable before the send", async () => {
    const kv = new MemoryKeyValueStore();
    const journal = journalFor(kv, new MemoryLockManager(), TAB_A);
    const operation = await journal.begin("exit", { amount: "1" });

    const seen = await submitSeeingDurable(
      kv,
      operation.id,
      recordBroadcastBeforeSend(journal, operation.id, OXDAI_MAINNET_REV2),
    );

    expect(seen).toEqual([
      expect.objectContaining({ id: operation.id, status: "broadcast", txHash: TX_HASH }),
    ]);
  });

  it("uses the caller journal id for an exit and generates one when omitted", async () => {
    const journal = journalFor(new MemoryKeyValueStore(), new MemoryLockManager(), TAB_A);
    const journalId = "10000000-0000-4000-8000-000000000003";
    const request = {
      l1Recipient: `0x${"22".repeat(20)}`,
      amount: 100n,
      proverTip: 3n,
      relayerTip: 2n,
      maxExecutorFee: 10n,
      broadcasterArtifact: { name: "Broadcaster" } as ContractArtifact,
      journalId,
    };

    const exact = await beginExitAfterExecutorFeeCheck(journal, ADDRESS, request, 10n);
    expect(exact.operation.id).toBe(journalId);
    await journal.failOrAbort(exact.operation.id);

    const generated = await beginExitAfterExecutorFeeCheck(
      journal,
      ADDRESS,
      { ...request, journalId: undefined },
      10n,
    );
    expect(generated.operation.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generated.operation.id).not.toBe(journalId);
    await journal.failOrAbort(generated.operation.id);
  });

  it("an abort that wins the submission boundary keeps the holder from sending", async () => {
    const kv = new MemoryKeyValueStore();
    const locks = new MemoryLockManager();
    const holder = journalFor(kv, locks, TAB_A);
    const successor = journalFor(kv, locks, TAB_B);
    const operation = await holder.begin("spend", { amount: "1" });
    // Its tab released the holder lease while its send ran on.
    await holder.close();
    expect(await successor.abortAbandonedRun(operation.id)).toMatchObject({ status: "aborted" });

    let sent = 0;
    const submission = new NodeSubmission({
      async sendTx() {
        sent += 1;
      },
    } as unknown as AztecNode);
    await expect(
      submission.run(
        recordBroadcastBeforeSend(holder, operation.id, OXDAI_MAINNET_REV2),
        async () => submission.node.sendTx({ getTxHash: () => TxHash.fromString(TX_HASH) } as Tx),
        createSubmissionDiagnosticState("spend"),
      ),
    ).rejects.toThrow();
    expect(sent).toBe(0);
    const aborted = await successor.get(operation.id);
    expect(aborted.status).toBe("aborted");
    expect(aborted.txHash).toBeUndefined();
  });

  it("a send that wins the submission boundary keeps a successor from aborting it", async () => {
    const kv = new GatedKeyValueStore();
    const locks = new MemoryLockManager();
    const holder = journalFor(kv, locks, TAB_A);
    const successor = journalFor(kv, locks, TAB_B);
    const operation = await holder.begin("spend", { amount: "1" });
    await holder.close();
    const write = kv.hold(`operations/${operation.id}.json`);

    const broadcast = recordBroadcastBeforeSend(
      holder,
      operation.id,
      OXDAI_MAINNET_REV2,
    )(TxHash.fromString(TX_HASH));
    // The holder is past the boundary, writing its broadcast record.
    await write.reached;
    expect(await successor.abortAbandonedRun(operation.id)).toBeNull();
    write.open();
    await broadcast;

    expect(await successor.get(operation.id)).toMatchObject({
      status: "broadcast",
      txHash: TX_HASH,
    });
  });

  it("the storage double exposes a dropped await: the send sees the record still building", async () => {
    const kv = new MemoryKeyValueStore();
    const journal = journalFor(kv, new MemoryLockManager(), TAB_A);
    const operation = await journal.begin("spend", { amount: "1" });
    let dropped: Promise<unknown> = Promise.resolve();

    const seen = await submitSeeingDurable(kv, operation.id, async (txHash) => {
      dropped = journal.update(operation.id, { status: "broadcast", txHash: txHash.toString() });
    });
    await dropped;

    expect(seen).toEqual([expect.objectContaining({ id: operation.id, status: "building" })]);
    expect(kv.durableJson(`operations/${operation.id}.json`)).toMatchObject({
      status: "broadcast",
    });
  });

  it("writes a precomputed transaction hash in the first durable lock write", async () => {
    const kv = new MemoryKeyValueStore();
    const journal = journalFor(kv, new MemoryLockManager(), TAB_A);
    const operation = await journal.beginBroadcast("refund-frozen-notes", { amount: "1" }, TX_HASH);

    const first = kv.events[0]!;
    expect(first).toMatchObject({ op: "create", key: "operations/active.lock" });
    expect(JSON.parse(first.value!)).toMatchObject({
      id: operation.id,
      record: { status: "broadcast", txHash: TX_HASH },
    });
    expect(kv.json(`operations/${operation.id}.json`)).toMatchObject({ txHash: TX_HASH });
    expect(kv.json("operations/active.lock")).toEqual({
      id: operation.id,
      lockNonce: operation.lockNonce,
      kind: "refund-frozen-notes",
    });
  });

  it("keeps a second holder out while an operation is unresolved or in doubt", async () => {
    const kv = new MemoryKeyValueStore();
    const locks = new MemoryLockManager();
    const tabA = journalFor(kv, locks, TAB_A);
    const tabB = journalFor(kv, locks, TAB_B);
    const operation = await tabA.begin("spend", { amount: "1" });

    await expect(tabB.begin("exit", { amount: "2" })).rejects.toThrow(/is building; reconcile/);
    await tabA.update(operation.id, { status: "broadcast", txHash: TX_HASH });
    const error = await tabA.failOrAbort(operation.id);
    expect(error.message).toBe("operation outcome requires transaction reconciliation");
    expect(await tabA.get(operation.id)).toMatchObject({ status: "in_doubt", txHash: TX_HASH });

    await tabA.close();
    await expect(tabB.begin("exit", { amount: "2" })).rejects.toThrow(/in_doubt/);
    await expect(tabB.update(operation.id, { status: "aborted" })).rejects.toThrow(
      /cannot transition from in_doubt to aborted/,
    );
    await tabB.update(operation.id, { status: "complete", receiptStatus: "checkpointed" });
    expect(kv.text("operations/active.lock")).toBeNull();

    const next = await tabB.begin("exit", { amount: "2" });
    expect((await tabB.failOrAbort(next.id)).message).toBe(
      "operation failed before Aztec node submission",
    );
  });

  it("refuses beside a live receipt run and aborts the run of a holder that is gone", async () => {
    const kv = new MemoryKeyValueStore();
    const locks = new MemoryLockManager();
    const tabA = journalFor(kv, locks, TAB_A);
    const tabB = journalFor(kv, locks, TAB_B);
    const run = await tabA.beginReceipt("intent-1");
    expect(run.request).toEqual({ intentId: "intent-1", pid: "101", host: "tab-a" });

    await expect(tabB.begin("spend", { amount: "1" })).rejects.toThrow(
      "a receipt run (pid 101 on tab-a) holds the fund-movement lock; wait for it",
    );
    await expect(tabB.releaseReceiptLock(run.id)).rejects.toThrow(/is still running/);

    await tabA.close();
    const spend = await tabB.begin("spend", { amount: "1" });
    expect(await tabB.get(run.id)).toMatchObject({ status: "aborted" });
    await tabB.failOrAbort(spend.id);
  });

  it("supersedes the release claim of a holder that is gone, never a live one", async () => {
    const kv = new MemoryKeyValueStore();
    const locks = new MemoryLockManager();
    const crashed = journalFor(kv, locks, TAB_A);
    const finished = await crashed.begin("exit", { amount: "100" });
    kv.setJson(`operations/${finished.id}.json`, {
      ...(await crashed.get(finished.id)),
      status: "complete",
      txHash: TX_HASH,
    });
    kv.setJson(`operations/released-${finished.id}-${finished.lockNonce}.lock`, {
      id: finished.id,
      lockNonce: finished.lockNonce,
      pid: TAB_A.pid,
      nonce: "10000000-0000-4000-8000-000000000000",
    });

    const recovering = journalFor(kv, locks, TAB_B);
    await expect(recovering.begin("spend", { amount: "1" })).rejects.toThrow(/already claimed/);

    await crashed.close();
    const next = await recovering.begin("spend", { amount: "1" });
    expect(
      kv.json(
        `operations/released-${finished.id}-${finished.lockNonce}-10000000-0000-4000-8000-000000000000.lock`,
      ),
    ).toMatchObject({ id: finished.id, pid: TAB_B.pid });
    await recovering.failOrAbort(next.id);
  });

  it("stamps records with the injected clock", async () => {
    const kv = new MemoryKeyValueStore();
    const clock = new FixedClock(Date.parse("2030-01-02T03:04:05.000Z"));
    const journal = journalFor(kv, new MemoryLockManager(), TAB_A, clock);
    const operation = await journal.begin("spend", { amount: "1" });
    clock.ms += 1000;
    const updated = await journal.update(operation.id, { status: "broadcast", txHash: TX_HASH });
    expect(operation.createdAt).toBe("2030-01-02T03:04:05.000Z");
    expect(updated.updatedAt).toBe("2030-01-02T03:04:06.000Z");
  });
});
