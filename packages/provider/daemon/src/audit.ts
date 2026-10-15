/**
 * Append-only JSONL audit log for the signing daemon.
 *
 * Every authenticated signing request writes one line: signed, replayed
 * (identical retry served from the ledger), or rejected. This is the forensic
 * trail for "did we sign that?" -- pair with the on-chain `getHistoricalProof`
 * lookup to prove a specific provider authorization timeline.
 *
 * A signature is released only after its audit record has been accepted by the
 * stream write callback: the handlers await `record()` and answer 500
 * AUDIT_FAILED instead of returning a signature the stream rejected. This is
 * not an `fsync` or power-loss durability guarantee. A failing file stream
 * stops signing rather than crashing the process or signing silently.
 *
 * Reference impl uses a local file or stdout. Production deployments wire
 * this to a tamper-evident, suitably durable store (write-once cloud bucket,
 * append-only log service, etc.) by reimplementing the AuditSink interface.
 */

import {
  closeSync,
  constants,
  createWriteStream,
  fchmodSync,
  fstatSync,
  openSync,
  type WriteStream,
} from "node:fs";
import type { Writable } from "node:stream";

import { formatUnknownError } from "./error-format.ts";

export type AuditRoute = "/sign" | "/sign-multi" | "/sign-credential-root";

/** The credential-root publication a /sign-credential-root request asked for. */
export interface CredentialRootAudit {
  chainId: string;
  oracleAddress: `0x${string}`;
  providerId: string;
  root: `0x${string}`;
  cid: string;
  notBefore: string;
  notAfter: string;
}

export interface AuditEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  route: AuditRoute;
  /** `signed`, `replayed` (identical retry served from the ledger), or `rejected`. */
  outcome: "signed" | "replayed" | "rejected";
  /** Source identifier for the requester (mTLS CN or bearer scope). */
  source: string;
  /** Digest that was (or would have been) signed. Absent if rejected before hashing. */
  payloadHash?: `0x${string}`;
  /** Signal routes: the proof submitter address. */
  submitter?: `0x${string}`;
  /** Signal routes: `signer_pubkey_hash`, the public-input commitment to the signing key. */
  signerPubkeyHash?: `0x${string}`;
  /** Credential-root route: the EIP-712 signer address. */
  signer?: `0x${string}`;
  /** Credential-root route: what was authorized. */
  credentialRoot?: CredentialRootAudit;
  /** Rejection reason. */
  reason?: string;
}

export interface AuditSink {
  /** Resolves on sink acceptance; rejects on failure. Durability is sink-specific. */
  record(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

function writeLine(stream: Writable, event: AuditEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(event) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

function openAuditStream(path: string): WriteStream {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    if (!fstatSync(fd).isFile()) {
      throw new Error("audit log must be a regular file");
    }
    fchmodSync(fd, 0o600);
    const stream = createWriteStream(path, {
      fd,
      autoClose: true,
      encoding: "utf-8",
    });
    fd = undefined;
    return stream;
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    throw new Error(`failed to securely open audit log ${path}: ${formatUnknownError(cause)}`, {
      cause,
    });
  }
}

class StdoutAuditSink implements AuditSink {
  record(event: AuditEvent): Promise<void> {
    return writeLine(process.stdout, event);
  }
  async close(): Promise<void> {
    /* stdout is not ours to close */
  }
}

export class FileAuditSink implements AuditSink {
  private readonly stream: WriteStream;
  private failure: Error | undefined;
  private closePromise: Promise<void> | undefined;

  /** Open one owner-only regular file without following a final symbolic link. */
  constructor(path: string) {
    this.stream = openAuditStream(path);
    // Without a listener, a later stream error (for example, disk full) is an
    // unhandled 'error' event and kills the process. Latch it instead: every
    // later record() rejects, so signing stops with AUDIT_FAILED.
    this.stream.on("error", (err) => {
      this.failure = err;
      process.stderr.write(`[xochi-provider] audit log error: ${formatUnknownError(err)}\n`);
    });
  }

  async record(event: AuditEvent): Promise<void> {
    if (this.failure) {
      throw new Error(`audit log unavailable: ${this.failure.message}`);
    }
    if (this.closePromise) {
      throw new Error("audit log is closed");
    }
    // A failed write rejects through the write callback.
    await writeLine(this.stream, event);
  }

  close(): Promise<void> {
    this.closePromise ??= new Promise((resolve, reject) => {
      const settle = (): void => {
        if (this.failure) {
          reject(new Error(`audit log unavailable: ${this.failure.message}`));
        } else {
          resolve();
        }
      };
      if (this.stream.closed) {
        settle();
        return;
      }
      this.stream.once("close", settle);
      this.stream.end();
    });
    return this.closePromise;
  }
}

/** In-memory sink for tests; exposes `events` for assertions. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {
    /* nothing */
  }
}

/** Pick a sink based on config: file path -> file, otherwise stdout. */
export function makeAuditSink(filePath: string | undefined): AuditSink {
  if (filePath) return new FileAuditSink(filePath);
  return new StdoutAuditSink();
}
