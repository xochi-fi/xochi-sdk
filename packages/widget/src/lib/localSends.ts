/**
 * Local-first log of public sends (the Send tab's `address` destination).
 *
 * Follows the swap log's conventions (lib/localActivity.ts): one localStorage
 * entry per wallet, newest first, capped, with a pub/sub so a write from the
 * Send panel updates the Activity tab live. A separate key rather than rows in
 * the swap log: every swap row is an intent the feed polls `/status` for, and a
 * plain transfer has no intent, so mixing them would poll ids that do not exist.
 *
 * What is stored is only what the user already saw on the review screen plus
 * the public transaction hash the wallet returned. localStorage is not a trust
 * boundary, so every row is shape-checked on the way out and a malformed one is
 * dropped rather than rendered.
 */

import { isAddress, isHash } from "viem";
import { STORAGE_KEYS } from "../constants.js";

/** Cap the log so a heavy sender's localStorage entry stays small. */
const MAX_RECORDS = 50;

export type SendStatus = "pending" | "completed" | "failed";

export interface SendActivityItem {
  /** The transaction hash: one row per broadcast transaction. */
  id: string;
  type: "send";
  timestamp: number;
  status: SendStatus;
  data: {
    chainId: number;
    /** ERC-20 contract address. */
    token: string;
    symbol: string;
    decimals: number;
    /** Canonical unsigned base-10 atomic units. */
    amount: string;
    recipient: string;
    txHash: string;
  };
}

const keyFor = (address: string): string =>
  `${STORAGE_KEYS.localSendsPrefix}${address.toLowerCase()}`;

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeLocalSends(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

const STATUSES: ReadonlySet<string> = new Set<SendStatus>(["pending", "completed", "failed"]);

/** The row if it has exactly the stored shape, otherwise null. */
export function parseSendRecord(value: unknown): SendActivityItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const data = row.data as Record<string, unknown> | undefined;
  if (
    row.type !== "send" ||
    typeof row.id !== "string" ||
    typeof row.timestamp !== "number" ||
    typeof row.status !== "string" ||
    !STATUSES.has(row.status) ||
    !data ||
    typeof data !== "object" ||
    typeof data.chainId !== "number" ||
    typeof data.token !== "string" ||
    !isAddress(data.token, { strict: false }) ||
    typeof data.symbol !== "string" ||
    typeof data.decimals !== "number" ||
    typeof data.amount !== "string" ||
    !/^\d+$/.test(data.amount) ||
    typeof data.recipient !== "string" ||
    !isAddress(data.recipient, { strict: false }) ||
    typeof data.txHash !== "string" ||
    !isHash(data.txHash) ||
    data.txHash !== row.id
  ) {
    return null;
  }
  return {
    id: row.id,
    type: "send",
    timestamp: row.timestamp,
    status: row.status as SendStatus,
    data: {
      chainId: data.chainId,
      token: data.token,
      symbol: data.symbol,
      decimals: data.decimals,
      amount: data.amount,
      recipient: data.recipient,
      txHash: data.txHash,
    },
  };
}

function read(address: string): SendActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseSendRecord).filter((row): row is SendActivityItem => row !== null);
  } catch (err) {
    console.error("[localSends] read failed", err);
    return [];
  }
}

function write(address: string, items: SendActivityItem[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(keyFor(address), JSON.stringify(items));
    return true;
  } catch (err) {
    console.error("[localSends] write failed", err);
    return false;
  }
}

/** The wallet's local sends, newest first. */
export function listLocalSends(address: string | undefined): SendActivityItem[] {
  if (!address) return [];
  return read(address).sort((a, b) => b.timestamp - a.timestamp);
}

/** Insert a send, or update its status by transaction hash (keeping its time). */
export function upsertLocalSend(address: string | undefined, item: SendActivityItem): boolean {
  if (!address || parseSendRecord(item) === null) return false;
  const existing = read(address);
  const idx = existing.findIndex((r) => r.id === item.id);
  const next = idx >= 0 ? [...existing] : [item, ...existing];
  if (idx >= 0) next[idx] = { ...item, timestamp: existing[idx].timestamp };
  const capped = next.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_RECORDS);
  if (!write(address, capped)) return false;
  notify();
  return true;
}

/** One unresolved wallet boundary per wallet, separate from confirmed-hash Activity. */
export interface SendAttempt {
  wallet: string;
  timestamp: number;
  data: Omit<SendActivityItem["data"], "txHash">;
  hash?: string;
  candidateHash?: string;
}
const attemptKey = (wallet: string) => `${keyFor(wallet)}:attempt`;

export function readSendAttempt(wallet: string): SendAttempt | null {
  const raw = window.localStorage.getItem(attemptKey(wallet));
  if (raw === null) return null;
  const value = JSON.parse(raw) as SendAttempt;
  const hash = value.hash ?? `0x${"0".repeat(64)}`;
  const row = parseSendRecord({
    id: hash,
    type: "send",
    timestamp: value.timestamp,
    status: "pending",
    data: { ...value.data, txHash: hash },
  });
  if (
    !row ||
    (value.candidateHash !== undefined &&
      (typeof value.candidateHash !== "string" || !isHash(value.candidateHash))) ||
    !Number.isSafeInteger(row.timestamp) ||
    row.timestamp <= 0 ||
    value.wallet.toLowerCase() !== wallet.toLowerCase() ||
    !/^(0|[1-9][0-9]*)$/.test(row.data.amount)
  )
    throw new Error("Invalid send checkpoint");
  const { txHash: _hash, ...data } = row.data;
  return {
    wallet: wallet.toLowerCase(),
    timestamp: row.timestamp,
    data,
    ...(value.hash ? { hash: value.hash } : {}),
    ...(value.candidateHash ? { candidateHash: value.candidateHash } : {}),
  };
}

export function saveSendAttempt(attempt: SendAttempt): void {
  // Project fields explicitly: never persist wallet/provider errors or payloads.
  const { chainId, token, symbol, decimals, amount, recipient } = attempt.data;
  const projected = {
    wallet: attempt.wallet.toLowerCase(),
    timestamp: attempt.timestamp,
    data: { chainId, token, symbol, decimals, amount, recipient },
    ...(attempt.hash ? { hash: attempt.hash } : {}),
    ...(attempt.candidateHash ? { candidateHash: attempt.candidateHash } : {}),
  };
  window.localStorage.setItem(attemptKey(attempt.wallet), JSON.stringify(projected));
  if (!readSendAttempt(attempt.wallet)) throw new Error("Send checkpoint unavailable");
}

export function clearSendAttempt(wallet: string): void {
  window.localStorage.removeItem(attemptKey(wallet));
}

/** Serialize wallet-boundary and reconciliation writes across same-origin tabs when supported. */
export async function withSendAttemptLock(wallet: string, run: () => Promise<void>): Promise<void> {
  if (!navigator.locks) return run();
  await navigator.locks.request(attemptKey(wallet), { ifAvailable: true }, async (lock) => {
    if (lock) await run();
  });
}
