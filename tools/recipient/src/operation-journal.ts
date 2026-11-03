import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export type OperationStatus =
  | "building"
  | "sending"
  | "broadcast"
  | "complete"
  | "aborted"
  | "in_doubt";

export interface OperationRecord {
  id: string;
  kind: "spend" | "exit";
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  request: Record<string, string>;
  txHash?: string;
  receiptStatus?: string;
  withdrawals?: {
    withdrawalIndex: number;
    finalizationData: string;
    operationId?: string | null;
  }[];
  error?: string;
}

const terminal = (status: OperationStatus) => status === "complete" || status === "aborted";
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveLock {
  id: string;
  kind: OperationRecord["kind"];
}
interface ReleaseClaim {
  id: string;
  pid: number;
  nonce: string;
}

function releaseClaim(value: unknown): value is ReleaseClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    operationId.test(value.id) &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    "nonce" in value &&
    typeof value.nonce === "string" &&
    operationId.test(value.nonce)
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function activeLock(value: unknown): value is ActiveLock {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    operationId.test(value.id) &&
    "kind" in value &&
    (value.kind === "spend" || value.kind === "exit")
  );
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

/**
 * Fund-moving commands are single-flight across processes and restarts. `active.lock` is created
 * with O_EXCL and fsynced before any build work. The record is fsynced again at the ambiguous-send
 * boundary, before the node can receive the transaction. Only an observed receipt or a failure
 * proven to precede that boundary releases the lock.
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
      .map(
        (entry) => JSON.parse(readFileSync(join(this.directory, entry), "utf8")) as OperationRecord,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): OperationRecord {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error(`operation journal record ${id} does not exist`);
    return JSON.parse(readFileSync(path, "utf8")) as OperationRecord;
  }

  unresolved(): OperationRecord | null {
    return this.records().find((record) => !terminal(record.status)) ?? null;
  }

  begin(kind: OperationRecord["kind"], request: Record<string, string>): OperationRecord {
    const id = randomUUID();
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
            : `operation lock ${this.lockPath} exists without a readable terminal record; do not move funds until it is reconciled`,
        );
      }
    }

    try {
      writeSync(lockFd, `${JSON.stringify({ id, kind })}\n`);
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
      const record: OperationRecord = {
        id,
        kind,
        status: "building",
        createdAt: now,
        updatedAt: now,
        request,
      };
      writePrivateJson(this.path(id), record);
      return record;
    } catch (error) {
      this.releaseLock(id);
      throw error;
    }
  }

  update(
    id: string,
    patch: Partial<Omit<OperationRecord, "id" | "kind" | "createdAt">>,
  ): OperationRecord {
    const current = this.get(id);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    writePrivateJson(this.path(id), next);
    if (terminal(next.status)) this.releaseLock(id);
    return next;
  }

  failOrAbort(id: string, error: unknown): void {
    const current = this.get(id);
    this.update(id, {
      status: current.status === "building" ? "aborted" : "in_doubt",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private releaseRecoveredTerminalLock(): boolean {
    let lock: ActiveLock;
    try {
      const value: unknown = JSON.parse(readFileSync(this.lockPath, "utf8"));
      if (!activeLock(value)) return false;
      lock = value;
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
      record.kind !== lock.kind ||
      !terminal(record.status) ||
      this.records().some((candidate) => !terminal(candidate.status))
    ) {
      return false;
    }

    this.releaseLock(lock.id);
    return true;
  }

  private releaseLock(id: string): void {
    if (!existsSync(this.lockPath)) return;
    const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { id: string };
    if (lock.id !== id) throw new Error(`operation ${id} does not own ${this.lockPath}`);

    // Every release path atomically links a complete, durable claim into an append-only chain.
    // A dead claimant is superseded by linking the next deterministic path; claims are never
    // removed or replaced, so two recoverers cannot suffer an ABA race and unlink each other's
    // ownership. Unreadable claims and live claimants remain fail-closed.
    let claimPath = join(this.directory, `released-${id}.lock`);
    const visitedClaims = new Set<string>();
    for (;;) {
      if (visitedClaims.has(claimPath)) {
        throw new Error(`operation ${id} lock release claim chain contains a cycle`);
      }
      visitedClaims.add(claimPath);

      const nonce = randomUUID();
      const candidatePath = join(this.directory, `release-${id}-${nonce}.claimant`);
      writePrivateJson(candidatePath, { id, pid: process.pid, nonce });

      let claimed = false;
      try {
        linkSync(candidatePath, claimPath);
        claimed = true;
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "EEXIST") throw error;
      } finally {
        if (existsSync(candidatePath)) unlinkSync(candidatePath);
        syncDirectory(this.directory);
      }
      if (claimed) break;

      let claim: ReleaseClaim;
      try {
        const value: unknown = JSON.parse(readFileSync(claimPath, "utf8"));
        if (!releaseClaim(value)) {
          throw new Error(`operation ${id} lock release has an unreadable claim`);
        }
        claim = value;
      } catch (claimError) {
        throw new Error(
          `operation ${id} lock release claim cannot be recovered: ${
            claimError instanceof Error ? claimError.message : String(claimError)
          }`,
        );
      }

      if (claim.id !== id || processAlive(claim.pid)) {
        throw new Error(
          `operation ${id} lock release is already claimed; ${this.lockPath} remains held`,
        );
      }
      claimPath = join(this.directory, `released-${id}-${claim.nonce}.lock`);
    }

    this.afterReleaseClaimed(id);
    const current = JSON.parse(readFileSync(this.lockPath, "utf8")) as { id: string };
    if (current.id !== id) throw new Error(`operation ${id} no longer owns ${this.lockPath}`);
    unlinkSync(this.lockPath);
    syncDirectory(this.directory);
  }
}
