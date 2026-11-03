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
import { dirname, join } from "node:path";
import { z } from "zod4";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = /^0x[0-9a-f]+$/i;
const txHash = /^0x[0-9a-f]{64}$/i;
const OperationStatusSchema = z.enum(["building", "broadcast", "complete", "aborted", "in_doubt"]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

const OperationRecordSchema = z
  .object({
    id: z.string().regex(uuidV4),
    lockNonce: z.string().regex(uuidV4),
    kind: z.enum(["spend", "exit"]),
    status: OperationStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    request: z.record(z.string(), z.string()),
    txHash: z.string().regex(txHash).optional(),
    receiptStatus: z.enum(["checkpointed", "proven", "finalized"]).optional(),
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
      ])
      .optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const crossedSubmissionBoundary =
      record.status === "broadcast" || record.status === "complete" || record.status === "in_doubt";
    if (crossedSubmissionBoundary !== (record.txHash !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "transaction hash does not match the operation status",
      });
    }
    if (record.receiptStatus !== undefined && record.status !== "complete") {
      ctx.addIssue({
        code: "custom",
        message: "only a complete operation may carry a receipt status",
      });
    }
    if (
      record.error !== undefined &&
      record.status !== "aborted" &&
      record.status !== "in_doubt" &&
      record.status !== "complete"
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
    kind: z.enum(["spend", "exit"]),
  })
  .strict();
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

const terminal = (status: OperationStatus) => status === "complete" || status === "aborted";

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  building: ["broadcast", "aborted"],
  broadcast: ["complete", "in_doubt"],
  in_doubt: ["complete", "in_doubt"],
  complete: [],
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

function writePrivateJson(path: string, value: unknown): void {
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
 * Fund-moving commands are single-flight across processes and restarts. `active.lock` is created
 * with O_EXCL and fsynced before any build work. Its random ownership nonce is also in the record.
 * The record is fsynced again at the ambiguous-send boundary, before the node can receive the
 * transaction. Only an observed durable receipt or a failure proven to precede that boundary
 * releases the lock.
 */
export class OperationJournal {
  private readonly lockPath: string;

  constructor(
    readonly directory: string,
    private readonly afterReleaseClaimed: (id: string) => void = () => undefined,
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
    const record = this.get(lock.id);
    if (record.id !== lock.id || record.lockNonce !== lock.lockNonce || record.kind !== lock.kind) {
      throw new Error(
        `operation lock ${this.lockPath} does not own its exact record; keep fund movement blocked`,
      );
    }
    return terminal(record.status) ? null : record;
  }

  begin(kind: OperationRecord["kind"], request: Record<string, string>): OperationRecord {
    const owner: ActiveLock = { id: randomUUID(), lockNonce: randomUUID(), kind };
    let lockFd: number;
    for (;;) {
      try {
        lockFd = openSync(this.lockPath, "wx", 0o600);
        break;
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "EEXIST") throw error;
        if (this.releaseRecoveredTerminalLock()) continue;
        const unresolved = this.unresolved();
        throw new Error(
          unresolved
            ? `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`
            : `operation lock ${this.lockPath} exists without its exact readable terminal record; do not move funds until it is reconciled`,
        );
      }
    }

    try {
      writeSync(lockFd, `${JSON.stringify(owner)}\n`);
      fsyncSync(lockFd);
    } finally {
      closeSync(lockFd);
    }
    syncDirectory(this.directory);

    try {
      const unresolved = this.unresolved();
      if (unresolved) {
        throw new Error(
          `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`,
        );
      }

      const now = new Date().toISOString();
      const record = OperationRecordSchema.parse({
        ...owner,
        status: "building",
        createdAt: now,
        updatedAt: now,
        request,
      });
      writePrivateJson(this.path(owner.id), record);
      return record;
    } catch (error) {
      this.releaseLock(owner);
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

  failOrAbort(id: string): Error {
    const current = this.get(id);
    if (terminal(current.status)) {
      return new Error(
        `operation ${id} reached a terminal journal state but lock release was interrupted; restart before moving funds`,
      );
    }
    const beforeSubmission = current.status === "building";
    const message = beforeSubmission
      ? "operation failed before Aztec node submission"
      : "operation outcome requires transaction reconciliation";
    this.update(id, {
      status: beforeSubmission ? "aborted" : "in_doubt",
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

  private releaseRecoveredTerminalLock(): boolean {
    let lock: ActiveLock;
    try {
      lock = readActiveLock(this.lockPath);
    } catch {
      return false;
    }

    let record: OperationRecord;
    try {
      record = this.get(lock.id);
    } catch {
      return false;
    }
    if (
      record.id !== lock.id ||
      record.lockNonce !== lock.lockNonce ||
      record.kind !== lock.kind ||
      !terminal(record.status)
    ) {
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
