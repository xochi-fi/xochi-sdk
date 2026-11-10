/**
 * Local-first swap activity log.
 *
 * Trading is wallet-first: a connected wallet quotes/signs/executes with no
 * passkey, so the Member-gated `GET /api/intent/history` returns nothing for
 * most users and the activity feed reads empty. This persists each submitted
 * swap to localStorage (keyed per wallet) so the feed reflects the user's own
 * trades immediately. Per-intent status is public (`GET /api/intent/:id/status`),
 * so non-terminal records can be refreshed without a Member token
 * (see useLocalActivity). Server history still merges on top when present.
 */

import type { SwapActivityItem, ActivityStatus } from "../types/activity.js";
import { AWAITING_RECIPIENT_SUBSTATUS } from "./recipientReceipt.js";
import type { IntentStatus } from "../types/intent.js";
import { isSelectableChainId, canTransitionTo } from "../types/intent.js";
import {
  decodeWireStatus,
  GRANULAR_WIRE_STATUS,
  isTerminalIntentStatus,
  NOT_EXECUTED_SUBSTATUS,
  type IntentStatusResult,
} from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";

/** Cap the log so a heavy trader's localStorage entry stays small. */
const MAX_RECORDS = 50;

/**
 * Server statuses that justify healing a local `failed` record. The self-heal
 * only corrects in-doubt EXECUTES: the origin pull may have moved funds and the
 * server advanced past `quoted`, so the local terminal `failed` is a false
 * negative. These are the states that prove that progression (in-flight after
 * dispatch) or a positive terminal.
 *
 * Deliberately excludes the pre-execution states (`quoted`, `quoting`, `pending`,
 * `idle`, `signing`) and `awaiting_deposit`: a record the server still holds as
 * pre-execution was never executed (e.g. a signing error before `/execute`), so
 * its local `failed` is correct. Healing it into a non-terminal status would
 * resurrect a genuinely-failed swap as a row that polls `/status` forever.
 * `failed`/`expired` are likewise excluded (nothing to correct).
 */
const HEALABLE_SERVER_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  "executing",
  "bridging",
  "settling",
  "completed",
  "refunded",
]);

/**
 * Should a local `failed` + no-txHash record be corrected to `status`? True only
 * when the server proves the intent actually progressed past quoting; a
 * pre-execution or failed/expired server status leaves the local record as-is.
 */
export function isHealableServerStatus(status: IntentStatus): boolean {
  return HEALABLE_SERVER_STATUSES.has(status);
}

/**
 * Pre-dispatch statuses the worker legitimately sweeps: a `quoted` row with no
 * signature is deleted past its TTL (the orphan-quote sweep), so a `/status`
 * poll for it 404s. A local record in one of these states that gets a definitive
 * 404 can be safely terminalized as `expired` (fund-safe, re-quotable). A
 * DISPATCHED record (executing+) that 404s is NOT swept -- it is a different bug
 * (e.g. the #170 stealth intentId overload) and may actually have completed, so
 * it must never be false-failed here. See #271.
 */
const SWEEPABLE_PRE_DISPATCH_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  "idle",
  "pending",
  "quoting",
  "quoted",
  "signing",
]);

/**
 * Is a local record in a pre-dispatch state the worker may have swept? Used to
 * decide whether a definitive 404 should terminalize the record (#271).
 */
export function isSweepablePreDispatch(status: IntentStatus): boolean {
  return SWEEPABLE_PRE_DISPATCH_STATUSES.has(status);
}

/** Collapse a granular intent status into the feed's coarse status. */
export function toActivityStatus(status: IntentStatus): ActivityStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "expired") return "failed";
  if (status === "refunded") return "failed";
  return "pending";
}

const keyFor = (address: string): string =>
  `${STORAGE_KEYS.localActivityPrefix}${address.toLowerCase()}`;

// --- pub/sub so a write from the swap panel updates the feed live ---------
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeLocalActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

function read(address: string): SwapActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const stored = parsed as (SwapActivityItem & { readToken?: unknown })[];
    const items = stored.map(({ readToken: _readToken, ...item }) => ({
      ...item,
      ownerWallet: address,
    }));
    // An earlier build stored each intent's read token here. The widget no
    // longer keeps it (SPEC §5.1: it reveals nothing past the status-only
    // view), so purge any left behind.
    if (stored.some((item) => "readToken" in item)) write(address, items);
    return items;
  } catch (err) {
    console.error("[localActivity] read failed", err);
    return [];
  }
}

function write(address: string, items: SwapActivityItem[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    const persisted = items.map(({ ownerWallet: _ownerWallet, ...item }) => item);
    window.localStorage.setItem(keyFor(address), JSON.stringify(persisted));
    return true;
  } catch (err) {
    console.error("[localActivity] write failed", err);
    return false;
  }
}

/** Read the wallet's local swaps, newest first. */
export function listLocalSwaps(address: string | undefined): SwapActivityItem[] {
  if (!address) return [];
  return read(address).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * What a `/status` poll returned for a record, as `useLocalActivity` sees it.
 *
 * Deliberately the API client's own result type rather than a local restatement.
 * The restatement had every field optional, so a new REQUIRED field on
 * `IntentStatusData` was silently dropped here with no type error. Aliasing means
 * the shape can only grow in one place, and every caller (tests included) has to
 * account for the growth.
 */
export type PolledStatus = IntentStatusResult;

/**
 * Substatus values the app models: the ones `decodeWireStatus` buckets by, plus
 * the Worker's `not_executed` and `awaiting_recipient` markers. Riddler owns the
 * granular vocabulary and extends it on its own cadence, so an unrecognized value
 * is dropped rather than persisted.
 *
 * Three values are read. `filled` confirms delivery even when no fill hash reaches
 * us, and the feed shares that predicate with the flow modal so the two cannot
 * disagree (xochi#376). `not_executed` is the only failure the feed offers a
 * retry on. `awaiting_recipient` is a shielded payout waiting on the recipient's
 * receipt. Dropping unknown values is therefore fail-closed: the row keeps
 * whatever it already had, never asserts delivery on a string this build does
 * not understand, and never offers a retry without the marker.
 */
const KNOWN_SUBSTATUSES: ReadonlySet<string> = new Set([
  ...Object.keys(GRANULAR_WIRE_STATUS),
  NOT_EXECUTED_SUBSTATUS,
  AWAITING_RECIPIENT_SUBSTATUS,
]);

/** Is this a substatus this build models? See KNOWN_SUBSTATUSES. */
export function isKnownSubstatus(substatus: string): boolean {
  return KNOWN_SUBSTATUSES.has(substatus);
}

/**
 * Where a STORED status places a record, or null when this build cannot place it
 * at all: itself when it is in the union, the bucket when it is one of Riddler's
 * granular strings.
 *
 * `SwapActivityItem.intentStatus` is TYPED `IntentStatus` but is not guaranteed
 * to hold one at runtime. A record read back from localStorage was written by
 * whatever build was installed then, and the agent stream relays Riddler's raw
 * vocabulary (`AgentActivityEventSchema.status` is a bounded `z.string()`).
 *
 * Deliberately NOT the decoder's `status`, which has to guess (`executing`)
 * because its caller must put something in the union. Here the difference is the
 * whole point: "this build cannot read the stored value" has to stay
 * distinguishable from "the record is executing", or the guard below would refuse
 * real server moves on the strength of a guess.
 */
function resolveStoredStatus(stored: string): IntentStatus | null {
  const decoded = decodeWireStatus(stored);
  return decoded.kind === "mapped" ? decoded.status : null;
}

/**
 * Would adopting `to` on a record currently at `from` be a legal move?
 *
 * `useIntent`'s poll routes the identical server payload through
 * `canTransitionTo`; this path did not, and adopted whatever arrived. That gap is
 * exploitable by a single upstream regression: a dispatched record knocked back
 * to `pending`/`quoted` lands in the sweepable pre-dispatch set, and the next 404
 * terminalizes it as `expired` -- a swap that may have moved funds, shown to the
 * user as an expired quote.
 *
 * The guard fails closed on the SERVER's value, never on our own stale local one.
 * `canTransitionTo` reads the transition table by `from`, so an unmodeled `from`
 * returns false for EVERY `to` and freezes the record permanently: non-terminal
 * so it is re-polled every tick, and unable to adopt the answer it gets, forever.
 * A stored status this build cannot read is not evidence of anything, so it
 * defers to the server rather than vetoing it.
 *
 * Same status is always allowed: a poll that repeats `settling` still carries
 * newer hashes and the fill substatus, which is the xochi#376 merge.
 *
 * The healing exception is the self-heal case, and it has to be stated here or
 * the guard would block it: a local `failed` with no txHash is an in-doubt
 * execute (a client abort stamped it terminal), the transition table has no
 * `failed -> settling` edge, and the server proving the intent dispatched is
 * exactly what makes the local terminal wrong. See `isHealableServerStatus`.
 */
function canAdoptStatus(record: SwapActivityItem, to: IntentStatus): boolean {
  const from = resolveStoredStatus(record.intentStatus);
  if (from === null) return true;
  if (from === to) return true;
  if (canTransitionTo(from, to)) return true;
  return from === "failed" && !record.data.txHash && isHealableServerStatus(to);
}

/**
 * Decide what a stored swap record becomes after a `/status` poll, or null to
 * leave it untouched.
 *
 * Extracted from `useLocalActivity.refresh` so it can be tested directly: this
 * is the recovery path for a swap whose tab died mid-flight (#339). On mobile a
 * deep-link to the wallet backgrounds the tab and the OS often evicts it, so the
 * in-memory poll in `useIntent` never resumes and the modal is frozen on
 * whatever phase last rendered -- even though the solver settled. The persisted
 * record is the only thing that survives, and this is what advances it on the
 * next load.
 *
 * It is also the ONLY trust boundary between the status response and persisted
 * client state, so it validates rather than adopts: the id must match, the status
 * move must be legal, the fill substatus must be one this build models, and the
 * settlement chain must be one the app can render. Everything that fails a check
 * is dropped and the record keeps what it had.
 *
 * Three cases, and the distinctions matter more than the merge:
 *
 *  - transient failure (null): change nothing and retry on the next tick.
 *  - definitive 404: only a swept PRE-DISPATCH quote legitimately vanishes, so
 *    terminalize just those as `expired`. A dispatched record that 404s may
 *    actually have completed, so it is left alone rather than false-failed.
 *  - a real status: adopt it, including a terminal one. This is the case that
 *    unfreezes #339.
 */
export function reconcileLocalSwap(
  record: SwapActivityItem,
  polled: PolledStatus,
): SwapActivityItem | null {
  if (!polled) return null;

  if ("notFound" in polled) {
    if (!isSweepablePreDispatch(record.intentStatus)) return null;
    return {
      ...record,
      intentStatus: "expired",
      status: toActivityStatus("expired"),
    };
  }

  // A response for another intent must never be merged into this record. The
  // worker echoes `intent_id` on every branch, so a mismatch is a real defect
  // (id reuse, a raced poll) and not something to reconcile through.
  if (polled.intentId && polled.intentId !== record.id) {
    console.warn(
      `[localActivity] status for ${polled.intentId} arrived for record ${record.id}; ignored`,
    );
    return null;
  }

  if (!canAdoptStatus(record, polled.status)) {
    console.warn(
      `[localActivity] illegal status move ${record.intentStatus} -> ${polled.status} for ${record.id}; ignored`,
    );
    return null;
  }

  const substatus =
    polled.substatus && isKnownSubstatus(polled.substatus) ? polled.substatus : null;
  // Selectable, not EVM-only. `SwapActivity.settlementChainId` is typed
  // `SelectableChainId` and `swapExplorerLinks` narrows with the same predicate,
  // so validating with `isChainId` here dropped a Tron settlement chain to null
  // on a LIVE corridor: the fill receipt lost its authoritative chain and fell
  // back to the legacy `settlementTxChainId` inference, and that link is the
  // primary CTA on a cross-chain fill. A widened type whose validator still
  // refuses the widened value is the same defect in a new place.
  const settlementChainId = isSelectableChainId(polled.settlementChainId)
    ? polled.settlementChainId
    : null;

  return {
    ...record,
    intentStatus: polled.status,
    status: toActivityStatus(polled.status),
    // The latest read's verdict, replaced every time. A wallet-session read
    // carrying the legs clears the withheld state.
    legsWithheld: polled.legsWithheld,
    data: {
      ...record.data,
      txHash: polled.txHash ?? record.data.txHash,
      receivingTxHash: polled.receivingTxHash ?? record.data.receivingTxHash,
      substatus: substatus ?? record.data.substatus,
      settlementTxHash: polled.settlementTxHash ?? record.data.settlementTxHash,
      settlementChainId: settlementChainId ?? record.data.settlementChainId,
      // The client sets it only on a withheld read that is not a refund or a
      // terminal failure; an owner read carries the hash instead.
      settlementConfirmed:
        polled.legsWithheld === true
          ? polled.settlementConfirmed === true
          : record.data.settlementConfirmed,
    },
  };
}

/**
 * Do two wallet addresses refer to the same account? Storage keys are lowercased
 * (see `keyFor`), so ownership comparisons must be too. A missing address on
 * either side is never a match, which keeps every caller fail-closed.
 */
export function isSameWallet(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Re-poll every non-terminal record for `owner`, persist what the server says,
 * and return the refreshed list -- or null when the wallet moved on mid-poll.
 *
 * `isCurrentOwner` is the cancellation token and is the reason this is a function
 * rather than a loop inside the hook. A status poll is open for up to
 * `TIMEOUTS.requestTimeout` (15s) while the poll interval is 4s, so a request
 * opened for wallet A routinely resolves after the user has switched to wallet B.
 * Without the token the caller then renders A's rows (token pair, amounts, tx
 * hashes) into B's feed and fires B's completion toast for A's swap -- on a shared
 * device, one user's trades shown to another. So ownership is re-checked after
 * every await: before persisting each record and again before handing back a list.
 */
export async function refreshLocalSwaps(
  owner: string,
  getStatus: (intentId: string) => Promise<PolledStatus>,
  isCurrentOwner: () => boolean,
): Promise<SwapActivityItem[] | null> {
  const current = listLocalSwaps(owner);
  const pending = current.filter((s) => !isTerminalIntentStatus(s.intentStatus));
  if (pending.length === 0) return isCurrentOwner() ? current : null;

  await Promise.all(
    pending.map(async (s) => {
      const next = await getStatus(s.id);
      const reconciled = reconcileLocalSwap(s, next);
      if (reconciled && isCurrentOwner()) upsertLocalSwap(owner, reconciled);
    }),
  );
  return isCurrentOwner() ? listLocalSwaps(owner) : null;
}

/**
 * Insert or update a swap record by intent id. A newer status/txHash from a live
 * status poll overwrites the stored copy; the list stays capped and newest-first.
 */
export function upsertLocalSwap(address: string | undefined, item: SwapActivityItem): void {
  if (!address) return;
  // The log persists only substatuses this build models (KNOWN_SUBSTATUSES).
  const { substatus } = item.data;
  const incoming =
    substatus && !isKnownSubstatus(substatus)
      ? { ...item, data: { ...item.data, substatus: undefined } }
      : item;
  const existing = read(address);
  const idx = existing.findIndex((r) => r.id === incoming.id);
  const next = idx >= 0 ? [...existing] : [incoming, ...existing];
  // On update keep the original creation time so the row doesn't jump as the
  // swap advances; status/txHash/data still refresh from the incoming record.
  if (idx >= 0) next[idx] = { ...existing[idx], ...incoming, timestamp: existing[idx].timestamp };
  const capped = next.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_RECORDS);
  if (!write(address, capped)) return;
  notify();
}

// ============================================================
// Resuming a swap the tab lost (xochi#339)
// ============================================================

/**
 * Statuses a stored record can be RESUMED from: dispatched, not yet terminal.
 *
 * Must stay equal to `POLL_INFLIGHT_STATES` in @xochi/client. Resuming
 * into a status the machine does not poll would reopen a modal that then never
 * advances -- a worse failure than not reopening at all, because it looks alive.
 * A test pins the two sets together rather than trusting this comment.
 */
const RESUMABLE_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
]);

export function isResumableIntentStatus(status: IntentStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}

/**
 * How long a dispatched-but-unsettled record stays eligible to reopen the flow.
 * Past this it stays in the activity feed (where it still polls) but stops
 * hijacking a fresh visit: a day-old swap is something to look up, not something
 * the user is mid-way through.
 */
export const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Cap the dismissal list so a heavy trader's entry stays small. */
const MAX_DISMISSED = 50;

const dismissKeyFor = (address: string): string =>
  `${STORAGE_KEYS.resumeDismissedPrefix}${address.toLowerCase()}`;

function readDismissed(address: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(dismissKeyFor(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch (err) {
    console.error("[localActivity] dismissed read failed", err);
    return [];
  }
}

/**
 * Remember that the user closed this swap's flow modal, so it is never
 * auto-reopened again. Closing is an explicit "I am done watching this"; the
 * activity feed keeps advancing the swap and toasts on completion regardless.
 *
 * `status` is the intent's status at the moment of the close, and it is required
 * because a dismissal is only meaningful once the swap has actually been
 * DISPATCHED. The intent id is minted at QUOTE time and reused verbatim by
 * execute, so a dismissal written when the user merely opens the confirm modal
 * and backs out lands on the very id their real swap then runs under: from then
 * on `findResumableSwap` skips it forever and the resume feature never fires for
 * that trade. Gating on `isResumableIntentStatus` makes an ungated (pre-dispatch)
 * dismissal unrepresentable rather than relying on every caller to remember.
 */
export function dismissResumableSwap(
  address: string | undefined,
  intentId: string,
  status: IntentStatus,
): void {
  if (!address || !intentId || typeof window === "undefined") return;
  if (!isResumableIntentStatus(status)) return;
  const existing = readDismissed(address);
  if (existing.includes(intentId)) return;
  try {
    window.localStorage.setItem(
      dismissKeyFor(address),
      JSON.stringify([intentId, ...existing].slice(0, MAX_DISMISSED)),
    );
  } catch (err) {
    console.error("[localActivity] dismissed write failed", err);
  }
}

/**
 * The swap whose flow modal should be restored on load, if any.
 *
 * On mobile a wallet deep-link backgrounds the tab and the OS may evict it, so
 * the in-memory intent is gone on return and the modal the user was watching
 * never comes back -- it reads as "the app didn't register that I signed", even
 * though the swap settled server-side. The dispatched record is already
 * persisted here, so the view can be rebuilt from it.
 *
 * Newest first, so a user with two in flight resumes the one they most recently
 * started. Returns null rather than throwing on an unusable record.
 */
export function findResumableSwap(
  address: string | undefined,
  now: number = Date.now(),
): SwapActivityItem | null {
  if (!address) return null;
  const dismissed = new Set(readDismissed(address));
  return (
    listLocalSwaps(address).find(
      (s) =>
        isResumableIntentStatus(s.intentStatus) &&
        !dismissed.has(s.id) &&
        now - s.timestamp <= RESUME_MAX_AGE_MS,
    ) ?? null
  );
}
