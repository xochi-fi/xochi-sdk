/**
 * Append-only JSONL audit log for the signing daemon.
 *
 * Every authenticated signing request writes one line: signed, replayed
 * (identical retry served from the ledger), or rejected. This is the forensic
 * trail for "did we sign that?" -- pair with the on-chain `getHistoricalProof`
 * lookup to prove a specific provider authorization timeline.
 *
 * A signature is released only after its audit record has been written: the
 * handlers await `record()` and answer 500 AUDIT_FAILED instead of returning a
 * signature the log never saw. A failing file stream therefore stops signing
 * rather than crashing the process or signing silently.
 *
 * Reference impl uses a local file or stdout. Production deployments wire
 * this to a tamper-evident store (write-once cloud bucket, append-only log
 * service, etc.) by reimplementing the AuditSink interface.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import type { Writable } from "node:stream";

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
  /** Resolves once the line is written; rejects if it could not be. */
  record(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

function writeLine(stream: Writable, event: AuditEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(event) + "\n", (err) => (err ? reject(err) : resolve()));
  });
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

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf-8" });
    // Without a listener, a stream error (unwritable path, disk full) is an
    // unhandled 'error' event and kills the process. Latch it instead: every
    // later record() rejects, so signing stops with AUDIT_FAILED.
    this.stream.on("error", (err) => {
      this.failure = err;
      process.stderr.write(`[xochi-signer] audit log error: ${err.message}\n`);
    });
  }

  async record(event: AuditEvent): Promise<void> {
    if (this.failure) {
      throw new Error(`audit log unavailable: ${this.failure.message}`);
    }
    // A failed write rejects through the write callback.
    await writeLine(this.stream, event);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(new Error(`audit log unavailable: ${this.failure.message}`));
        return;
      }
      this.stream.end(() => resolve());
    });
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
