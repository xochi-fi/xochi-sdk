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
export function upsertLocalSend(address: string | undefined, item: SendActivityItem): void {
  if (!address || parseSendRecord(item) === null) return;
  const existing = read(address);
  const idx = existing.findIndex((r) => r.id === item.id);
  const next = idx >= 0 ? [...existing] : [item, ...existing];
  if (idx >= 0) next[idx] = { ...item, timestamp: existing[idx].timestamp };
  const capped = next.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_RECORDS);
  if (!write(address, capped)) return;
  notify();
}
