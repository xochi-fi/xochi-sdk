/**
 * The intent lifecycle's state, and the error value it carries.
 */

import type { ChainId, IntentStatus, SelectableChainId, SettlementType } from "../shared/index.js";
import type { QuoteResponse } from "./wire.js";
import type { StoredDepositAttestation } from "./deposit.js";

/**
 * A failure the UI can categorize by HTTP code and, on 429/503 backpressure,
 * run a retry countdown for. Most failures are a plain string instead.
 */
export interface StructuredError {
  message: string;
  code?: number;
  retryAfter?: number; // Unix timestamp
  reason?: string; // From WebSocket intent_failed
}

/**
 * Why a sign ceremony stopped before the wallet was asked for the signature
 * that moves funds, while the quote is still the one to show. Typed so the
 * renderer words it and nothing parses a message. No funds move on any of
 * these: the first three stop Confirm before any prompt; the pull kinds stop
 * after signature 1, before signature 2 (the origin pull) is requested.
 */
export type SignRefusal =
  /** The wallet is not on the origin chain the signature binds. */
  | { kind: "wrong_chain"; chainId: SelectableChainId }
  /** The account or network changed since this quote was made. */
  | { kind: "wallet_changed" }
  /** The payload to sign does not pay what the quote shows, to whom it shows. */
  | { kind: "payout_mismatch" }
  /** The served origin-pull authorization names an unpinned spender/recipient or amount. */
  | { kind: "pull_unpinned" }
  /** The token approval the origin pull needs was not granted. */
  | { kind: "approval_required" };

export interface IntentState {
  status: IntentStatus;
  intentId: string | null;
  quoteId: string | null;
  quote: QuoteResponse | null;
  // A plain string for most failures; a StructuredError{message, code, retryAfter}
  // when the API returns backpressure (429/503) so the UI can run the countdown.
  error: string | StructuredError | null;
  txHash: string | null;
  receivingTxHash: string | null;
  /** Public fill receipt (Riddler #632) + its chain; drives the receipt CTA and the settled state. */
  settlementTxHash: string | null;
  settlementChainId: ChainId | null;
  /**
   * Riddler's granular fill substatus, verbatim (`filling` | `filled` | ...).
   * Read only to tell a delivered destination leg apart from one still in
   * flight: Riddler can hold an intent at top-level `settling` with
   * `substatus: filled` indefinitely (xochi#376). Never advances the lifecycle.
   * Also `filled` when a status poll reads `settlementConfirmed` (a private
   * intent's fill confirmed, its receipt withheld from an anonymous read).
   */
  substatus: string | null;
  /**
   * True while the latest status poll was the server's anonymous view of a
   * stealth or shielded intent (xochi#563): its on-chain legs were withheld, so
   * null hashes mean "not shown", not "not there". The host offers wallet SIWE
   * recovery on it; a later owner read (no marker) clears it. Never a token.
   */
  legsWithheld: boolean;
  reconciling: boolean;
  /** Plain-language refund explanation; set only on a `refunded` status. */
  refundReason: string | null;
  /**
   * Wallet account connected when this quote was produced. The quote's EIP-712
   * digest is bound to it, so `sign()` refuses when the live wallet has since
   * switched accounts (wrong-signer), and a mid-flow change resets the intent.
   * Null until a quote lands.
   */
  quotedAddress: string | null;
  /** Wallet chain id at quote time; guards against a wrong-chain signature. */
  quotedChainId: number | null;
  /**
   * Pay amount (base units) this quote was requested at. The receipt renders
   * the HELD quote against THIS figure, never the live input field: during the
   * debounce-plus-fetch window after an edit, the two describe different
   * trades, and mixing them shows a garbage implied rate and a false
   * below-market flag. Null until a quote lands.
   */
  quotedFromAmount: string | null;
  /**
   * Settlement preference this quote was requested under. The receipt states
   * the HELD quote's settlement, never the live form's: the two come apart when
   * the user flips settlement while a quote is on screen, and the wallet signs
   * the held one. Null until a quote lands.
   */
  quotedSettlement: SettlementType | null;
  /**
   * Deposit-acceptance deadline (unix seconds) for a deposit route, or null.
   *
   * Held on the INTENT, not read off `state.quote`, because it is a fact about
   * the solver's acceptance window rather than about a price. The two come apart
   * on a resumed swap: no quote is ever synthesized (a stale price shown as
   * current would be a lie), so a quote-sourced deadline was undefined there and
   * the status poll fell back to its flat 10-minute ceiling while the restored
   * screen counted down the real 30-minute window. The poll then stopped and
   * said so, next to a countdown saying otherwise.
   *
   * `pollCeilingAttempts` reads this, so it must be set anywhere an intent can
   * enter `awaiting_deposit`: quote ingest and resume both.
   */
  depositDeadline: number | null;
  /**
   * The VERIFIED deposit binding: the exact fields the solver signed plus the
   * signature over them, as proven by `verifyDepositAttestation` at ingest.
   *
   * Held so it can be persisted with the swap record and re-proven on resume. A
   * resumed deposit address is read back out of localStorage, which is not a
   * trust boundary, so it has to be checked by the same code that checks a live
   * one rather than trusted because it was ours once. Null on any route without
   * an attested deposit.
   */
  attestedDeposit: StoredDepositAttestation | null;
  /**
   * True once the status poll has hit its ceiling and stopped for this intent.
   *
   * Surfaced because a stopped poll and a poll that has found nothing yet are
   * otherwise indistinguishable on screen: both render a spinner. A view that
   * claims to be checking must be able to tell whether it still is.
   */
  pollExhausted: boolean;
  /**
   * Set on a `failed` read after an execute (or a revealed deposit address)
   * that does not carry the Worker's nothing-moved marker
   * (`failureMayHaveMoved`): the order did not complete and the funds may have
   * moved. Terminal and never offered Retry: the phase is `may-have-moved`, the
   * poll is stopped, and no quote starts until Reset.
   */
  mayHaveMoved: boolean;
  /**
   * Set when this client stops resending an execute the Worker answered
   * not-accepted (`decideExecuteResend` gives up): the order was not sent, but
   * the signed request stays executable until its deadline, so there is no
   * Retry yet. The status stays `executing`, the phase is `not-sent`, and the
   * poll runs on until the Worker finishes the intent `failed` (Retry only
   * with `NOT_EXECUTED_SUBSTATUS`). Cleared by any read other than `quoted`
   * (another execute claimed it: shown in doubt) and by leaving `executing`.
   */
  notSent: boolean;
  /**
   * Set when a sign ceremony was refused before the funds-moving signature
   * (see SignRefusal). The intent is `quoted` so the quote stays on screen; a
   * new quote, a successful Confirm or a reset clears it.
   */
  refusal: SignRefusal | null;
}

export const INITIAL_INTENT_STATE: IntentState = {
  status: "idle",
  intentId: null,
  quoteId: null,
  quote: null,
  error: null,
  txHash: null,
  receivingTxHash: null,
  settlementTxHash: null,
  settlementChainId: null,
  substatus: null,
  legsWithheld: false,
  reconciling: false,
  refundReason: null,
  quotedAddress: null,
  quotedChainId: null,
  quotedFromAmount: null,
  quotedSettlement: null,
  depositDeadline: null,
  attestedDeposit: null,
  pollExhausted: false,
  mayHaveMoved: false,
  notSent: false,
  refusal: null,
};
