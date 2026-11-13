/**
 * useSwapFlow
 *
 * The dispatch half of the swap panel's view-model: submitting the order,
 * driving the flow modal, restoring an order the tab lost, recording what ran,
 * and the single CTA sentence that weighs every other group's verdict. Split
 * out of the 1666-line `useSwapPanel` closure (DEBT-014 step 3) and
 * constructed LAST, because it reads all three groups upstream -- the legs, the
 * amount bounds, the settlement mode and the quote -- and writes back into them
 * on the two restore paths (retry prefill, resumed swap) through the narrow
 * setters they export.
 *
 * Owns the executed order's own destination (bound at confirm, never re-read
 * from the live toggle), the execution clock, and the local activity capture.
 *
 * Deliberately does NOT own the quote (it receives the intent), the flow-modal
 * flag (`flowOpen` also pauses the quote refresh and suppresses the re-quote,
 * so the composition holds it) or the restored payout record (`resumed`, read
 * by the amount group for its payout line).
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSwitchChain } from "wagmi";
import { useToast } from "../../components/Toast.js";
import type { UseIntentReturn } from "../../hooks/useIntent.js";
import { GLYPH } from "../../lib/glyphs.js";
import { formatTokenAmount } from "../../utils/format.js";
import { presetAmountText } from "./useSwapAmount.js";
import { type SettlementType } from "../../types/index.js";
import {
  type IntentDestination,
  type Token,
  getStatusLabel,
  isChainId,
} from "../../types/intent.js";
import { UI } from "../../constants.js";
import {
  EXTENDED_CHAIN_NAMES,
  MAX_PRICE_IMPACT_PERCENT,
  NOT_EXECUTED_SUBSTATUS,
  getTokenInfoForChain,
  type SelectableChainId,
} from "@xochi/client";
import { findTokenBySymbol } from "./config.js";
import { planResume, shouldCaptureToActivity } from "./resumeSwap.js";
import type { ResumedSwap } from "./resumeSwap.js";
import type { RouteCheck, SwapRouteLegs } from "./useSwapRoute.js";
import type { SettlementFix } from "../../lib/settlementAvailability.js";
import type { DepositActivity } from "../../types/activity.js";
import {
  upsertLocalSwap,
  toActivityStatus,
  findResumableSwap,
  dismissResumableSwap,
} from "../../lib/localActivity.js";
import { verifyStoredDeposit } from "@xochi/client";
import { DEPOSIT_ATTESTATION_PIN } from "../../config.js";
import { normalizeZkMoneyTag, zkMoneyTagValid } from "./zkMoney.js";

// The submit button's label while the selected privacy mode is unavailable.
// "wallet" never shows here: the disconnected branch outranks it.
const SETTLEMENT_FIX_BUTTON: Record<SettlementFix, string> = {
  wallet: "Connect wallet",
  setup: "Set up Stealth",
  quote: "Updating quote...",
  destination: "Choose a Stealth destination",
  route: "Choose another privacy mode",
  unavailable: "Choose an available privacy mode",
  route_loading: "Loading routes",
  route_unavailable: "Retry route data",
  public_only: "Use Public for Canton",
};

// Intent statuses at or past submission -- only these are logged to the local
// activity feed, so a quote the user never executes never becomes a "swap".
const CAPTURED_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
  "completed",
  "refunded",
  "failed",
]);

/**
 * Retry prefill from a history row. The panel resolves the token addresses back
 * to selectable Token objects on their chains and formats the raw amount. The
 * `nonce` makes each Retry click distinct so a repeated click re-applies, while
 * the effect never runs on unrelated re-renders (so it can't clobber typing).
 */
export interface SwapPrefill {
  nonce: number;
  /**
   * Selectable, not EVM-only: a history row can now carry a Tron leg, and Retry
   * is offered on any failed/refunded/expired row. Typing these as `ChainId`
   * would make every Tron retry take the "chain you can't reload" branch.
   */
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  /**
   * Settlement mode of the original order, restored on retry (Phase 6).
   * Absent on rows captured before the field existed, which reads as public.
   */
  settlement?: SettlementType;
  recipientTag?: string;
  refundAddress?: string;
}

export interface UseSwapFlowParams {
  prefill: SwapPrefill | null | undefined;
  intent: UseIntentReturn;
  isConnected: boolean;
  address: string | undefined;
  /** The wallet's actual chain (`useAccount().chainId`); may be one wagmi has no config for. */
  connectedChainId: number | undefined;
  /** Route facts and the restore write. */
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
  routeCheck: RouteCheck;
  applyRoute: (legs: SwapRouteLegs) => void;
  /** Amount facts and the restore write. */
  amount: string;
  amountBigInt: bigint;
  insufficientBalance: boolean;
  /** Origin balance, for the "Use max" CTA an over-balance amount gets. */
  currentBalance: bigint | null;
  excessiveSlippage: boolean;
  orderOutOfBounds: boolean;
  setAmount: (value: string) => void;
  /** Settlement facts and the restore writes. */
  settlement: SettlementType;
  /** The selected mode's fix; non-null blocks submit until the user acts. */
  settlementFix: SettlementFix | null;
  destination: IntentDestination;
  recipientMissing: boolean;
  recipientInvalid: boolean;
  restoreSettlement: (next: SettlementType) => void;
  clearRecipient: () => void;
  restoreRecipientTag: (tag: string) => void;
  restoreRefundAddress: (address: string) => void;
  /** Flow-modal state, held by the composition (it also pauses the quote). */
  flowOpen: boolean;
  setFlowOpen: (open: boolean) => void;
  /** The restored swap record, read here and by the amount group's payout. */
  resumed: ResumedSwap | null;
  setResumed: Dispatch<SetStateAction<ResumedSwap | null>>;
}

/** The submit button: what it says and what a click on it does. */
export interface SwapCta {
  label: string;
  /** "useMax" fills the pay field with the balance instead of submitting. */
  action: "submit" | "useMax";
}

export interface UseSwapFlowResult {
  handleMarketSubmit: () => Promise<void>;
  handleConfirmSwap: () => void;
  handleCancelSign: () => void;
  /** The amount on screen differs from the held quote's; submit waits for the re-quote. */
  quoteStale: boolean;
  handleCloseFlow: () => void;
  handleStartOver: () => void;
  flowReopenable: boolean;
  flowDestination: IntentDestination;
  executionStartTime: number | null;
  resumedDeposit: DepositActivity | null;
  /** The one CTA, from one precedence chain: label and action cannot disagree. */
  cta: SwapCta;
  needsChainSwitch: boolean;
}

export function useSwapFlow({
  prefill,
  intent,
  isConnected,
  address,
  connectedChainId,
  fromChainId,
  toChainId,
  fromToken,
  toToken,
  routeCheck,
  applyRoute,
  amount,
  amountBigInt,
  insufficientBalance,
  currentBalance,
  excessiveSlippage,
  orderOutOfBounds,
  setAmount,
  settlement,
  settlementFix,
  destination,
  recipientMissing,
  recipientInvalid,
  restoreSettlement,
  clearRecipient,
  restoreRecipientTag,
  restoreRefundAddress,
  flowOpen,
  setFlowOpen,
  resumed,
  setResumed,
}: UseSwapFlowParams): UseSwapFlowResult {
  const { showToast } = useToast();
  const { switchChainAsync } = useSwitchChain();

  const [executionStartTime, setExecutionStartTime] = useState<number | null>(null);
  // The destination the EXECUTED order was dispatched with, bound at confirm
  // time and held until the intent resets. The modal's ending (stealth claim
  // note vs explorer link) must describe the order that ran, never the live
  // toggle: flowReopenable invites closing the modal and returning to the
  // form, where nothing stops the settlement mode changing mid-flight. Read
  // through `flowDestination` below; null whenever no order is in flight. A
  // resumed order was never confirmed here, so its bound copy is the record's
  // (`resumedDestination` below).
  const [executedDestination, setExecutedDestination] = useState<IntentDestination | null>(null);

  /**
   * True while the panel is showing a RESUMED intent, i.e. one restored from the
   * stored record rather than quoted in this session.
   *
   * Derived from the id rather than tracked as its own boolean, so it cannot get
   * out of step: the moment `intent.intentId` changes or clears, this is false.
   */
  const isResumedIntent = resumed !== null && resumed.intentId === intent.intentId;

  // Tag labels on a held quote describe its accepted recipient, not edits to
  // the form behind the modal. The quote remains the funding authority.
  const quotedDestination: IntentDestination = intent.quote
    ? { ...destination, recipientTag: intent.quote.recipientTag }
    : destination;

  /**
   * Deposit facts for a RESUMED deposit swap, so the flow modal can rebuild the
   * one screen the user has to act on. Null for everything else.
   *
   * Gated on `isResumedIntent`, which keys it to the intent id, for the same
   * reason `selectPayoutSource` is: an address that outlived its swap would be
   * rendered against a trade that never had one, and this address is the thing
   * the user is about to send real funds to.
   */
  const resumedDeposit = isResumedIntent ? resumed.deposit : null;

  /**
   * The destination a RESUMED order was dispatched with, from its record. Plays
   * the part `executedDestination` plays for an order confirmed in this session,
   * since a resumed one never passes through confirm. Keyed to the intent id via
   * `isResumedIntent`, like the deposit facts above, so it stops applying the
   * moment the resumed intent resets.
   */
  const resumedDestination = isResumedIntent ? resumed.destination : null;

  // Apply a Retry prefill from a history row. Runs once per distinct nonce (an
  // explicit Retry click), so it never fires on ordinary re-renders and cannot
  // clobber mid-typing edits. Resolves each token address to a selectable Token
  // on its chain; if a leg cannot be resolved (unknown/unsupported token or a
  // non-EVM chain), it leaves the panel untouched and tells the user.
  const appliedPrefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || prefill.nonce === appliedPrefillNonce.current) return;
    appliedPrefillNonce.current = prefill.nonce;

    const fromInfo = getTokenInfoForChain(prefill.fromToken, prefill.fromChainId);
    const toInfo = getTokenInfoForChain(prefill.toToken, prefill.toChainId);
    const nextFromToken = fromInfo
      ? findTokenBySymbol(prefill.fromChainId, fromInfo.symbol)
      : undefined;
    const nextToToken = toInfo ? findTokenBySymbol(prefill.toChainId, toInfo.symbol) : undefined;
    if (!nextFromToken || !nextToToken) {
      showToast("Couldn't reload that trade. Set it up again.", "error");
      return;
    }
    const recipientTag =
      typeof prefill.recipientTag === "string"
        ? normalizeZkMoneyTag(prefill.recipientTag)
        : undefined;
    if (
      prefill.recipientTag !== undefined &&
      (recipientTag === undefined ||
        !zkMoneyTagValid(recipientTag) ||
        prefill.toChainId !== 1 ||
        nextToToken.symbol !== "DAI" ||
        (prefill.settlement !== undefined && prefill.settlement !== "public"))
    ) {
      showToast("Couldn't reload that trade. Set it up again.", "error");
      return;
    }

    intent.reset();
    // Restore the order's selected mode even if its route is no longer
    // authorized. It stays selected with its fix shown; no quote is requested
    // until that exact mode is eligible. Shielded remains listed so the flag
    // flip does not require changing the restore path.
    //
    // Pre-live a restored Shielded stays selected and reads "Unavailable";
    // no shielded quote is ever requested, and the server gate would refuse
    // one anyway, fail-closed, before persisting or calling the solver.
    //
    // This IS reachable, unlike an earlier note here claiming otherwise: the
    // prefill mode comes from an activity row, and server history maps
    // settlement_type straight through, so prod D1 can hand back a shielded
    // row from the window when shielded rode the stealth flag.
    restoreSettlement(
      prefill.settlement === "stealth"
        ? "stealth"
        : prefill.settlement === "shielded"
          ? "shielded"
          : "public",
    );
    clearRecipient();
    restoreRecipientTag(recipientTag ?? "");
    restoreRefundAddress(prefill.refundAddress ?? "");
    applyRoute({
      fromChainId: prefill.fromChainId,
      toChainId: prefill.toChainId,
      fromToken: nextFromToken,
      toToken: nextToToken,
      zkMoneyDestination: recipientTag !== undefined,
    });
    try {
      setAmount(formatTokenAmount(BigInt(prefill.fromAmount), nextFromToken.decimals, 6));
    } catch {
      setAmount("");
    }
    // Keyed on the prefill nonce (the real guard); intent/setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, showToast]);

  // Restore the flow modal for a swap this tab lost.
  //
  // On mobile, deep-linking to the wallet backgrounds the tab and the OS often
  // evicts it. The in-memory intent dies with it, so on return the user lands on
  // a blank trade form and it reads as "the app didn't register that I signed",
  // even though the solver settled server-side. The swap itself was never at
  // risk: the local activity log persists it and polls it to terminal. What was
  // missing was the VIEW, so this rebuilds it from that same record.
  //
  // Order matters. The panel legs go first because the modal reads its amounts
  // and symbols from the panel, not the intent, so adopting the intent first
  // would paint the real status over the DEFAULT pair for a frame. Then the
  // intent is adopted, which re-arms the status poll in useIntent.
  //
  // Only from a clean panel (idle, no modal), only once per wallet, and only
  // for a dispatched, non-terminal, undismissed, recent record. See xochi#339.
  const resumedForAddress = useRef<string | null>(null);
  useEffect(() => {
    if (!address || resumedForAddress.current === address) return;
    if (flowOpen || intent.status !== "idle") return;

    // planResume returns null on a leg it cannot render faithfully, in which
    // case the panel is left alone; the feed still shows and advances the swap.
    const plan = planResume(findResumableSwap(address));
    if (!plan) return;

    resumedForAddress.current = address;
    applyRoute({
      fromChainId: plan.fromChainId,
      toChainId: plan.toChainId,
      fromToken: plan.fromToken,
      toToken: plan.toToken,
      zkMoneyDestination: plan.destination.recipientTag !== undefined,
    });
    setAmount(plan.amount);
    // The served quote is gone and is never synthesized, so the modal's "you
    // receive" would be blank on the success view. Carry the payout the record
    // captured at submit time instead -- a real served number, not an estimate.
    // Stored WITH its intent id so it cannot outlive the swap it describes.
    //
    // The deposit block starts NULL and is only filled in once proven, below.
    // A deposit address restored from storage is a value the user sends real
    // funds to by hand, and localStorage is same-origin mutable state, so it
    // gets the same treatment a live one gets rather than being trusted because
    // it was ours once. Starting null also means no unproven address can flash
    // on screen while the check runs.
    setResumed({
      intentId: plan.intentId,
      toAmount: plan.toAmount,
      deposit: null,
      destination: plan.destination,
    });
    // Elapsed counts from the original submit, not from now: a user ten minutes
    // into a settling swap must not be told they just started.
    setExecutionStartTime(plan.startedAt);

    // Re-prove the stored deposit binding BEFORE anything reads it.
    //
    // `verifyStoredDeposit` (@xochi/client) runs the SAME signature check a live
    // quote gets (`@xochi/signer`'s `verifyDepositAttestation`), plus two binding checks a live quote does not need: the
    // attestation must name this record's intent, and it must name the wallet
    // the record is filed under. The second is what stops a transplant, since an
    // attacker can obtain a perfectly genuine attestation for their OWN deposit
    // quote and paste it into someone else's record; what they cannot do is make
    // it name the victim's wallet.
    //
    // The ADOPT waits on it, and that ordering is the point. The deposit
    // deadline goes across with the adopt because it is what the status poll
    // sizes its ceiling from, and it is a field of the very binding under
    // question: handing it over first meant the poll ran on an unproven number
    // that nothing rolled back when the proof failed, so the poll would keep
    // checking against a deadline sitting beside a countdown built from a
    // different one. Verification is pure local secp256k1 with no RPC, so the
    // wait is a microtask, not a round trip.
    //
    // On failure the deposit block stays null and the deadline is not adopted:
    // the swap still resumes and keeps polling on the flat ceiling, and the
    // modal renders the unavailable view rather than an address. Fail-closed,
    // and loud, because an address that will not verify is either tampering or a
    // bug and both need a human. A record written by a build from before the
    // cutover (camelCase fields) is neither: the client renames it and proves it
    // like any other, and what is adopted is the binding it PROVED
    // (`result.stored`), never `plan.deposit`, which is whatever shape storage
    // held. `verifyStoredDeposit` reads the record as `unknown` and refuses any
    // shape or field type it does not recognise, so a stored record cannot
    // throw out of this chain.
    const adopt = (deposit: DepositActivity | null): void => {
      // `address` is the wallet the record was filed under, and becomes the
      // adopted intent's owner. Without it the panel's activity write would fall
      // back to the live wallet and leak this swap into the next account
      // switched to.
      intent.resume(
        plan.intentId,
        plan.status,
        address,
        deposit?.attested.deposit_deadline ?? null,
      );
      if (deposit) {
        setResumed((prev) =>
          prev && prev.intentId === plan.intentId ? { ...prev, deposit } : prev,
        );
      }
      setFlowOpen(true);
    };

    Promise.resolve()
      .then(() =>
        verifyStoredDeposit(plan.deposit, DEPOSIT_ATTESTATION_PIN.signer || null, {
          intentId: plan.intentId,
          owner: address,
        }),
      )
      .then((result) => {
        if (result.ok) {
          adopt(result.stored);
          return;
        }
        if (plan.deposit) {
          console.error(
            "[useSwapFlow] Refusing a stored deposit binding that does not verify; " +
              "resuming without a deposit address.",
            { intentId: plan.intentId, kind: result.kind, reason: result.reason },
          );
        }
        adopt(null);
      });
    // Guarded by the ref + the idle check; intent/setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, flowOpen, intent.status]);

  // Log a submitted swap to the local activity feed. Trading is wallet-first, so
  // the Member-gated history endpoint returns nothing here; persisting locally is
  // what makes the feed reflect the user's own trades. Keyed on intentId+status,
  // so it upserts as the swap advances (executing -> completed) and never logs a
  // quote the user only previewed.
  useEffect(() => {
    // Key the write by the address that OWNED the swap (the account the quote was
    // bound to), never the live wallet. Otherwise an A->B account switch mid-flight
    // would write A's swap (amounts, intent ids, tx hashes) into B's activity log --
    // on a shared device B would see A's trades. Falls back to the live address only
    // before a quote lands (no owner yet).
    const owner = intent.quotedAddress ?? address;
    // Whether to write at all is `shouldCaptureToActivity` (resumeSwap.ts), which
    // documents why a resumed intent must be excluded: it would overwrite the
    // record it was restored FROM with nulls.
    if (
      !shouldCaptureToActivity({
        hasOwner: Boolean(owner),
        hasIntentId: Boolean(intent.intentId),
        isCapturedStatus: CAPTURED_STATUSES.has(intent.status),
        isResumedIntent,
      })
    ) {
      return;
    }
    // Narrowing for TypeScript; both were just checked above.
    if (!owner || !intent.intentId) return;
    // No EVM-only gate here any more. `SwapActivity` types both legs as
    // `SelectableChainId`, so a Tron leg is representable and gets written like
    // any other.
    //
    // What the old `isChainId` skip cost: everything downstream of this write is
    // what survives losing the tab. The activity row, the background status poll
    // in `useLocalActivity`, and `findResumableSwap`, which reopens the flow
    // modal after a mobile eviction (xochi#339). Skipping meant a swap had none
    // of the three and existed only in the memory of one tab. Tron DESTINATION
    // is live, so that was dropping production swaps, and Tron ORIGIN is the
    // flow where losing the tab is the NORMAL case, because the user has to
    // leave the browser for a Tron wallet to send at all.
    upsertLocalSwap(owner, {
      id: intent.intentId,
      type: "swap",
      timestamp: Date.now(),
      status: toActivityStatus(intent.status),
      intentStatus: intent.status,
      // Null (no status read of this intent yet) writes nothing: a capture write
      // must not clear a withheld verdict the feed's own poll stored.
      ...(intent.legsWithheld === null ? {} : { legsWithheld: intent.legsWithheld }),
      data: {
        fromChainId,
        toChainId,
        fromToken: fromToken.address,
        toToken: toToken.address,
        fromAmount: amountBigInt.toString(),
        toAmount: intent.quote?.toAmount ?? null,
        tier: intent.tierName,
        feeRate: intent.quote?.xochiFeeRate ? parseFloat(intent.quote.xochiFeeRate) : 0,
        txHash: intent.txHash,
        receivingTxHash: intent.receivingTxHash,
        settlementTxHash: intent.settlementTxHash,
        settlementChainId: intent.settlementChainId,
        // The machine keeps a failure's verdict, not its substatus. A `failed` it
        // does not end on `may-have-moved` is one the Worker marked `not_executed`
        // or one that was never sent: nothing moved, so the feed may retry it.
        substatus:
          intent.status === "failed"
            ? intent.receipt.phase === "may-have-moved"
              ? null
              : NOT_EXECUTED_SUBSTATUS
            : intent.substatus,
        // The dispatched order's own mode (bound at confirm), never the live
        // toggle: this effect re-runs on later status/tx-hash transitions, and
        // the toggle can change in between (close the flow, tap Public, or
        // change the route).
        // Re-capturing with the live value would strip a completed stealth
        // row's "Go to claims" action, or fabricate one on a public row. The
        // live value is only the fallback for a capture no confirm preceded.
        settlementType: executedDestination
          ? executedDestination.type === "stealth"
            ? "stealth"
            : "public"
          : settlement,
        recipientTag: executedDestination?.recipientTag ?? intent.quote?.recipientTag,
        isCrossChain: fromChainId !== toChainId,
        // The VERIFIED deposit binding, stored verbatim, so a resumed swap gets
        // a usable screen back rather than a modal with no address on it.
        //
        // Not a set of loose display fields: localStorage is same-origin
        // mutable state, so whatever is written here has to be re-provable on
        // the way back out, and only the signed fields plus their signature
        // are. `verifyStoredDeposit` is what does that proving.
        //
        // Written only while the quote is still in hand. Once the panel is
        // resumed there IS no quote, and `shouldCaptureToActivity` refuses the
        // write entirely for that case, so this cannot blank an existing block.
        deposit: intent.attestedDeposit,
      },
    });
    // Snapshot the panel state at capture; only re-run when the owner, intent
    // identity, status, or either leg's tx hash changes (upsert is idempotent by
    // id). The fill hash can land a poll after status flips to completed, so
    // track it too or the destination-leg link would be lost.
    // `isResumedIntent` is tracked so the guard above re-evaluates if the panel
    // stops showing a resumed intent while the same effect inputs hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    intent.quotedAddress,
    address,
    isResumedIntent,
    intent.intentId,
    intent.status,
    intent.legsWithheld,
    intent.txHash,
    intent.receivingTxHash,
    intent.settlementTxHash,
    intent.settlementChainId,
  ]);

  // Close the confirm modal if the account or chain changes while it is open.
  // The intent hook resets the carried quote on the same change (it was bound to
  // the prior wallet); closing the modal keeps the two surfaces in lockstep so a
  // reviewing user can't confirm a quote that no longer matches their wallet.
  useEffect(() => {
    if (flowOpen) setFlowOpen(false);
    // Intentionally keyed only on the wallet context; flowOpen is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, connectedChainId]);

  // Signing binds the EIP-712 domain to the origin chain. Switch once a trade
  // is ready to sign, or before deriving Stealth's chain-scoped keys.
  // Deposit origins never switch. Read the connection's own chain, not
  // wagmi's last configured one (xochi#539).
  const wrongChain = isConnected && isChainId(fromChainId) && connectedChainId !== fromChainId;
  const needsChainSwitch =
    wrongChain &&
    (settlementFix === "setup" || (intent.canSign && !insufficientBalance && !excessiveSlippage));

  // An order is in flight but the flow modal was closed. The panel then owes
  // the user exactly one thing: the way back in. The CTA reopens the modal and
  // restores current status (trade-widget-mvp.md Phase 5). awaiting_deposit is
  // included on purpose: closing the deposit screen otherwise stranded the
  // deposit address behind a disabled button for the whole acceptance window.
  // A `may-have-moved` ending read with the modal closed is reopenable too: the
  // machine refuses every quote until Reset, and that ending's Close is the reset.
  const flowReopenable =
    !flowOpen &&
    (intent.status === "executing" ||
      intent.status === "bridging" ||
      intent.status === "settling" ||
      intent.status === "awaiting_deposit" ||
      intent.receipt.phase === "may-have-moved");

  // The amount on screen is not the amount the held quote was priced at: the
  // field changed and the replacement quote is still in its debounce or fetch.
  // The held quote stays signable through that window (the machine keeps it
  // `quoted`), so without this a second tap on the CTA -- e.g. right after "Use
  // max" rewrote the amount -- would open the confirm flow on the OLD amount.
  const quoteStale =
    intent.quotedFromAmount !== null && intent.quotedFromAmount !== amountBigInt.toString();

  const hasCurrentSettlementAuthority = routeCheck.status === "supported" && settlementFix === null;

  // Invalidate only a quote that is still provably pre-dispatch. During a
  // wallet prompt, cancelSign arbitrates the race with execute: false means the
  // machine already advanced and this hook must not reset or close its order.
  const invalidateHeldQuote = useCallback((): boolean => {
    let cancellable =
      intent.status === "pending" || intent.status === "quoting" || intent.status === "quoted";
    if (intent.status === "signing") cancellable = intent.cancelSign();
    if (!cancellable) return false;

    intent.reset();
    setFlowOpen(false);
    setExecutionStartTime(null);
    setExecutedDestination(null);
    return true;
  }, [intent.status, intent.cancelSign, intent.reset, setFlowOpen]);

  // Capability refreshes can resolve while the confirmation surface is open.
  // Close it and drop the held quote if its route, mode or input amount no
  // longer matches what the user is reviewing.
  useEffect(() => {
    if (flowOpen && (!hasCurrentSettlementAuthority || quoteStale)) invalidateHeldQuote();
  }, [flowOpen, hasCurrentSettlementAuthority, quoteStale, invalidateHeldQuote]);

  const handleMarketSubmit = useCallback(async (): Promise<void> => {
    // Reopen, never re-submit: while an order is in flight the CTA is a view
    // action, and every guard below belongs to submitting a NEW order. Checked
    // before the wallet guard: the progress view reads public status, so a
    // session that drops mid-fill keeps the way back in.
    if (flowReopenable) {
      setFlowOpen(true);
      return;
    }
    if (!isConnected) {
      showToast(UI.CONNECT_PROMPT, "error");
      return;
    }
    // The selected privacy mode is unavailable. It stays selected (the user's
    // choice is never switched for them) and the button names its fix.
    if (settlementFix !== null && !(settlementFix === "setup" && needsChainSwitch)) return;
    // Wrong network: switch to the origin chain, then let the user confirm again
    // (the CTA becomes the normal Swap action once the wallet is on-chain).
    if (needsChainSwitch && isChainId(fromChainId)) {
      try {
        await switchChainAsync({ chainId: fromChainId });
      } catch {
        showToast(`Switch the wallet to ${EXTENDED_CHAIN_NAMES[fromChainId]} to continue`, "error");
      }
      return;
    }
    if (!hasCurrentSettlementAuthority) {
      invalidateHeldQuote();
      return;
    }
    if (intent.canAllocateDepositRoute) {
      if (insufficientBalance) {
        showToast(`Not enough ${fromToken.symbol} to cover this swap`, "error");
        return;
      }
      if (excessiveSlippage) {
        showToast(
          `This trade would lose over ${MAX_PRICE_IMPACT_PERCENT}% to fees and price. Increase the amount.`,
          "error",
        );
        return;
      }
      if (await intent.allocateDepositRoute()) setFlowOpen(true);
      return;
    }
    if (!intent.canSign) {
      showToast("Get a quote first", "error");
      return;
    }
    if (quoteStale) {
      showToast("Updating the quote for the new amount", "info");
      return;
    }
    if (insufficientBalance) {
      showToast(`Not enough ${fromToken.symbol} to cover this swap`, "error");
      return;
    }
    if (excessiveSlippage) {
      showToast(
        `This trade would lose over ${MAX_PRICE_IMPACT_PERCENT}% to fees and price. Increase the amount.`,
        "error",
      );
      return;
    }
    setFlowOpen(true);
  }, [
    isConnected,
    flowReopenable,
    needsChainSwitch,
    fromChainId,
    switchChainAsync,
    intent.canSign,
    quoteStale,
    intent.canAllocateDepositRoute,
    intent.allocateDepositRoute,
    insufficientBalance,
    fromToken.symbol,
    excessiveSlippage,
    settlementFix,
    hasCurrentSettlementAuthority,
    invalidateHeldQuote,
    showToast,
    setFlowOpen,
  ]);

  // Confirm in the modal -> sign. Recheck exact route and settlement authority
  // here, at the dispatch boundary, rather than trusting the panel button that
  // opened the modal. Outcomes (executing/failed/completed) flow back through
  // intent status and the modal renders them; no toast, no closing here.
  const handleConfirmSwap = useCallback((): void => {
    if (!hasCurrentSettlementAuthority || !intent.canSign || quoteStale) {
      invalidateHeldQuote();
      return;
    }
    setExecutionStartTime(Date.now());
    setExecutedDestination(quotedDestination);
    intent.sign();
  }, [
    hasCurrentSettlementAuthority,
    intent.canSign,
    quoteStale,
    intent.sign,
    invalidateHeldQuote,
    quotedDestination,
  ]);

  // A dismissed wallet prompt has not dispatched anything. End the machine's
  // ceremony immediately and release the destination snapshot so the same
  // reviewed quote can be signed again or the form can be edited safely.
  const handleCancelSign = useCallback((): void => {
    // Ignored once the execute is out: that order keeps its destination.
    if (!intent.cancelSign()) return;
    setExecutionStartTime(null);
    setExecutedDestination(null);
  }, [intent]);

  // Single close for the flow modal.
  //
  // Terminal phases reset outright. The `pending` phase -- the "Still confirming,
  // you can safely close this" screen -- ALSO resets, because the panel otherwise
  // stays welded to an intent that may never terminalize: `settling` is in both
  // LOADING_STATES and QUOTE_BUSY_STATES, so the submit button sits disabled on
  // "Settling..." and every new quote request is suppressed for the rest of the
  // session. A stealth swap held at `settling` (xochi#353) therefore told the user
  // it was safe to close and then silently took trading away from them, with a
  // page reload as the only exit.
  //
  // Losing the modal's copy of the intent is safe here precisely because the
  // screen we are closing says so: the swap is already recorded in the local
  // activity log, which polls it to a terminal state on its own and toasts on
  // completion (useLocalActivity). Mid-flight phases that still need the modal
  // (signing, submitting) are untouched.
  //
  // `may-have-moved` resets like `failed`: it is terminal, the poll has stopped,
  // and the machine refuses every quote until Reset, so holding it would weld
  // the panel the same way. The swap stays in the local activity log, which is
  // where that screen sends the user. `not-sent` does NOT reset: its signed
  // request stays executable until it expires (an embedding page the signature
  // passed through can still send it), so a new order beside it could execute
  // both. The panel keeps watching it, and "View order progress" reopens it.
  const handleCloseFlow = useCallback((): void => {
    setFlowOpen(false);
    // Closing is an explicit "I am done watching this one". Record it so the
    // resume effect never reopens this swap on a later load, even while it is
    // still in flight -- otherwise an unrelated reload would put the modal back
    // in the user's face. Written against the account that OWNED the swap, for
    // the same reason the activity log is (an A->B switch must not write into
    // B's storage). Dismissal is per intent id, so a NEW swap still resumes.
    //
    // The status goes with it because the id alone is not enough to tell the two
    // closes apart: it is minted at QUOTE time and reused by execute, so backing
    // out of the confirm modal and then swapping for real happens under ONE id.
    // `dismissResumableSwap` keeps that rule, and only records a dispatched swap.
    const owner = intent.quotedAddress ?? address;
    if (intent.intentId) dismissResumableSwap(owner, intent.intentId, intent.status);
    // The machine's receipt phase, the same one SwapFlowModal renders, so
    // `settling` while reconciling reads as `pending` here too -- otherwise the
    // `pending` branch below could never run and the user would be closing the
    // "safe to close" screen while the panel decided they were mid-flight.
    const phase = intent.receipt.phase;
    if (
      phase === "success" ||
      phase === "refunded" ||
      phase === "failed" ||
      phase === "may-have-moved" ||
      phase === "pending"
    ) {
      intent.reset();
      setExecutionStartTime(null);
      setExecutedDestination(null);
      // `resumed` needs no clearing here: it is keyed to the intent id, so the
      // reset above already stops it applying. Left to be dropped on the next
      // resume rather than cleared on one of several exit paths, since missing
      // one of those is what let a stale payout render in the first place.
    }
  }, [intent, address, setFlowOpen]);

  /**
   * Abandon a deposit swap whose window has closed and free the panel to quote
   * again.
   *
   * Deliberately NOT what `handleCloseFlow` does. That one holds the intent at
   * the deposit phase on purpose, because a deposit may still be in flight and
   * dropping the intent would drop the only thing watching for it. The cost is
   * that the panel stays in `awaiting_deposit`, which suppresses re-quoting, so
   * the closed-window copy telling the user to start again asked for something
   * the state machine refuses.
   *
   * Past the deadline that trade-off flips: the window is closed, a late deposit
   * is refunded rather than filled, and there is no fill left to watch for. So
   * this resets unconditionally and the user gets a working panel back. It is
   * user-initiated, which is the same distinction the #857 refresh budget draws:
   * a fresh quote mints a fresh deposit address, and that is the point here
   * rather than an accident of an idle tab.
   */
  const handleStartOver = useCallback((): void => {
    setFlowOpen(false);
    const owner = intent.quotedAddress ?? address;
    if (intent.intentId) dismissResumableSwap(owner, intent.intentId, intent.status);
    intent.reset();
    setExecutionStartTime(null);
    setExecutedDestination(null);
  }, [intent, address, setFlowOpen]);

  // In flight with the modal closed: the CTA is the way back into the
  // progress view, so it must read as one (Phase 5), and it outranks the
  // status label the loading branch below would print on a dead button. It
  // also outranks the connect prompt: the progress view reads public status
  // and needs no wallet, so a session that drops mid-fill must not swap the
  // way back in for "Connect wallet".
  //
  // An amount over the balance has exactly one next step, so the CTA names it
  // and performs it rather than stating the problem on a dead button -- but only
  // when there is a balance to fill. An unread balance is not an empty one, and
  // "Use max (0 USDC)" would erase the typed amount; both keep a dead CTA that
  // says which case it is.
  const useMaxCta: SwapCta | null =
    currentBalance !== null && currentBalance > 0n
      ? {
          label: `Use max (${presetAmountText(currentBalance, fromToken.decimals)} ${fromToken.symbol})`,
          action: "useMax",
        }
      : null;
  const ctaChoice: string | SwapCta = flowReopenable
    ? "View order progress"
    : !isConnected
      ? intent.quote?.preview && intent.quote.canSolve
        ? "Connect wallet to continue"
        : UI.CONNECT_WALLET
      : intent.isLoading
        ? getStatusLabel(intent.status)
        : routeCheck.status === "unsupported"
          ? "Route not supported"
          : orderOutOfBounds
            ? "Adjust amount"
            : settlementFix !== null
              ? settlementFix === "setup" && needsChainSwitch
                ? `Switch to ${EXTENDED_CHAIN_NAMES[fromChainId]}`
                : SETTLEMENT_FIX_BUTTON[settlementFix]
              : recipientMissing
                ? destination.recipientTag !== undefined
                  ? "Add a zk.money tag"
                  : "Add recipient address"
                : recipientInvalid
                  ? destination.recipientTag !== undefined
                    ? "Check the tag"
                    : "Check recipient address"
                  : !amount || amountBigInt === 0n
                    ? "Enter amount"
                    : insufficientBalance
                      ? (useMaxCta ??
                        (currentBalance === null ? "Balance not loaded" : "Insufficient balance"))
                      : excessiveSlippage
                        ? "Amount too small"
                        : needsChainSwitch
                          ? `Switch to ${EXTENDED_CHAIN_NAMES[fromChainId]}`
                          : intent.canAllocateDepositRoute
                            ? intent.error
                              ? "Try reserving route again"
                              : "Review & reserve route"
                            : intent.error
                              ? "Quote failed"
                              : intent.canSign
                                ? quoteStale
                                  ? "Updating quote..."
                                  : `Swap ${fromToken.symbol} ${GLYPH.flow} ${toToken.symbol}`
                                : "Getting quote...";
  const cta: SwapCta =
    typeof ctaChoice === "string" ? { label: ctaChoice, action: "submit" } : ctaChoice;

  return {
    handleMarketSubmit,
    cta,
    quoteStale,
    handleConfirmSwap,
    handleCancelSign,
    handleCloseFlow,
    handleStartOver,
    flowReopenable,
    // What the flow modal renders: the dispatched order's own destination
    // while one is in flight (bound at confirm, or restored from the record on
    // a resume), the live form's otherwise. Never the live toggle for an
    // executed order (see executedDestination above).
    flowDestination: executedDestination ?? resumedDestination ?? quotedDestination,
    executionStartTime,
    resumedDeposit,
    needsChainSwitch,
  };
}
