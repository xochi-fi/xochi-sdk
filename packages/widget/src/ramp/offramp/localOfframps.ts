/**
 * Sanitized, browser-local summaries of the wallet's payment-app cash-outs.
 *
 * Follows lib/localSends.ts: one localStorage entry per wallet, newest first,
 * capped, with a pub/sub so Activity updates live. A row holds only what the
 * review screen showed in the clear (rail, currency, USDC amount) plus the
 * widget-minted operation reference and bounded state enums. Never the payee
 * handle, a deposit ID, a transaction hash, a quote, or provider data: the
 * deposit mapping S5 needs to resume lives in its own provider-private store
 * (ramp/peer/protectedMapping.ts), and this row only says an order exists.
 *
 * Every row is shape-checked on read; a malformed one is dropped.
 */

import { STORAGE_KEYS } from "../../constants.js";
import type { MakerPhase, MakerWalletAction } from "../peer/index.js";

const MAX_RECORDS = 50;
const PREFIX = STORAGE_KEYS.localOfframpsPrefix;

/**
 * `before_deposit`: no deposit wallet step has been handed out yet, so nothing
 * of the user's is in escrow. `deposit`: the deposit step was handed to the
 * wallet; only S5's protected mapping can resume or settle it.
 */
export type OfframpStage = "before_deposit" | "deposit";
export type OfframpStatus = "open" | "in_doubt" | "delivered" | "returned" | "not_started";

export interface OfframpActivityItem {
  /** Widget-minted operation reference (opaque, non-authorizing). */
  id: string;
  type: "offramp";
  timestamp: number;
  stage: OfframpStage;
  status: OfframpStatus;
  phase?: MakerPhase;
  /** The wallet step handed out last, so a reload can ask for its hash. */
  pendingAction?: MakerWalletAction;
  data: {
    rail: string;
    currency: string;
    /** Base USDC deposit, canonical atomic units. */
    amount: string;
  };
}

const STAGES = new Set<string>(["before_deposit", "deposit"]);
const STATUSES = new Set<string>(["open", "in_doubt", "delivered", "returned", "not_started"]);
const PHASES = new Set<string>([
  "awaiting_buyer",
  "matched",
  "delivering",
  "delivered",
  "returned",
]);
const ACTIONS = new Set<string>(["approve_usdc", "create_deposit", "withdraw_unmatched"]);

const keyFor = (address: string) => `${PREFIX}${address.toLowerCase()}`;

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeLocalOfframps(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Exactly the stored shape, or null. Unknown fields are dropped, not kept. */
export function parseOfframpRecord(value: unknown): OfframpActivityItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const data = row.data as Record<string, unknown> | undefined;
  if (
    row.type !== "offramp" ||
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(row.id) ||
    typeof row.timestamp !== "number" ||
    !Number.isFinite(row.timestamp) ||
    typeof row.stage !== "string" ||
    !STAGES.has(row.stage) ||
    typeof row.status !== "string" ||
    !STATUSES.has(row.status) ||
    (row.phase !== undefined && (typeof row.phase !== "string" || !PHASES.has(row.phase))) ||
    (row.pendingAction !== undefined &&
      (typeof row.pendingAction !== "string" || !ACTIONS.has(row.pendingAction))) ||
    !data ||
    typeof data.rail !== "string" ||
    !/^[a-z0-9_]{1,32}$/.test(data.rail) ||
    typeof data.currency !== "string" ||
    !/^[A-Z]{3}$/.test(data.currency) ||
    typeof data.amount !== "string" ||
    !/^[1-9][0-9]{0,30}$/.test(data.amount)
  )
    return null;
  return {
    id: row.id,
    type: "offramp",
    timestamp: row.timestamp,
    stage: row.stage as OfframpStage,
    status: row.status as OfframpStatus,
    ...(row.phase ? { phase: row.phase as MakerPhase } : {}),
    ...(row.pendingAction ? { pendingAction: row.pendingAction as MakerWalletAction } : {}),
    data: { rail: data.rail, currency: data.currency, amount: data.amount },
  };
}

function read(address: string): OfframpActivityItem[] {
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseOfframpRecord).filter((row): row is OfframpActivityItem => row !== null);
  } catch {
    return [];
  }
}

export function listLocalOfframps(address: string | undefined): OfframpActivityItem[] {
  if (!address || typeof window === "undefined") return [];
  return read(address).sort((a, b) => b.timestamp - a.timestamp);
}

/** Insert or update by operation reference, keeping the original time. */
export function upsertLocalOfframp(address: string | undefined, item: OfframpActivityItem): void {
  if (!address || typeof window === "undefined") return;
  const safe = parseOfframpRecord(item);
  if (!safe) return;
  const rows = read(address);
  const existing = rows.find((r) => r.id === safe.id);
  const next = [
    existing ? { ...safe, timestamp: existing.timestamp } : safe,
    ...rows.filter((r) => r.id !== safe.id),
  ]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_RECORDS);
  try {
    window.localStorage.setItem(keyFor(address), JSON.stringify(next));
  } catch {
    return;
  }
  for (const l of listeners) l();
}

/** The open order to resume on load, if any: newest first, never a finished one. */
export function resumableOfframp(rows: readonly OfframpActivityItem[]) {
  return rows.find((r) => r.status === "open" || r.status === "in_doubt");
}
