import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod4";

import { decimal } from "./corridor.js";

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

const terminal = (status: OperationStatus) =>
  status === "complete" || status === "failed" || status === "aborted";

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  building: ["broadcast", "aborted"],
  broadcast: ["complete", "failed", "aborted", "in_doubt"],
  in_doubt: ["complete", "failed", "in_doubt"],
  complete: [],
  failed: [],
  aborted: [],
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  syncDirectory(dirname(path));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readRecord(path: string): OperationRecord {
  try {
    return OperationRecordSchema.parse(readJson(path));
  } catch {
    throw new Error(`operation journal record ${path} is unreadable; keep fund movement blocked`);
  }
}

function readActiveLock(path: string): ActiveLock {
  try {
    return ActiveLockSchema.parse(readJson(path));
  } catch {
    throw new Error(`operation lock ${path} is unreadable; keep fund movement blocked`);
  }
}

function sameOwner(left: ActiveLock, right: ActiveLock): boolean {
  return left.id === right.id && left.lockNonce === right.lockNonce && left.kind === right.kind;
}

/**
 * Fund-moving commands are single-flight across processes and restarts. The first durable
 * `active.lock` write embeds the exact initial record, including a precomputed transaction hash
 * for broadcast operations. The standalone record is then fsynced before the embedded copy is
 * removed. A crash at either boundary therefore has one exact recovery source. Only an observed
 * durable receipt or a failure proven to precede submission releases the lock.
 */
export class OperationJournal {
  private readonly lockPath: string;

  constructor(
    readonly directory: string,
    private readonly afterReleaseClaimed: (id: string) => void = () => undefined,
    private readonly afterInitialLockSynced: (id: string) => void = () => undefined,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lockPath = join(directory, "active.lock");
  }

  records(): OperationRecord[] {
    return readdirSync(this.directory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        const record = readRecord(join(this.directory, entry));
        if (entry !== `${record.id}.json`) {
          throw new Error(
            `operation journal record ${entry} does not own its filename; keep fund movement blocked`,
          );
        }
        return record;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): OperationRecord {
    if (!uuidV4.test(id)) {
      throw new Error("operation journal id is invalid; keep fund movement blocked");
    }
    return readRecord(this.path(id));
  }

  unresolved(): OperationRecord | null {
    return this.records().find((record) => !terminal(record.status)) ?? null;
  }

  activeUnresolved(): OperationRecord | null {
    if (!existsSync(this.lockPath)) return null;
    const lock = readActiveLock(this.lockPath);
    const record = this.recordForLock(lock);
    return terminal(record.status) ? null : record;
  }

  /**
   * Restores an encrypted backup's journal into a new, empty data directory. An unresolved
   * operation recreates its exact ownership lock, so the second host can reconcile but cannot
   * accidentally replace it with another fund-moving operation. An unfinished `receipt` run moved
   * no funds and its process is on another host: it is restored aborted, without a lock.
   */
  restore(recordsInput: readonly unknown[]): void {
    if (readdirSync(this.directory).length !== 0) {
      throw new Error("operation journal restore needs an empty destination");
    }
    const records = recordsInput
      .map((record) => OperationRecordSchema.parse(record))
      .map((record) =>
        record.kind === "receipt" && !terminal(record.status)
          ? OperationRecordSchema.parse({ ...record, status: "aborted" })
          : record,
      );
    const ids = new Set(records.map((record) => record.id));
    if (ids.size !== records.length)
      throw new Error("operation journal backup contains duplicate ids");
    const unresolved = records.filter((record) => !terminal(record.status));
    if (unresolved.length > 1) {
      throw new Error("operation journal backup contains more than one unresolved operation");
    }
    for (const record of records) writePrivateJson(this.path(record.id), record);
    const active = unresolved[0];
    if (active) {
      writePrivateJson(this.lockPath, {
        id: active.id,
        lockNonce: active.lockNonce,
        kind: active.kind,
      });
    }
  }

  begin(kind: OperationRecord["kind"], request: Record<string, string>): OperationRecord {
    return this.beginWithState(kind, request, { status: "building" });
  }

  /**
   * Holds the fund-movement lock for one `receipt` run. A receipt moves no funds; holding the
   * lock keeps any spend, exit or refund from running while it checks and signs a payout, and
   * refuses the receipt while one is unresolved. The record names the holding process: the next
   * `begin` aborts the lock once that process is gone. Liveness is the pid alone (a hostname can
   * change under a live run); a pid reused after a crash keeps the lock until `operations
   * reconcile` releases it (`releaseReceiptLock`). `host` is recorded for the operator.
   */
  beginReceipt(
    intentId: string,
    holder: { pid: number; host: string } = { pid: process.pid, host: hostname() },
  ): OperationRecord {
    return this.begin("receipt", { intentId, pid: String(holder.pid), host: holder.host });
  }

  /**
   * Releases a receipt run's lock; its record ends `aborted`, as it moved no funds. A record the
   * operator already released (`releaseReceiptLock`) is left as it is: the run's own result,
   * accepted or not, is never masked by its lock's release.
   */
  endReceipt(id: string): void {
    if (this.get(id).status !== "building") return;
    this.update(id, { status: "aborted" });
  }

  /**
   * The operator's release of an unfinished `receipt` run's lock (`operations reconcile`): it
   * moved no funds. Refused while the recorded process is alive, unless `force` (a reused pid
   * after a crash): releasing a live run's lock would let a spend run beside it.
   */
  releaseReceiptLock(id: string, { force = false }: { force?: boolean } = {}): void {
    const record = this.get(id);
    if (record.kind !== "receipt" || record.status !== "building") {
      throw new Error(`operation ${id} is not an unfinished receipt run`);
    }
    if (!force && processAlive(Number(record.request["pid"]))) {
      throw new Error(
        `receipt run pid ${record.request["pid"]} on ${record.request["host"]} is still running; wait for it. Only if that process is not a receipt run (its pid was reused after a crash), pass --force`,
      );
    }
    this.update(id, { status: "aborted" });
  }

  /**
   * Persists a precomputed transaction hash in the first operation record write. The caller may
   * submit only after this method returns, so no returned operation can ever be hashless.
   */
  beginBroadcast(
    kind: OperationRecord["kind"],
    request: Record<string, string>,
    initialTxHash: string,
  ): OperationRecord {
    return this.beginWithState(kind, request, {
      status: "broadcast",
      txHash: initialTxHash,
    });
  }

  private beginWithState(
    kind: OperationRecord["kind"],
    request: Record<string, string>,
    initial: { status: "building" } | { status: "broadcast"; txHash: string },
  ): OperationRecord {
    const owner: ActiveLock = { id: randomUUID(), lockNonce: randomUUID(), kind };
    const now = new Date().toISOString();
    const record = OperationRecordSchema.parse({
      ...owner,
      ...initial,
      createdAt: now,
      updatedAt: now,
      request,
    });
    const recoverableLock: ActiveLock = { ...owner, record };
    let lockFd: number;
    for (;;) {
      try {
        lockFd = openSync(this.lockPath, "wx", 0o600);
        break;
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "EEXIST") throw error;
        if (this.releaseRecoveredTerminalLock() || this.abortDeadReceiptRun()) continue;
        const unresolved = this.unresolved();
        if (unresolved?.kind === "receipt") {
          throw new Error(
            `a receipt run (pid ${unresolved.request["pid"]} on ${unresolved.request["host"]}) holds the fund-movement lock; wait for it`,
          );
        }
        throw new Error(
          unresolved
            ? `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`
            : `operation lock ${this.lockPath} exists without its exact readable terminal record; do not move funds until it is reconciled`,
        );
      }
    }

    try {
      writeSync(lockFd, `${JSON.stringify(recoverableLock)}\n`);
      fsyncSync(lockFd);
    } finally {
      closeSync(lockFd);
    }
    syncDirectory(this.directory);
    this.afterInitialLockSynced(owner.id);

    let recordPublished = false;
    try {
      const unresolved = this.unresolved();
      if (unresolved) {
        throw new Error(
          `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`,
        );
      }
      writePrivateJson(this.path(owner.id), record);
      recordPublished = true;
      writePrivateJson(this.lockPath, owner);
      return record;
    } catch (error) {
      if (!recordPublished) this.releaseLock(owner);
      throw error;
    }
  }

  update(
    id: string,
    patch: Partial<Omit<OperationRecord, "id" | "lockNonce" | "kind" | "createdAt">>,
  ): OperationRecord {
    const current = this.get(id);
    const owner: ActiveLock = {
      id: current.id,
      lockNonce: current.lockNonce,
      kind: current.kind,
    };
    this.assertOwnsActiveLock(owner);
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
      updatedAt: new Date().toISOString(),
    });
    writePrivateJson(this.path(id), next);
    if (terminal(next.status)) this.releaseLock(owner);
    return next;
  }

  failOrAbort(id: string, submissionBoundaryReached?: boolean): Error {
    const current = this.get(id);
    if (terminal(current.status)) {
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
    this.update(id, {
      status: abort ? "aborted" : "in_doubt",
      txHash: abort ? undefined : current.txHash,
      error: message,
    });
    return new Error(message);
  }

  path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private assertOwnsActiveLock(owner: ActiveLock): void {
    const lock = readActiveLock(this.lockPath);
    if (!sameOwner(lock, owner)) {
      throw new Error(
        `operation ${owner.id} does not exactly own ${this.lockPath}; keep fund movement blocked`,
      );
    }
  }

  private recordForLock(lock: ActiveLock): OperationRecord {
    const recordPath = this.path(lock.id);
    let record: OperationRecord;
    if (existsSync(recordPath)) {
      record = this.get(lock.id);
    } else {
      if (lock.record === undefined) {
        throw new Error(
          `operation lock ${this.lockPath} has no recoverable record; keep fund movement blocked`,
        );
      }
      record = lock.record;
      writePrivateJson(recordPath, record);
    }
    if (record.id !== lock.id || record.lockNonce !== lock.lockNonce || record.kind !== lock.kind) {
      throw new Error(
        `operation lock ${this.lockPath} does not own its exact record; keep fund movement blocked`,
      );
    }
    if (lock.record !== undefined) {
      writePrivateJson(this.lockPath, {
        id: lock.id,
        lockNonce: lock.lockNonce,
        kind: lock.kind,
      });
    }
    return record;
  }

  /** Aborts the lock of a `receipt` run whose process is gone. */
  private abortDeadReceiptRun(): boolean {
    let record: OperationRecord;
    try {
      record = this.recordForLock(readActiveLock(this.lockPath));
    } catch {
      return false;
    }
    if (record.kind !== "receipt" || record.status !== "building") return false;
    if (processAlive(Number(record.request["pid"]))) return false;
    this.update(record.id, { status: "aborted" });
    return true;
  }

  private releaseRecoveredTerminalLock(): boolean {
    let lock: ActiveLock;
    try {
      lock = readActiveLock(this.lockPath);
    } catch {
      return false;
    }

    let record: OperationRecord;
    try {
      record = this.recordForLock(lock);
    } catch {
      return false;
    }
    if (!terminal(record.status)) {
      return false;
    }
    try {
      if (this.records().some((candidate) => !terminal(candidate.status))) return false;
    } catch {
      return false;
    }

    this.releaseLock(lock);
    return true;
  }

  private releaseLock(owner: ActiveLock): void {
    this.assertOwnsActiveLock(owner);

    // Every release path atomically links a complete, durable claim into an append-only chain.
    // A dead claimant is superseded at the next deterministic path. Claims are never removed or
    // replaced, so concurrent recoverers cannot unlink a replacement operation's lock.
    let claimPath = join(this.directory, `released-${owner.id}-${owner.lockNonce}.lock`);
    const visitedClaims = new Set<string>();
    for (;;) {
      if (visitedClaims.has(claimPath)) {
        throw new Error(`operation ${owner.id} lock release claim chain contains a cycle`);
      }
      visitedClaims.add(claimPath);

      const nonce = randomUUID();
      const candidatePath = join(
        this.directory,
        `release-${owner.id}-${owner.lockNonce}-${nonce}.claimant`,
      );
      const candidate: ReleaseClaim = {
        id: owner.id,
        lockNonce: owner.lockNonce,
        pid: process.pid,
        nonce,
      };
      writePrivateJson(candidatePath, candidate);

      let claimed = false;
      try {
        linkSync(candidatePath, claimPath);
        claimed = true;
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "EEXIST") throw error;
      } finally {
        try {
          unlinkSync(candidatePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        syncDirectory(this.directory);
      }
      if (claimed) break;

      let claim: ReleaseClaim;
      try {
        claim = ReleaseClaimSchema.parse(readJson(claimPath));
      } catch {
        throw new Error(
          `operation ${owner.id} lock release claim is unreadable; ${this.lockPath} remains held`,
        );
      }
      if (claim.id !== owner.id || claim.lockNonce !== owner.lockNonce || processAlive(claim.pid)) {
        throw new Error(
          `operation ${owner.id} lock release is already claimed; ${this.lockPath} remains held`,
        );
      }
      claimPath = join(
        this.directory,
        `released-${owner.id}-${owner.lockNonce}-${claim.nonce}.lock`,
      );
    }

    this.afterReleaseClaimed(owner.id);
    this.assertOwnsActiveLock(owner);
    unlinkSync(this.lockPath);
    syncDirectory(this.directory);
  }
}
