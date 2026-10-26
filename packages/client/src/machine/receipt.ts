/**
 * The Receipt: what the user is told about a trade, as data.
 *
 * Every slot is a discriminated union, and the shapes are chosen so the three
 * claims the trade receipt must never make cannot even be written down:
 *
 *  - A payout floor. `PayoutSlot` has no minimum field at all. The contract is
 *    "exactly this, or a full refund" (`min_to_amount` is never enforced on any
 *    settlement path), so there is nowhere to put an "estimated min".
 *  - A shielded payout with a hidden amount. Every `SettlementDisclosure`
 *    variant fixes `amount: "visible"`; Shielded hides the recipient's account,
 *    never the amount.
 *  - A host-supplied number. Amounts and costs are `Served<...>`, a brand only
 *    this package can apply, and only to figures read off the worker's own
 *    response. A host (an embedding page, a prop, a query string) has no way to
 *    construct one without a cast.
 */

import type { SettlementType } from "../shared/index.js";
import type { QuoteResponse } from "./wire.js";
import type { SwapPhase } from "./phase.js";
import type { SignRefusal } from "./state.js";

declare const SERVED: unique symbol;

/** A figure read off the solver/worker's own response. Constructed only here. */
export type Served<T extends string | number> = T & { readonly [SERVED]: true };

function served<T extends string | number>(value: T): Served<T> {
  return value as Served<T>;
}

/** The one payout promise. */
export type PayoutSlot =
  | { kind: "none" }
  /** An anonymous, unsignable price: the same amount, marked as a preview. */
  | { kind: "preview"; amount: Served<string> }
  /** "Receive exactly X, or get a full refund." */
  | { kind: "exact"; amount: Served<string>; otherwise: "full_refund" };

/** The one cost figure: the served all-in `cost_bps`, never reconstructed. */
export type CostSlot =
  | { kind: "none" }
  /** The guard could not run. "Unavailable", never zero. */
  | { kind: "unavailable" }
  | { kind: "served"; bps: Served<number>; totalUsd: Served<string> | null };

/** What the settlement mode hides and what it leaves on-chain. */
export type SettlementDisclosure =
  | { mode: "public"; recipient: "visible"; amount: "visible"; recipientAction: "none" }
  | { mode: "stealth"; recipient: "one_time_address"; amount: "visible"; recipientAction: "claim" }
  | { mode: "shielded"; recipient: "private_account"; amount: "visible"; recipientAction: "none" };

/** The held quote, as the receipt panel shows it. */
export type QuoteSlot =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "declined"; reason: string | null }
  /**
   * A quote is on screen. `refreshing` means a replacement is being fetched
   * while the held one stays mounted (its figures dim rather than vanish).
   */
  | { kind: "ready"; executable: boolean; refreshing: boolean; expiresInSec: number | null };

/** Where the signing ceremony stands. */
export type SigningSlot =
  | { kind: "unavailable" }
  /** A deposit route: no signature at all; confirming reveals the address. */
  | { kind: "deposit" }
  | { kind: "ready"; signatures: 1 | 2 }
  | { kind: "in_wallet"; step: 1 | 2; of: 1 | 2 }
  /** Deep-link wallets: signature 1 is held, waiting for the user's tap for 2. */
  | { kind: "awaiting_second" }
  | { kind: "submitted" }
  /**
   * The Worker answered the execute not-accepted (the solver is busy), and the
   * same signed request is sent again automatically at `retryAt` (unix
   * seconds). This is resend `resend` of at most `of`. The phase stays
   * `submitting`. Suggested copy, which makes no funds claim (the signed
   * request stays executable during the wait): "Solver busy. Resending in Ns
   * (retry r of n)." with "Keep this tab open. If it closes, this tab will not
   * resend the order."
   */
  | { kind: "busy"; retryAt: number; resend: number; of: number }
  /** The sign ceremony was refused before funds could move; the quote is still on screen. */
  | { kind: "refused"; refusal: SignRefusal };

export interface Receipt {
  phase: SwapPhase;
  quote: QuoteSlot;
  payout: PayoutSlot;
  cost: CostSlot;
  settlement: SettlementDisclosure;
  signing: SigningSlot;
}

/**
 * The payout promise a quote makes. Only a quote the solver can fill makes one;
 * `minToAmount` is never read.
 */
export function payoutOf(quote: QuoteResponse | null): PayoutSlot {
  if (!quote?.canSolve) return { kind: "none" };
  const amount = served(quote.toAmount);
  return quote.preview
    ? { kind: "preview", amount }
    : { kind: "exact", amount, otherwise: "full_refund" };
}

/**
 * The cost a quote states. Absent (or unusable) `cost_bps` is `unavailable`, so
 * a renderer cannot fall back to a figure of its own making.
 */
export function costOf(quote: QuoteResponse | null): CostSlot {
  if (!quote) return { kind: "none" };
  const bps = quote.costBps;
  if (bps === undefined || !Number.isFinite(bps) || bps < 0) return { kind: "unavailable" };
  const totalUsd = quote.feeBreakdown?.totalUsd;
  return { kind: "served", bps: served(bps), totalUsd: totalUsd ? served(totalUsd) : null };
}

const DISCLOSURES: { [M in SettlementType]: Extract<SettlementDisclosure, { mode: M }> } = {
  public: { mode: "public", recipient: "visible", amount: "visible", recipientAction: "none" },
  stealth: {
    mode: "stealth",
    recipient: "one_time_address",
    amount: "visible",
    recipientAction: "claim",
  },
  shielded: {
    mode: "shielded",
    recipient: "private_account",
    amount: "visible",
    recipientAction: "none",
  },
};

/** What a settlement mode hides and what it leaves visible. */
export function settlementDisclosure(mode: SettlementType): SettlementDisclosure {
  return DISCLOSURES[mode];
}
