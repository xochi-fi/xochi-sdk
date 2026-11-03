import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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

  constructor(readonly directory: string) {
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
    try {
      lockFd = openSync(this.lockPath, "wx", 0o600);
    } catch {
      const unresolved = this.unresolved();
      throw new Error(
        unresolved
          ? `operation ${unresolved.id} (${unresolved.kind}) is ${unresolved.status}; reconcile ${this.path(unresolved.id)} before moving funds again`
          : `operation lock ${this.lockPath} exists without a readable record; do not move funds until it is reconciled`,
      );
    }

    try {
      writeSync(lockFd, `${JSON.stringify({ id, kind })}\n`);
      fsyncSync(lockFd);
    } finally {
      closeSync(lockFd);
    }
    syncDirectory(this.directory);

    const now = new Date().toISOString();
    const record: OperationRecord = {
      id,
      kind,
      status: "building",
      createdAt: now,
      updatedAt: now,
      request,
    };
    try {
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

  private releaseLock(id: string): void {
    if (!existsSync(this.lockPath)) return;
    const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { id: string };
    if (lock.id !== id) throw new Error(`operation ${id} does not own ${this.lockPath}`);
    unlinkSync(this.lockPath);
    syncDirectory(this.directory);
  }
}
