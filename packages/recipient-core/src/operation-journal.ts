import { z } from "zod4";

import { decimal } from "./corridor.js";
import { compactJsonBytes, parseJsonBytes, prettyJsonBytes } from "./json.js";
import {
  KeyExistsError,
  type Clock,
  type KeyValueStore,
  type LockLease,
  type LockManager,
} from "./ports.js";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = /^0x[0-9a-f]+$/i;
const txHash = /^0x[0-9a-f]{64}$/i;
const OperationKindSchema = z.enum([
  "spend",
  "exit",
  "refund-frozen-notes",
  "refund-frozen-deposits",
  "refund-unprocessed-deposit",
  // Moves no funds: holds the lock while `receipt` checks and signs a payout (`beginReceipt`).
  "receipt",
]);
const OperationStatusSchema = z.enum([
  "building",
  "broadcast",
  "complete",
  "failed",
  "aborted",
  "in_doubt",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

/** A caller-provided operation id already names a durable journal record. */
export class DuplicateOperationIdError extends Error {
  readonly journalId: string;

  constructor(journalId: string, options?: ErrorOptions) {
    super(`operation journal id already exists: ${journalId}`, options);
    this.name = "DuplicateOperationIdError";
    this.journalId = journalId;
  }
}

export const OperationRecordSchema = z
  .object({
    id: z.string().regex(uuidV4),
    lockNonce: z.string().regex(uuidV4),
    kind: OperationKindSchema,
    status: OperationStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    request: z.record(z.string(), z.string()),
    txHash: z.string().regex(txHash).optional(),
    receiptStatus: z.enum(["checkpointed", "proven", "finalized", "finalized-failed"]).optional(),
    receiptBlockNumber: decimal.optional(),
    receiptBlockHash: z.string().regex(txHash).optional(),
    withdrawals: z
      .array(
        z
          .object({
            withdrawalIndex: z.number().int().nonnegative(),
            finalizationData: z.string().regex(hex),
            operationId: z.string().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    error: z
      .enum([
        "operation failed before Aztec node submission",
        "operation outcome requires transaction reconciliation",
        "operation finalized with a reverted receipt",
      ])
      .optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const crossedSubmissionBoundary =
      record.status === "broadcast" ||
      record.status === "complete" ||
      record.status === "failed" ||
      record.status === "in_doubt";
    if (crossedSubmissionBoundary !== (record.txHash !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "transaction hash does not match the operation status",
      });
    }
    if (
      record.receiptStatus !== undefined &&
      record.status !== "complete" &&
      record.status !== "failed"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "only a terminal submitted operation may carry a receipt status",
      });
    }
    const hasReceiptBlockNumber = record.receiptBlockNumber !== undefined;
    const hasReceiptBlockHash = record.receiptBlockHash !== undefined;
    if (hasReceiptBlockNumber !== hasReceiptBlockHash) {
      ctx.addIssue({
        code: "custom",
        message: "receipt block evidence must be complete",
      });
    }
    if (
      hasReceiptBlockNumber &&
      record.receiptStatus !== "finalized" &&
      record.receiptStatus !== "finalized-failed"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "receipt block evidence requires a finalized receipt",
      });
    }
    const finalizedFailureEvidence =
      record.receiptStatus === "finalized-failed" &&
      record.receiptBlockNumber !== undefined &&
      record.receiptBlockHash !== undefined &&
      record.error === "operation finalized with a reverted receipt";
    if (record.status === "failed" && !finalizedFailureEvidence) {
      ctx.addIssue({
        code: "custom",
        message: "a failed operation requires finalized reverted receipt evidence",
      });
    }
    if (record.status !== "failed" && record.receiptStatus === "finalized-failed") {
      ctx.addIssue({
        code: "custom",
        message: "only a failed operation may carry finalized-failed receipt status",
      });
    }
    if (
      record.error !== undefined &&
      record.status !== "aborted" &&
      record.status !== "in_doubt" &&
      record.status !== "complete" &&
      record.status !== "failed"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "an operation cannot carry an error before a failed outcome",
      });
    }
  });
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

const ActiveLockSchema = z
  .object({
    id: z.string().regex(uuidV4),
    lockNonce: z.string().regex(uuidV4),
    kind: OperationKindSchema,
    record: OperationRecordSchema.optional(),
  })
  .strict()
  .superRefine((lock, ctx) => {
    if (
      lock.record !== undefined &&
      (lock.record.id !== lock.id ||
        lock.record.lockNonce !== lock.lockNonce ||
        lock.record.kind !== lock.kind)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "embedded operation record does not own the active lock",
      });
    }
  });
type ActiveLock = z.infer<typeof ActiveLockSchema>;

const ReleaseClaimSchema = z
  .object({
    id: z.string().regex(uuidV4),
    lockNonce: z.string().regex(uuidV4),
    pid: z.number().int().positive(),
    nonce: z.string().regex(uuidV4),
  })
  .strict();
type ReleaseClaim = z.infer<typeof ReleaseClaimSchema>;

/** A finished operation (complete, failed or aborted): its outcome is known and it holds no lock. */
export function isTerminalStatus(status: OperationStatus): boolean {
  return status === "complete" || status === "failed" || status === "aborted";
}

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  building: ["broadcast", "aborted"],
  broadcast: ["complete", "failed", "aborted", "in_doubt"],
  in_doubt: ["complete", "failed", "in_doubt"],
  complete: [],
  failed: [],
  aborted: [],
};

const DIRECTORY = "operations/";
const LOCK_KEY = `${DIRECTORY}active.lock`;
const recordKey = (id: string) => `${DIRECTORY}${id}.json`;
/**
 * A spend's or exit's one submission decision, created atomically by whichever comes first: its
 * holder sending it (`claimSubmission`) or a successor aborting it (`abortAbandonedRun`).
 */
const submissionKey = (owner: Pick<OperationRecord, "id" | "lockNonce">) =>
  `${DIRECTORY}submission-${owner.id}-${owner.lockNonce}.lock`;
const SubmissionDecisionSchema = z
  .object({
    id: z.string().regex(uuidV4),
    lockNonce: z.string().regex(uuidV4),
    outcome: z.enum(["send", "abort"]),
  })
  .strict();

/**
 * Created atomically by `restoreJournals` and held for the whole restore; `begin` refuses while it
 * exists. Outside `operations/`, so an empty journal stays empty.
 */
export const RESTORE_MARKER_KEY = "restore.lock";

function sameOwner(left: ActiveLock, right: ActiveLock): boolean {
  return left.id === right.id && left.lockNonce === right.lockNonce && left.kind === right.kind;
}

/** The lock namespace of one recipient's journal (contract C): `xochi-recipient:<address>:operations`. */
export function operationsLockName(address: string): string {
  return `xochi-recipient:${address.toLowerCase()}:operations`;
}

/**
 * The lock a journal holder holds for as long as it runs. A process (CLI: its pid) or tab
 * (browser: a random session id) is alive exactly while this name is held: `LockManager` answers
 * null for it. Receipt runs and release claims record the pid, so a successor can tell a crashed
 * holder from a live one.
 */
export function holderLockName(lockName: string, pid: number): string {
  return `${lockName}:holder:${pid}`;
}

/**
 * Who runs this journal: its `pid` is recorded in every run's request and in release claims;
 * `host` only in receipt runs, for the operator.
 */
export interface JournalHolder {
  pid: number;
  host: string;
}

export interface OperationJournalOptions {
  kv: KeyValueStore;
  locks: LockManager;
  clock: Clock;
  /** `operationsLockName(address)`. */
  lockName: string;
  holder: JournalHolder;
  /** How a key is named in messages (the CLI: its file path). Defaults to the key. */
  describeKey?: (key: string) => string;
  /** Test seam: runs once a lock release claim is durable, before the lock is removed. */
  afterReleaseClaimed?: (id: string) => void | Promise<void>;
  /** Test seam: runs once the first lock write is durable, before the record is published. */
  afterInitialLockSynced?: (id: string) => void | Promise<void>;
}

/**
 * Fund-moving commands are single-flight across processes, tabs and restarts. The first durable
 * `active.lock` write embeds the exact initial record, including a precomputed transaction hash
 * for broadcast operations. The standalone record is then made durable before the embedded copy
 * is removed. A crash at either boundary therefore has one exact recovery source. Only an observed
 * durable receipt or a failure proven to precede submission releases the lock. Every write
 * resolves once durable (`KeyValueStore`), so a record naming a transaction hash is durable before
 * the caller may broadcast that transaction.
 */
export class OperationJournal {
  private readonly kv: KeyValueStore;
  private readonly locks: LockManager;
  private readonly clock: Clock;
  private readonly lockName: string;
  readonly holder: JournalHolder;
  private readonly describeKey: (key: string) => string;
  private readonly afterReleaseClaimed: (id: string) => void | Promise<void>;
  private readonly afterInitialLockSynced: (id: string) => void | Promise<void>;
  /** The holder lease: undefined until the first write; null when another live holder has it. */
  private session: LockLease | null | undefined;

  constructor(options: OperationJournalOptions) {
    if (!Number.isSafeInteger(options.holder.pid) || options.holder.pid <= 0) {
      throw new Error("operation journal holder pid must be a positive integer");
    }
    this.kv = options.kv;
    this.locks = options.locks;
    this.clock = options.clock;
    this.lockName = options.lockName;
    this.holder = { ...options.holder };
    this.describeKey = options.describeKey ?? ((key) => key);
    this.afterReleaseClaimed = options.afterReleaseClaimed ?? (() => undefined);
    this.afterInitialLockSynced = options.afterInitialLockSynced ?? (() => undefined);
  }

  /** Releases this holder's lease (browser: a successor may now recover its receipt run). */
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await session.release();
  }

  async records(): Promise<OperationRecord[]> {
    const records: OperationRecord[] = [];
    for (const key of await this.kv.list(DIRECTORY)) {
      const entry = key.slice(DIRECTORY.length);
      if (!entry.endsWith(".json")) continue;
      const record = await this.readRecord(key);
      if (entry !== `${record.id}.json`) {
        throw new Error(
          `operation journal record ${entry} does not own its filename; keep fund movement blocked`,
        );
      }
      records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<OperationRecord> {
    if (!uuidV4.test(id)) {
      throw new Error("operation journal id is invalid; keep fund movement blocked");
    }
    return this.readRecord(recordKey(id));
  }

  async unresolved(): Promise<OperationRecord | null> {
    return (await this.records()).find((record) => !isTerminalStatus(record.status)) ?? null;
  }

  async activeUnresolved(): Promise<OperationRecord | null> {
    if ((await this.kv.get(LOCK_KEY)) === null) return null;
    const record = await this.recordForLock(await this.readActiveLock());
    return isTerminalStatus(record.status) ? null : record;
  }

  /**
   * Restores an encrypted backup's journal into a new, empty data directory. An unresolved
   * operation recreates its exact ownership lock, so the second host can reconcile but cannot
   * accidentally replace it with another fund-moving operation. An unfinished `receipt` run moved
   * no funds and its process is on another host: it is restored aborted, without a lock.
   */
  async restore(recordsInput: readonly unknown[]): Promise<void> {
    if ((await this.kv.list(DIRECTORY)).length !== 0) {
      throw new Error("operation journal restore needs an empty destination");
    }
    const records = recordsInput
      .map((record) => OperationRecordSchema.parse(record))
      .map((record) =>
        record.kind === "receipt" && !isTerminalStatus(record.status)
          ? OperationRecordSchema.parse({ ...record, status: "aborted" })
          : record,
      );
    const ids = new Set(records.map((record) => record.id));
    if (ids.size !== records.length)
      throw new Error("operation journal backup contains duplicate ids");
    const unresolved = records.filter((record) => !isTerminalStatus(record.status));
    if (unresolved.length > 1) {
      throw new Error("operation journal backup contains more than one unresolved operation");
    }
    for (const record of records) await this.kv.put(recordKey(record.id), prettyJsonBytes(record));
    const active = unresolved[0];
    if (active) {
      await this.kv.put(
        LOCK_KEY,
        prettyJsonBytes({ id: active.id, lockNonce: active.lockNonce, kind: active.kind }),
      );
    }
  }

  /**
   * Starts a `building` operation. Its request records this holder's `pid` unless the caller
   * names one (`beginReceipt`), so a successor can tell an abandoned run from a live one
   * (`abortAbandonedRun`). Liveness needs the pid alone: no hostname is recorded (an older
   * record's `host` is read and ignored). When supplied, `journalId` is the exact UUIDv4 record
   * id; omission keeps the generated-id behaviour.
   */
  begin(
    kind: OperationRecord["kind"],
    request: Record<string, string>,
    journalId?: string,
  ): Promise<OperationRecord> {
    return this.beginWithState(
      kind,
      { ...request, pid: request["pid"] ?? String(this.holder.pid) },
      { status: "building" },
      journalId,
    );
  }

  /**
   * Holds the fund-movement lock for one `receipt` run. A receipt moves no funds; holding the
   * lock keeps any spend, exit or refund from running while it checks and signs a payout, and
   * refuses the receipt while one is unresolved. The record names the holding process: the next
   * `begin` aborts the lock once that holder is gone (its holder lock is free). Liveness is the
   * pid alone (a hostname can change under a live run); a pid reused after a crash keeps the lock
   * until `operations reconcile` releases it (`releaseReceiptLock`). `host` is recorded for the
   * operator.
   */
  beginReceipt(intentId: string, holder: JournalHolder = this.holder): Promise<OperationRecord> {
    return this.begin("receipt", { intentId, pid: String(holder.pid), host: holder.host });
  }

  /**
   * Releases a receipt run's lock; its record ends `aborted`, as it moved no funds. A record the
   * operator already released (`releaseReceiptLock`) is left as it is: the run's own result,
   * accepted or not, is never masked by its lock's release.
   */
  async endReceipt(id: string): Promise<void> {
    if ((await this.get(id)).status !== "building") return;
    await this.update(id, { status: "aborted" });
  }

  /**
   * The operator's release of an unfinished `receipt` run's lock (`operations reconcile`): it
   * moved no funds. Refused while the recorded holder is alive, unless `force` (a reused pid
   * after a crash): releasing a live run's lock would let a spend run beside it.
   */
  async releaseReceiptLock(id: string, { force = false }: { force?: boolean } = {}): Promise<void> {
    const record = await this.get(id);
    if (record.kind !== "receipt" || record.status !== "building") {
      throw new Error(`operation ${id} is not an unfinished receipt run`);
    }
    if (!force && (await this.holderAlive(Number(record.request["pid"])))) {
      throw new Error(
        `receipt run pid ${record.request["pid"]} on ${record.request["host"]} is still running; wait for it. Only if that process is not a receipt run (its pid was reused after a crash), pass --force`,
      );
    }
    await this.update(id, { status: "aborted" });
  }

  /**
   * Aborts an unfinished `building` run whose recorded holder is gone: a `receipt` run (it moved
   * no funds) or a spend or exit that never reached the Aztec node. A spend's or exit's tx hash is
   * durable in its record before the node can receive the transaction (`recordBroadcastBeforeSend`
   * runs before `sendTx`), so a `building` record, which names no hash, was never sent; a gone
   * holder can no longer send it. A spend or exit is aborted only if this abort wins its
   * submission decision: a holder that already claimed it (`claimSubmission`) is sending, so it is
   * left as it is. An exit's prepared withdrawals stay in its record. Answers null, changing
   * nothing, while the holder is alive, when the record names none (a spend or exit begun before
   * `begin` recorded its holder) or when its holder claimed the submission. `ownRunSettled`: this
   * journal's own holder runs nothing for the record any more (its call returned), so a record it
   * names counts as abandoned although its holder lease is held.
   */
  async abortAbandonedRun(
    id: string,
    { ownRunSettled = false }: { ownRunSettled?: boolean } = {},
  ): Promise<OperationRecord | null> {
    const record = await this.get(id);
    const abandonable =
      record.kind === "receipt" || record.kind === "spend" || record.kind === "exit";
    if (!abandonable || record.status !== "building") {
      throw new Error(`operation ${id} is not an unfinished receipt run, spend or exit`);
    }
    if (!(ownRunSettled && this.namesThisHolder(record))) {
      if ((await this.recordedHolderAlive(record)) !== false) return null;
    }
    if (record.kind !== "receipt" && (await this.decideSubmission(record, "abort")) !== "abort") {
      return null;
    }
    return this.update(id, { status: "aborted" });
  }

  /**
   * Claims a `building` spend's or exit's submission for its holder, before its broadcast record
   * (`recordBroadcastBeforeSend`). Refused once a successor's abort decided it: that operation
   * is aborted and must not be sent. Also refused, before deciding, once this holder's lease was
   * taken away (`LockLease.lost`): a successor may now judge this holder dead and abort it.
   */
  async claimSubmission(id: string): Promise<void> {
    const lost = this.session?.lost;
    if (lost?.aborted) {
      throw new Error(
        `this session lost its holder lease to another context; operation ${id} was not sent: reopen the recipient before moving funds`,
        { cause: lost.reason },
      );
    }
    if ((await this.decideSubmission(await this.get(id), "send")) !== "send") {
      throw new Error(
        `operation ${id} was aborted by another session before its submission; it was not sent`,
      );
    }
  }

  /**
   * Creates the operation's submission decision as `outcome` unless one exists; answers the
   * decision that holds. An abort that crashed after deciding finds its own decision again.
   */
  private async decideSubmission(
    record: OperationRecord,
    outcome: "send" | "abort",
  ): Promise<"send" | "abort"> {
    const key = submissionKey(record);
    try {
      await this.kv.create(
        key,
        prettyJsonBytes({ id: record.id, lockNonce: record.lockNonce, outcome }),
      );
      return outcome;
    } catch (error) {
      if (!(error instanceof KeyExistsError)) throw error;
    }
    const bytes = await this.kv.get(key);
    const decision = SubmissionDecisionSchema.parse(bytes === null ? null : parseJsonBytes(bytes));
    if (decision.id !== record.id || decision.lockNonce !== record.lockNonce) {
      throw new Error(`operation ${record.id} submission decision does not own its key`);
    }
    return decision.outcome;
  }

  /**
   * Whether the holder a record names (its request's `pid`) still runs; null when the record
   * names none (a spend or exit begun before `begin` recorded its holder).
   */
  async recordedHolderAlive(record: OperationRecord): Promise<boolean | null> {
    const pid = record.request["pid"];
    return pid === undefined ? null : this.holderAlive(Number(pid));
  }

  /** Whether the record names this journal's own holder (its request's `pid`). */
  namesThisHolder(record: OperationRecord): boolean {
    return record.request["pid"] === String(this.holder.pid);
  }

  /**
   * Persists a precomputed transaction hash in the first operation record write. The caller may
   * submit only after this method resolves, so no returned operation can ever be hashless.
   */
  beginBroadcast(
    kind: OperationRecord["kind"],
    request: Record<string, string>,
    initialTxHash: string,
  ): Promise<OperationRecord> {
    return this.beginWithState(kind, request, {
      status: "broadcast",
      txHash: initialTxHash,
    });
  }

  private async beginWithState(
    kind: OperationRecord["kind"],
    request: Record<string, string>,
    initial: { status: "building" } | { status: "broadcast"; txHash: string },
    journalId?: string,
  ): Promise<OperationRecord> {
    const id = journalId ?? crypto.randomUUID();
    if (!uuidV4.test(id)) throw new Error("journal id must be a UUIDv4");
    const owner: ActiveLock = { id, lockNonce: crypto.randomUUID(), kind };
    const now = this.now();
    const record = OperationRecordSchema.parse({
      ...owner,
      ...initial,
      createdAt: now,
      updatedAt: now,
      request,
    });
    if ((await this.kv.get(recordKey(owner.id))) !== null) {
      throw new DuplicateOperationIdError(owner.id);
    }
    const recoverableLock: ActiveLock = { ...owner, record };
    await this.holdSession();
    for (;;) {
      try {
        await this.kv.create(LOCK_KEY, compactJsonBytes(recoverableLock));
        break;
      } catch (error) {
        if (!(error instanceof KeyExistsError)) throw error;
        if ((await this.releaseRecoveredTerminalLock()) || (await this.abortDeadReceiptRun())) {
          continue;
        }
        const unresolved = await this.unresolved();
        if (unresolved?.kind === "receipt") {
          throw new Error(
            `a receipt run (pid ${unresolved.request["pid"]} on ${unresolved.request["host"]}) holds the fund-movement lock; wait for it`,
          );
        }
        throw new Error(
          unresolved
            ? `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`
            : `operation lock ${this.describeKey(LOCK_KEY)} exists without its exact readable terminal record; do not move funds until it is reconciled`,
        );
      }
    }
    if ((await this.kv.get(RESTORE_MARKER_KEY)) !== null) {
      await this.kv.delete(LOCK_KEY);
      throw new Error(
        `a journal restore holds this profile (${this.describeKey(RESTORE_MARKER_KEY)}); move funds once it finishes`,
      );
    }
    await this.afterInitialLockSynced(owner.id);

    let recordPublished = false;
    try {
      const unresolved = await this.unresolved();
      if (unresolved) {
        throw new Error(
          `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`,
        );
      }
      try {
        await this.kv.create(recordKey(owner.id), prettyJsonBytes(record));
      } catch (error) {
        if (error instanceof KeyExistsError) {
          throw new DuplicateOperationIdError(owner.id, { cause: error });
        }
        throw error;
      }
      recordPublished = true;
      await this.kv.put(LOCK_KEY, prettyJsonBytes(owner));
      return record;
    } catch (error) {
      if (!recordPublished) await this.releaseLock(owner);
      throw error;
    }
  }

  /**
   * Applies `patch` while the operation owns the lock. Completing an operation that is already
   * `complete` with the same tx hash answers it unchanged: a reconcile may have completed it, and
   * released its lock, while its holder still waited for the receipt.
   */
  async update(
    id: string,
    patch: Partial<Omit<OperationRecord, "id" | "lockNonce" | "kind" | "createdAt">>,
  ): Promise<OperationRecord> {
    const current = await this.get(id);
    if (
      current.status === "complete" &&
      patch.status === "complete" &&
      (patch.txHash === undefined || patch.txHash === current.txHash)
    ) {
      return current;
    }
    const owner: ActiveLock = {
      id: current.id,
      lockNonce: current.lockNonce,
      kind: current.kind,
    };
    await this.assertOwnsActiveLock(owner);
    if (
      patch.status !== undefined &&
      patch.status !== current.status &&
      !transitions[current.status].includes(patch.status)
    ) {
      throw new Error(
        `operation ${id} cannot transition from ${current.status} to ${patch.status}; keep fund movement blocked`,
      );
    }
    const next = OperationRecordSchema.parse({
      ...current,
      ...patch,
      updatedAt: this.now(),
    });
    await this.kv.put(recordKey(id), prettyJsonBytes(next));
    if (isTerminalStatus(next.status)) await this.releaseLock(owner);
    return next;
  }

  async failOrAbort(id: string, submissionBoundaryReached?: boolean): Promise<Error> {
    const current = await this.get(id);
    if (isTerminalStatus(current.status)) {
      return new Error(
        "operation reached a terminal journal state but lock release was interrupted; restart before moving funds",
      );
    }
    const beforeSubmission =
      submissionBoundaryReached === false &&
      (current.status === "building" || current.status === "broadcast");
    const inferredBeforeSubmission =
      submissionBoundaryReached === undefined && current.status === "building";
    const abort = beforeSubmission || inferredBeforeSubmission;
    const message = abort
      ? "operation failed before Aztec node submission"
      : "operation outcome requires transaction reconciliation";
    await this.update(id, {
      status: abort ? "aborted" : "in_doubt",
      txHash: abort ? undefined : current.txHash,
      error: message,
    });
    return new Error(message);
  }

  /** The record's name in messages (the CLI: its file path). */
  path(id: string): string {
    return this.describeKey(recordKey(id));
  }

  private now(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }

  private async readRecord(key: string): Promise<OperationRecord> {
    try {
      const bytes = await this.kv.get(key);
      if (bytes === null) throw new Error("absent");
      return OperationRecordSchema.parse(parseJsonBytes(bytes));
    } catch {
      throw new Error(
        `operation journal record ${this.describeKey(key)} is unreadable; keep fund movement blocked`,
      );
    }
  }

  private async readActiveLock(): Promise<ActiveLock> {
    try {
      const bytes = await this.kv.get(LOCK_KEY);
      if (bytes === null) throw new Error("absent");
      return ActiveLockSchema.parse(parseJsonBytes(bytes));
    } catch {
      throw new Error(
        `operation lock ${this.describeKey(LOCK_KEY)} is unreadable; keep fund movement blocked`,
      );
    }
  }

  /** Takes this holder's lease once; a null answer means this pid is already held (alive). */
  private async holdSession(): Promise<void> {
    if (this.session !== undefined) return;
    this.session = await this.locks.tryAcquire(holderLockName(this.lockName, this.holder.pid), {
      id: String(this.holder.pid),
      nonce: crypto.randomUUID(),
      kind: "journal-holder",
    });
  }

  /** True while the holder that recorded `pid` holds its holder lock. */
  private async holderAlive(pid: number): Promise<boolean> {
    const probe = await this.locks.tryAcquire(holderLockName(this.lockName, pid), {
      id: String(pid),
      nonce: crypto.randomUUID(),
      kind: "liveness-probe",
    });
    if (probe === null) return true;
    await probe.release();
    return false;
  }

  private async assertOwnsActiveLock(owner: ActiveLock): Promise<void> {
    const lock = await this.readActiveLock();
    if (!sameOwner(lock, owner)) {
      throw new Error(
        `operation ${owner.id} does not exactly own ${this.describeKey(LOCK_KEY)}; keep fund movement blocked`,
      );
    }
  }

  private async recordForLock(lock: ActiveLock): Promise<OperationRecord> {
    let record: OperationRecord;
    if ((await this.kv.get(recordKey(lock.id))) !== null) {
      record = await this.get(lock.id);
    } else {
      if (lock.record === undefined) {
        throw new Error(
          `operation lock ${this.describeKey(LOCK_KEY)} has no recoverable record; keep fund movement blocked`,
        );
      }
      record = lock.record;
      await this.kv.put(recordKey(lock.id), prettyJsonBytes(record));
    }
    if (record.id !== lock.id || record.lockNonce !== lock.lockNonce || record.kind !== lock.kind) {
      throw new Error(
        `operation lock ${this.describeKey(LOCK_KEY)} does not own its exact record; keep fund movement blocked`,
      );
    }
    if (lock.record !== undefined) {
      await this.kv.put(
        LOCK_KEY,
        prettyJsonBytes({ id: lock.id, lockNonce: lock.lockNonce, kind: lock.kind }),
      );
    }
    return record;
  }

  /** Aborts the lock of a `receipt` run whose holder is gone. */
  private async abortDeadReceiptRun(): Promise<boolean> {
    let record: OperationRecord;
    try {
      record = await this.recordForLock(await this.readActiveLock());
    } catch {
      return false;
    }
    if (record.kind !== "receipt" || record.status !== "building") return false;
    if (await this.holderAlive(Number(record.request["pid"]))) return false;
    await this.update(record.id, { status: "aborted" });
    return true;
  }

  private async releaseRecoveredTerminalLock(): Promise<boolean> {
    let lock: ActiveLock;
    try {
      lock = await this.readActiveLock();
    } catch {
      return false;
    }

    let record: OperationRecord;
    try {
      record = await this.recordForLock(lock);
    } catch {
      return false;
    }
    if (!isTerminalStatus(record.status)) {
      return false;
    }
    try {
      if ((await this.records()).some((candidate) => !isTerminalStatus(candidate.status)))
        return false;
    } catch {
      return false;
    }

    await this.releaseLock(lock);
    return true;
  }

  private async releaseLock(owner: ActiveLock): Promise<void> {
    await this.assertOwnsActiveLock(owner);
    await this.holdSession();

    // Every release path atomically creates a complete, durable claim in an append-only chain.
    // A dead claimant is superseded at the next deterministic key. Claims are never removed or
    // replaced, so concurrent recoverers cannot remove a replacement operation's lock.
    let claimKey = `${DIRECTORY}released-${owner.id}-${owner.lockNonce}.lock`;
    const visitedClaims = new Set<string>();
    for (;;) {
      if (visitedClaims.has(claimKey)) {
        throw new Error(`operation ${owner.id} lock release claim chain contains a cycle`);
      }
      visitedClaims.add(claimKey);

      const candidate: ReleaseClaim = {
        id: owner.id,
        lockNonce: owner.lockNonce,
        pid: this.holder.pid,
        nonce: crypto.randomUUID(),
      };
      try {
        await this.kv.create(claimKey, prettyJsonBytes(candidate));
        break;
      } catch (error) {
        if (!(error instanceof KeyExistsError)) throw error;
      }

      let claim: ReleaseClaim;
      try {
        const bytes = await this.kv.get(claimKey);
        if (bytes === null) throw new Error("absent");
        claim = ReleaseClaimSchema.parse(parseJsonBytes(bytes));
      } catch {
        throw new Error(
          `operation ${owner.id} lock release claim is unreadable; ${this.describeKey(LOCK_KEY)} remains held`,
        );
      }
      if (
        claim.id !== owner.id ||
        claim.lockNonce !== owner.lockNonce ||
        (await this.holderAlive(claim.pid))
      ) {
        throw new Error(
          `operation ${owner.id} lock release is already claimed; ${this.describeKey(LOCK_KEY)} remains held`,
        );
      }
      claimKey = `${DIRECTORY}released-${owner.id}-${owner.lockNonce}-${claim.nonce}.lock`;
    }

    await this.afterReleaseClaimed(owner.id);
    await this.assertOwnsActiveLock(owner);
    await this.kv.delete(LOCK_KEY);
  }
}
