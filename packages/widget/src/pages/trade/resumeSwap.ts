/**
 * Resume plan for a swap the tab lost.
 *
 * On mobile, deep-linking to the wallet backgrounds the tab and the OS often
 * evicts it. The in-memory intent dies with it, so on return the user lands on a
 * blank trade form and it reads as "the app didn't register that I signed", even
 * though the solver settled server-side. The swap itself was never at risk: the
 * local activity log persists it and polls it to a terminal state. What is
 * missing is the VIEW.
 *
 * This turns a persisted record into everything the panel needs to rebuild that
 * view, or null when it cannot be rebuilt honestly. Kept pure and separate from
 * `useSwapPanel` so the decision is testable without a React renderer, matching
 * how the rest of the panel's logic is factored (@xochi/client, swapFlowPhase,
 * pickDefaultToken). See xochi#339.
 */

import { getTokenInfoForChain, isSelectableChainId, type SelectableChainId } from "@xochi/client";
import { formatTokenAmount } from "../../utils/format.js";
import { findTokenBySymbol } from "./config.js";
import type { Token } from "../../types/intent.js";
import type { IntentStatus } from "../../types/intent.js";
import {
  DEFAULT_DESTINATION,
  STEALTH_DESTINATION,
  type IntentDestination,
} from "../../types/intent.js";
import type { SwapActivityItem, DepositActivity } from "../../types/activity.js";
import { normalizeZkMoneyTag, zkMoneyTagValid } from "./zkMoney.js";

export interface ResumePlan {
  /** The dispatched intent to adopt, so useIntent re-arms its status poll. */
  intentId: string;
  status: IntentStatus;
  // Panel legs. The flow modal reads its amounts and symbols from the PANEL, not
  // the intent, so without these the real status would render over whatever pair
  // the form happens to default to.
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
  /** Display-formatted origin amount for the panel input. */
  amount: string;
  /** Served payout captured at submit time, raw units. Null when unknown. */
  toAmount: string | null;
  /**
   * Deposit facts captured at submit time, on a deposit route only.
   *
   * This is what makes resuming a deposit swap worth doing at all: no quote is
   * synthesized, so without these the modal reopens at `awaiting_deposit` with
   * nothing on it, and the user has to leave the browser to send. Null on every
   * pull route, and on a deposit record written before this was persisted.
   */
  deposit: DepositActivity | null;
  /**
   * The destination the order was DISPATCHED with, from the record's
   * `settlementType` (written from the destination bound at confirm).
   *
   * The modal's ending describes this, never the live toggle, which starts on
   * Public after a reload. Without it a resumed stealth order ended on a public
   * receipt: an explorer link for a privacy-sensitive hash and no claim step. A
   * record with no marker reads as public, as every other reader treats it.
   */
  destination: IntentDestination;
  /**
   * When the swap was submitted, so the modal's elapsed counter reads real time
   * in flight rather than restarting from zero (which would tell a user waiting
   * ten minutes that they had just started).
   */
  startedAt: number;
}

/**
 * Build the plan, or null if the record cannot be rendered faithfully.
 *
 * Returns null rather than a partial plan on an unresolvable leg: a chain
 * outside the selectable set, or a token since retired from it. Reopening the
 * flow with the wrong pair in it would be worse than not reopening: the user
 * would be shown a live status over a trade they did not make. The activity feed
 * still lists and advances the swap either way.
 *
 * A Tron leg is NOT unresolvable and no longer refuses here. Both directions
 * rebuild: the destination corridor is live, and the origin (deposit) corridor
 * is the one that most needs this, since it cannot be completed without leaving
 * the browser.
 */
export function planResume(record: SwapActivityItem | null | undefined): ResumePlan | null {
  if (!record?.id) return null;

  const { fromChainId, toChainId, fromToken, toToken, fromAmount } = record.data;
  // Unknown chains or deployments cannot be restored faithfully.
  if (!isSelectableChainId(fromChainId) || !isSelectableChainId(toChainId)) return null;

  const fromInfo = getTokenInfoForChain(fromToken, fromChainId);
  const toInfo = getTokenInfoForChain(toToken, toChainId);
  const nextFromToken = fromInfo ? findTokenBySymbol(fromChainId, fromInfo.symbol) : undefined;
  const nextToToken = toInfo ? findTokenBySymbol(toChainId, toInfo.symbol) : undefined;
  if (!nextFromToken || !nextToToken) return null;

  const storedTag = record.data.recipientTag;
  const recipientTag = typeof storedTag === "string" ? normalizeZkMoneyTag(storedTag) : undefined;
  if (
    storedTag !== undefined &&
    (recipientTag === undefined ||
      !zkMoneyTagValid(recipientTag) ||
      toChainId !== 1 ||
      nextToToken.symbol !== "DAI" ||
      (record.data.settlementType !== undefined && record.data.settlementType !== "public"))
  ) {
    return null;
  }

  // A malformed stored amount must not throw on mount and take the panel down.
  // An empty input is a survivable degradation; the status still renders.
  let amount: string;
  try {
    amount = formatTokenAmount(BigInt(fromAmount), nextFromToken.decimals, 6);
  } catch {
    amount = "";
  }

  return {
    intentId: record.id,
    status: record.intentStatus,
    fromChainId,
    toChainId,
    fromToken: nextFromToken,
    toToken: nextToToken,
    amount,
    toAmount: record.data.toAmount ?? null,
    deposit: record.data.deposit ?? null,
    destination: recipientTag
      ? { ...DEFAULT_DESTINATION, recipientTag }
      : record.data.settlementType === "stealth"
        ? STEALTH_DESTINATION
        : DEFAULT_DESTINATION,
    startedAt: record.timestamp,
  };
}

/** The resumed swap the panel is holding: its identity and its captured facts. */
export interface ResumedSwap {
  intentId: string;
  /** Served payout captured at submit time, raw units. Null when unknown. */
  toAmount: string | null;
  /**
   * Deposit facts captured at submit time, or null on a pull route.
   *
   * Keyed to the intent id by living on this object, exactly as `toAmount` is
   * and for the same reason: a bare deposit address would outlive the swap it
   * belongs to and could be rendered against a trade that never had one.
   */
  deposit: DepositActivity | null;
  /** The dispatched order's destination, keyed to the intent id like the rest. */
  destination: IntentDestination;
}

/**
 * Which payout the panel's "Receive" field should show, in raw units, or
 * null for "show nothing".
 *
 * Extracted from the panel because it is the fabricated-payout guard, and every
 * regression in this area has been a missing case rather than wrong arithmetic:
 * both #389 and the two found in adversarial review of #398 rendered a real
 * number next to a trade it did not belong to. A pure function makes each case
 * assertable; inside a `useMemo` none of them were.
 *
 * The rules, and why each exists:
 *
 * - A live SOLVABLE quote always wins. Ordinary path.
 * - A live DECLINED quote shows nothing. `mapQuoteResponse` defaults an absent
 *   `to_amount` to "0", so reading it directly renders a fabricated "Receive
 *   0" beside the decline notice (#389). We were not quoted zero; we were not
 *   quoted at all. Critically this must NOT fall through to the resumed payout,
 *   or a decline would display the resumed swap's number instead.
 * - With NO quote at all, the resumed payout applies -- but only while the
 *   resumed intent is still the one on screen. Keyed by id so it cannot outlive
 *   its swap and reappear against a pair that was never quoted.
 */
export function selectPayoutSource(
  quote: { canSolve: boolean; toAmount: string | null } | null | undefined,
  // Only the two fields this reads, not the whole `ResumedSwap`. Asking for the
  // deposit block as well would make every caller and fixture supply a value
  // that has no bearing on which payout is shown.
  resumed: Pick<ResumedSwap, "intentId" | "toAmount"> | null | undefined,
  currentIntentId: string | null | undefined,
): string | null {
  if (quote) return quote.canSolve ? (quote.toAmount ?? null) : null;
  if (!resumed || !currentIntentId || resumed.intentId !== currentIntentId) return null;
  return resumed.toAmount;
}

/**
 * Whether the panel should write this intent into the local activity log.
 *
 * A RESUMED intent must not: the capture write sources `toAmount` and `feeRate`
 * from the live quote, a resumed intent has none, and `upsertLocalSwap` replaces
 * the nested `data` block wholesale -- so it would overwrite the record it was
 * restored FROM with nulls, destroying the served payout permanently for exactly
 * the swap the feature exists to serve. The record is already correct, and
 * `useLocalActivity` keeps its status and hashes fresh by polling. See xochi#339.
 */
export function shouldCaptureToActivity(input: {
  hasOwner: boolean;
  hasIntentId: boolean;
  isCapturedStatus: boolean;
  isResumedIntent: boolean;
}): boolean {
  return input.hasOwner && input.hasIntentId && input.isCapturedStatus && !input.isResumedIntent;
}
