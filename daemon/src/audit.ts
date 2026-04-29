/**
 * Append-only JSONL audit log for the signing daemon.
 *
 * Every accepted /sign request writes one line. This is the forensic trail
 * for "did we sign that?" -- pair with the on-chain `getHistoricalProof`
 * lookup to prove a specific provider authorization timeline.
 *
 * Reference impl uses a local file or stdout. Production deployments wire
 * this to a tamper-evident store (write-once cloud bucket, append-only log
 * service, etc.) by reimplementing the AuditSink interface.
 */

import { createWriteStream, type WriteStream } from "node:fs";

export interface AuditEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Hex of the signed payload digest -- matches what's logged on-chain via the proof's public inputs. */
  payloadHash: `0x${string}`;
  /** Hex of the submitter (Field, uint160 for an address). */
  submitter: `0x${string}`;
  /** Hex of `signer_pubkey_hash` -- the public-input commitment to the signing key. */
  signerPubkeyHash: `0x${string}`;
  /** Outcome -- `signed`, `replayed`, or `rejected`. */
  outcome: "signed" | "replayed" | "rejected";
  /** Source identifier for the requester (mTLS CN or bearer-key label). */
  source: string;
  /** Optional rejection reason. */
  reason?: string;
}

export interface AuditSink {
  record(event: AuditEvent): void;
  close(): void;
}

class StdoutAuditSink implements AuditSink {
  record(event: AuditEvent): void {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  close(): void {
    /* nothing */
  }
}

class FileAuditSink implements AuditSink {
  private readonly stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf-8" });
  }

  record(event: AuditEvent): void {
    this.stream.write(JSON.stringify(event) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

/** In-memory sink for tests; exposes `events` for assertions. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
  close(): void {
    /* nothing */
  }
}

/** Pick a sink based on config: file path → file, otherwise stdout. */
export function makeAuditSink(filePath: string | undefined): AuditSink {
  if (filePath) return new FileAuditSink(filePath);
  return new StdoutAuditSink();
}
