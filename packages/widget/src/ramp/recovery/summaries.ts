/**
 * Browser-local, sanitized summaries of Peer onramp operations (W3).
 *
 * The S4 `RampOperationStore` (`xochi:ramp/1:<operation_id>`) keeps each
 * operation's snapshot and command receipts. It has no index, so this list is
 * the index: one row per operation, holding only what the review screen showed
 * plus the public wallet the operation is bound to. The `operation_id` is a
 * widget-minted UUID; it cannot retrieve anything from Peer.
 *
 * Never stored here: provider session or order ids, intent hashes, payment
 * recipients or handles, proof material, bearer URLs, raw provider data. Every
 * write and every read is an explicit projection through a strict schema, so a
 * field outside the allowlist is dropped on the way in and a row carrying one
 * is refused on the way out.
 */

import {
  RampErrorCodeSchema,
  RampLegStateSchema,
  RampMoneySchema,
  type RampErrorCode,
  type RampLegState,
  type RampMoney,
  type RampSnapshot,
} from "@xochi/client";
import { z } from "zod";
import { STORAGE_KEYS } from "../../constants.js";

/** Cap the index so a heavy buyer's entry stays small. */
const MAX_RECORDS = 50;
/** Peer may hold a Venmo/PayPal payout this long; an estimate, never a guarantee. */
export const PEER_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

const iso = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
const SummarySchema = z
  .object({
    operation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    direction: z.literal("onramp"),
    wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
    rail: z
      .object({
        id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
        label: z.string().min(1).max(64),
      })
      .strict(),
    pay: RampMoneySchema,
    receive: RampMoneySchema,
    quote_expires_at: iso,
    submitted: z.boolean(),
    approved_at: iso.optional(),
    state: RampLegStateSchema,
    terminal: z.boolean(),
    payout_state: z.enum(["held", "released"]).optional(),
    held_since: iso.optional(),
    failure_code: RampErrorCodeSchema.optional(),
    abandoned: z.boolean().optional(),
    created_at: iso,
    updated_at: iso,
  })
  .strict();

export interface RampOperationSummary {
  readonly operation_id: string;
  readonly direction: "onramp";
  /** Lowercase public wallet the operation is bound to (its signer and recipient). */
  readonly wallet: string;
  readonly rail: { readonly id: string; readonly label: string };
  readonly pay: RampMoney;
  readonly receive: RampMoney;
  readonly quote_expires_at: string;
  /** True once the wallet boundary was crossed; an unsubmitted flow may be abandoned. */
  readonly submitted: boolean;
  /** When the wallet approval started; bounds the read-only intent lookup on resume. */
  readonly approved_at?: string;
  readonly state: RampLegState;
  /** The S4 snapshot's derived `terminal`; nothing further can happen. */
  readonly terminal: boolean;
  readonly payout_state?: "held" | "released";
  readonly held_since?: string;
  readonly failure_code?: RampErrorCode;
  readonly abandoned?: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Field-by-field projection: nothing outside the allowlist survives. */
export function parseRampSummary(value: unknown): RampOperationSummary | null {
  const parsed = SummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  const money = (m: RampMoney): RampMoney =>
    m.asset.kind === "fiat"
      ? {
          asset: { kind: "fiat", currency: m.asset.currency, decimals: m.asset.decimals },
          atomic: m.atomic,
        }
      : {
          asset: {
            kind: "crypto",
            chain_id: m.asset.chain_id,
            asset_id: m.asset.asset_id,
            symbol: m.asset.symbol,
            decimals: m.asset.decimals,
          },
          atomic: m.atomic,
        };
  return {
    operation_id: v.operation_id,
    direction: "onramp",
    wallet: v.wallet,
    rail: { id: v.rail.id, label: v.rail.label },
    pay: money(v.pay),
    receive: money(v.receive),
    quote_expires_at: v.quote_expires_at,
    submitted: v.submitted,
    ...(v.approved_at ? { approved_at: v.approved_at } : {}),
    state: v.state,
    terminal: v.terminal,
    ...(v.payout_state ? { payout_state: v.payout_state } : {}),
    ...(v.held_since ? { held_since: v.held_since } : {}),
    ...(v.failure_code ? { failure_code: v.failure_code } : {}),
    ...(v.abandoned ? { abandoned: true } : {}),
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

/** Settled: nothing left to resume. */
export function summaryResolved(summary: RampOperationSummary): boolean {
  return summary.abandoned === true || summary.terminal;
}

/** A submitted operation whose outcome is not final: another transfer must not start. */
export function summaryBlocksNewPurchase(summary: RampOperationSummary): boolean {
  return summary.submitted && !summaryResolved(summary);
}

type Listener = () => void;
const listeners = new Set<Listener>();
/** Operation ids owned by a live in-page runtime; a reload empties this. */
const live = new Set<string>();

export function subscribeRampSummaries(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(): void {
  for (const l of listeners) l();
}
export function markRampOperationLive(operationId: string, value = true): void {
  if (value) live.add(operationId);
  else live.delete(operationId);
  notify();
}
export function rampOperationLive(operationId: string): boolean {
  return live.has(operationId);
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
function read(): RampOperationSummary[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEYS.localRamps);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRampSummary).filter((row): row is RampOperationSummary => row !== null);
  } catch {
    return [];
  }
}
function write(rows: RampOperationSummary[]): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(STORAGE_KEYS.localRamps, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

/** All summaries, newest first. */
export function listRampSummaries(): RampOperationSummary[] {
  return read().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
export function getRampSummary(operationId: string): RampOperationSummary | undefined {
  return read().find((row) => row.operation_id === operationId);
}

/** Insert or replace by operation id; malformed input is refused, not stored. */
export function upsertRampSummary(summary: RampOperationSummary): void {
  const clean = parseRampSummary(summary);
  if (!clean) return;
  const rows = read().filter((row) => row.operation_id !== clean.operation_id);
  rows.unshift(clean);
  rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (write(rows.slice(0, MAX_RECORDS))) notify();
}

/** Project a sanitized S4 snapshot onto its summary. `submitted` never reverts. */
export function summaryFromSnapshot(
  summary: RampOperationSummary,
  snapshot: RampSnapshot,
  now = Date.now(),
): RampOperationSummary {
  const peer = snapshot.peer;
  const held = peer.payout_state === "held";
  const { failure_code: _previousFailure, payout_state: _previousPayout, ...rest } = summary;
  return {
    ...rest,
    submitted: summary.submitted || !["quoted", "not_started", "failed"].includes(peer.state),
    state: peer.state,
    terminal: snapshot.terminal,
    ...(peer.payout_state ? { payout_state: peer.payout_state } : {}),
    ...(held && !summary.held_since ? { held_since: new Date(now).toISOString() } : {}),
    ...(peer.failure_code ? { failure_code: peer.failure_code } : {}),
    updated_at: new Date(now).toISOString(),
  };
}

export function abandonRampSummary(operationId: string, now = Date.now()): boolean {
  const row = getRampSummary(operationId);
  // Only a flow that never crossed the wallet boundary can be abandoned.
  if (!row || row.submitted) return false;
  upsertRampSummary({ ...row, abandoned: true, updated_at: new Date(now).toISOString() });
  return true;
}

/** The earliest the held payout may release: an estimate, never a guarantee. */
export function heldReleaseEstimate(summary: RampOperationSummary): Date | undefined {
  if (summary.payout_state !== "held" || !summary.held_since) return undefined;
  return new Date(Date.parse(summary.held_since) + PEER_HOLD_MS);
}
