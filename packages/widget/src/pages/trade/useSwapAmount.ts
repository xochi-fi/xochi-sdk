/**
 * useSwapAmount
 *
 * The amount half of the swap panel's view-model: what the user is paying,
 * what the wallet actually holds, what the quote says arrives, and every bound
 * that can refuse the size (balance, the solver's stable USD minimum, the price
 * impact ceiling, the served minimum). Split out of the 1666-line
 * `useSwapPanel` closure (DEBT-014 step 3) and constructed after the route and
 * settlement groups, because every figure here is denominated in their legs and
 * read off their quote.
 *
 * Owns the pay amount, the wrap-modal flag, the balance readers and the price
 * feed. It also holds the input-driven re-quote, which is the one effect that
 * turns an edited amount into a request.
 *
 * Deliberately does NOT own the legs, the quote (`useIntent`) or the CTA
 * verdict: the button text weighs these bounds against wallet and flow state,
 * so it belongs to the flow group downstream. `setAmount` is exported for the
 * two writers outside this group -- a leg change clears it, and a restored
 * order (retry prefill, resumed swap) fills it.
 */

import { useState, useMemo, useEffect, type Dispatch, type SetStateAction } from "react";
import { formatEther } from "viem";
import { useToast } from "../../components/Toast.js";
import { usePrices } from "../../hooks/usePrices.js";
import { usePublicBalances } from "../../hooks/usePublicBalances.js";
import {
  useRecipientBalance,
  type UseRecipientBalanceReturn,
} from "../../hooks/useRecipientBalance.js";
import type { UseIntentReturn } from "../../hooks/useIntent.js";
import {
  formatTokenAmount,
  parseTokenAmount,
  payoutDisplayDecimals,
  payoutFieldDecimals,
} from "../../utils/format.js";
import { type Token, isChainId } from "../../types/intent.js";
import { UI } from "../../constants.js";
import { MAX_PRICE_IMPACT_PERCENT, type SelectableChainId } from "@xochi/client";
import { WETH_ADDRESSES } from "@xochi/client";
import type { SolverCapabilities } from "@xochi/signer";
import { orderBounds } from "@xochi/client";
import type { ResumedSwap } from "./resumeSwap.js";
import { selectPayoutSource } from "./resumeSwap.js";
import { calculatePriceImpact } from "../../lib/priceImpact.js";
import { isAmountTooSmall } from "../../lib/errorCategory.js";
import { amountTooSmallGuidance, type AmountTooSmallGuidance } from "../../lib/declineGuidance.js";
import { showsWalletDestinationBalance } from "../../lib/balances.js";
import { minimumOrderNotice } from "./orderMinimum.js";

// Show the wrap nudge only when native ETH is worth wrapping (above gas dust).
const WRAP_NUDGE_MIN_WEI = 2_000_000_000_000_000n; // 0.002 ETH

export interface UseSwapAmountParams {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
  capabilities: SolverCapabilities;
  /**
   * The route is refused, or not yet confirmed by the live matrix: no point
   * requesting a quote the solver drops (see `RouteCheck`).
   */
  routeBlocked: boolean;
  isNonEvmDest: boolean;
  intent: UseIntentReturn;
  /** A restored swap carries the only payout figure it will ever have. */
  resumed: ResumedSwap | null;
  /** Recipient of the payout, for the destination-side balance lookup. */
  payoutAddress: string | undefined;
  /** A required-but-unusable recipient also suppresses the re-quote. */
  recipientInvalid: boolean;
  isConnected: boolean;
  /** The wallet's actual chain; undefined or unconfigured balances remain unknown. */
  connectedChainId: number | undefined;
  /** Confirm modal open: the input is frozen, so skip the input-driven quote. */
  flowOpen: boolean;
  /** The pay amount the panel opens on, read once at mount (frame URL parameter). */
  initialAmount?: string;
  /**
   * The host locked the amount (`lock=amount`): the user cannot type, max or
   * bump it. Restores (`setAmount`) still write it.
   */
  amountLocked?: boolean;
}

export interface UseSwapAmountResult {
  amount: string;
  handleAmountChange: (raw: string) => void;
  handlePreset: (percent: number) => void;
  amountBigInt: bigint;
  /** Origin balance, or null when it is not known (non-EVM origin, read pending or failed). */
  currentBalance: bigint | null;
  destinationBalance: bigint | null;
  recipientBalance: UseRecipientBalanceReturn;
  nativeEthDisplay: string;
  showWrapNudge: boolean;
  showWrap: boolean;
  setShowWrap: Dispatch<SetStateAction<boolean>>;
  outputAmount: string;
  /** The same payout for the narrow receive field (payoutFieldDecimals). */
  payoutField: string;
  insufficientBalance: boolean;
  orderOutOfBounds: boolean;
  orderBoundsNotice: string | null;
  excessiveSlippage: boolean;
  amountGuidance: AmountTooSmallGuidance | null;
  handleIncreaseToMinimum: () => void;
  /** Write the pay amount from outside this group (leg change, order restore). */
  setAmount: Dispatch<SetStateAction<string>>;
}

/**
 * The text a balance preset writes into the pay field. Anything that names the
 * amount a preset will fill (the "Use max (...)" CTA) formats it here too, so the
 * label and the filled value are one string.
 */
export const presetAmountText = (amount: bigint, decimals: number): string =>
  formatTokenAmount(amount, decimals, 6);

export function useSwapAmount({
  fromChainId,
  toChainId,
  fromToken,
  toToken,
  capabilities,
  routeBlocked,
  isNonEvmDest,
  intent,
  resumed,
  payoutAddress,
  recipientInvalid,
  isConnected,
  connectedChainId,
  flowOpen,
  initialAmount = "",
  amountLocked = false,
}: UseSwapAmountParams): UseSwapAmountResult {
  const { showToast } = useToast();
  const { estimateUsd, prices, livePrices } = usePrices();
  const { readBalanceOf } = usePublicBalances();

  const [amount, setAmount] = useState(initialAmount);
  const [showWrap, setShowWrap] = useState(false);

  const amountBigInt = useMemo(() => {
    try {
      if (!amount || amount === "0") return 0n;
      return parseTokenAmount(amount, fromToken.decimals);
    } catch {
      return 0n;
    }
  }, [amount, fromToken.decimals]);

  // The client may guide on the solver's stable minimum, but it never enforces
  // a maximum. Destination inventory changes as quotes reserve float and top-ups
  // land, so only the quote-time solver inventory gate can state the current cap.
  const minimumOrderUsd = orderBounds(capabilities).min;
  const orderBoundsNotice = useMemo(() => {
    if (amountBigInt === 0n) return null;
    return minimumOrderNotice(estimateUsd(amount, fromToken.symbol) ?? 0, minimumOrderUsd);
  }, [amount, amountBigInt, fromToken.symbol, minimumOrderUsd, estimateUsd]);
  const orderOutOfBounds = orderBoundsNotice !== null;

  // All-in cost of the returned quote vs the live market rate (fees + fixed
  // network minimum + slippage). Used to protect the user from executing a trade
  // that loses most of its value -- typically a dust order the fixed network
  // minimum eats. A client-side estimate against gross output that needs a
  // price feed, unlike the server's `cost_bps`, which is measured against input.
  // Live prints only (xochi#568): a fallback or stale price is not a market rate,
  // so off one the guard reads no impact rather than refusing on a fake gap.
  //
  // Paired with the amount the HELD quote was requested at, never the live
  // field: mid-edit the live amount belongs to the next quote, and pairing it
  // with this one's output grades a fill nobody is about to sign.
  const fromLivePrice = livePrices[fromToken.symbol]?.price;
  const toLivePrice = livePrices[toToken.symbol]?.price;
  const priceImpactPct = useMemo(() => {
    if (!intent.quote?.toAmount || amountBigInt === 0n) return 0;
    return calculatePriceImpact(
      intent.quotedFromAmount ?? amountBigInt.toString(),
      intent.quote.toAmount,
      fromToken.decimals,
      toToken.decimals,
      fromLivePrice,
      toLivePrice,
    );
  }, [
    intent.quote?.toAmount,
    intent.quotedFromAmount,
    amountBigInt,
    fromToken.decimals,
    toToken.decimals,
    fromLivePrice,
    toLivePrice,
  ]);
  // Hard stop: never let the user sign a fill worse than the protection ceiling.
  const excessiveSlippage = intent.quote != null && priceImpactPct > MAX_PRICE_IMPACT_PERCENT;

  // Quotes work even when disconnected (read-only exploration). Skip routes the
  // solver structurally cannot fill and amounts below its stable minimum. A maximum
  // is quote-time inventory state and must always round-trip to the solver.
  useEffect(() => {
    // Under an open confirm modal the amount is not editable, so skip the
    // input-driven re-quote. The refresh timer keeps the quote live in SILENT mode
    // (see `paused: flowOpen` above) -- this guard just avoids a redundant
    // full re-quote here.
    if (flowOpen) return;
    if (amountBigInt > 0n && !routeBlocked && !orderOutOfBounds && !recipientInvalid) {
      intent.requestQuote(amountBigInt.toString());
    }
  }, [
    amountBigInt,
    routeBlocked,
    orderOutOfBounds,
    recipientInvalid,
    intent.requestQuote,
    flowOpen,
  ]);

  // On-chain balances are EVM-only. A non-EVM (Tron) origin has no readable EVM
  // balance here -- the user sends the deposit from an external Tron wallet -- so
  // it is null, never a 0 the user could read as an empty wallet, and a non-EVM
  // id never reaches the EVM balance reader. A pending or failed read is null
  // for the same reason.
  const currentBalance = useMemo(
    () => (isChainId(fromChainId) ? readBalanceOf(fromChainId, fromToken.address) : null),
    [readBalanceOf, fromChainId, fromToken.address],
  );

  /**
   * What the connected wallet already holds of the DESTINATION token on the
   * destination chain, or null when that is not a thing we can state.
   *
   * Read from the same `usePublicBalances` source as the origin above, and
   * deliberately not from `useRecipientBalance` (which the recipient field uses).
   * Two reasons. It is already fetched: that hook reads every enabled public
   * asset in isolated per-chain queries, so the destination leg costs no extra
   * request and refreshes on the same interval. The two sides of the panel agree
   * rather than drift by a poll. And it is the user's OWN wallet, already read
   * client-side for every chain, so it raises none of the correlation concern
   * that put the recipient lookup behind the worker.
   *
   * Null, not 0n, when the payout does not go to the connected wallet:
   *
   *  - a non-EVM destination pays a typed address, and that address's balance is
   *    a different fact, already stated under the recipient field in its own
   *    words ("This address holds ..."). Showing it in the header where the
   *    origin says YOUR balance would attribute a stranger's holdings to the
   *    user.
   *  - a disconnected wallet has no balance to report.
   *
   * The distinction matters because 0n renders as a confident "0.00 USDC" and
   * null renders as "--". A wallet we did not read is not a wallet we read as
   * empty.
   */
  const destinationBalance = useMemo(
    () =>
      showsWalletDestinationBalance(isConnected, isNonEvmDest, toChainId)
        ? readBalanceOf(toChainId, toToken.address)
        : null,
    [isConnected, isNonEvmDest, readBalanceOf, toChainId, toToken.address],
  );

  // Guard: never submit more than the origin balance. Balances are EVM-only; on a
  // non-EVM deposit origin (Tron) the user pays from an external wallet, so the
  // guard stays off. On an EVM origin an unread balance still blocks: submit is
  // allowed only against a balance we have seen (the CTA says which case it is).
  const insufficientBalance =
    isConnected &&
    isChainId(fromChainId) &&
    amountBigInt > 0n &&
    amountBigInt > (currentBalance ?? 0n);

  // Contextual wrap nudge: when the user is paying with WETH but holds native
  // ETH on the connected chain, explain why Xochi needs WETH and offer a wrap
  // shortcut. Native ETH can't be gaslessly pulled (no permit), so the protocol
  // moves WETH; most people don't know that until they hit it.
  const nativeEthBalance = useMemo(
    () =>
      isConnected && connectedChainId !== undefined
        ? readBalanceOf(connectedChainId, "native")
        : null,
    [isConnected, readBalanceOf, connectedChainId],
  );
  const wethOnConnectedChain = isChainId(connectedChainId) && !!WETH_ADDRESSES[connectedChainId];
  const showWrapNudge =
    isConnected &&
    fromToken.symbol === "WETH" &&
    wethOnConnectedChain &&
    nativeEthBalance !== null &&
    nativeEthBalance > WRAP_NUDGE_MIN_WEI;
  const nativeEthDisplay = useMemo(
    () =>
      nativeEthBalance === null
        ? "--"
        : parseFloat(parseFloat(formatEther(nativeEthBalance)).toFixed(4)).toString(),
    [nativeEthBalance],
  );

  const handlePreset = (percent: number): void => {
    if (amountLocked) return;
    if (!isConnected) {
      showToast(UI.CONNECT_PROMPT, "error");
      return;
    }
    if (currentBalance === null) {
      showToast(`The ${fromToken.symbol} balance hasn't loaded`, "error");
      return;
    }
    const maxAmount = (currentBalance * BigInt(percent)) / 100n;
    setAmount(presetAmountText(maxAmount, fromToken.decimals));
  };

  // Reject sign characters outright: a trade amount is never negative, so a
  // stray "-" (typed or pasted) is stripped before it reaches state rather than
  // relying on the downstream `amountBigInt > 0n` guard to swallow it.
  const handleAmountChange = (raw: string): void => {
    if (amountLocked) return;
    setAmount(raw.replace(/[-+]/g, ""));
  };

  const recipientBalance = useRecipientBalance(toChainId, toToken.address, payoutAddress);

  // An unsolvable quote has NO payout, which is different from a payout of zero.
  // `mapQuoteResponse` defaults an absent `to_amount` to "0" to keep the domain
  // type non-optional, so reading it directly renders a fabricated "Receive
  // 0" next to the decline notice. Gate on `canSolve` and show nothing instead:
  // we were not quoted zero, we were not quoted at all.
  //
  // A RESUMED swap is the one case with a real payout and no quote to read it
  // from: the record captured the served `to_amount` at submit time.
  //
  // Two conditions guard that fallback, and both are load-bearing. It is reached
  // only when there is NO quote object -- not an `||` chain over `canSolve`, or a
  // later DECLINED quote (canSolve false, no payout) would render the resumed
  // payout beside the decline notice, reintroducing what #389 removed. And it
  // applies only while the resumed intent is still the one on screen, so the
  // figure cannot survive a reset and reappear against a pair that was never
  // quoted (which is the same fabricated-payout class by a different route).
  const { outputAmount, payoutField } = useMemo(() => {
    const raw = selectPayoutSource(intent.quote, resumed, intent.intentId);
    if (!raw) return { outputAmount: "", payoutField: "" };
    try {
      const payout = BigInt(raw);
      return {
        outputAmount: formatTokenAmount(
          payout,
          toToken.decimals,
          payoutDisplayDecimals(payout, toToken.decimals),
        ),
        payoutField: formatTokenAmount(
          payout,
          toToken.decimals,
          payoutFieldDecimals(payout, toToken.decimals),
        ),
      };
    } catch {
      return { outputAmount: "", payoutField: "" };
    }
  }, [intent.quote, resumed, intent.intentId, toToken.decimals]);

  // Below-the-minimum decline guidance (Phase 3, R7). Built from the served
  // machine key and figures on the declined quote itself, so it can never
  // appear beside a different error, and the CTA number is always the one the
  // server just recommended. The render gate is two-track: the categorizer
  // verdict the other notices use (isAmountTooSmall), OR "the error on screen
  // is this quote's own decline prose" -- the decline path stores quote.error
  // in intent.error verbatim, so identity keys the gate to the machine
  // category checked inside amountTooSmallGuidance even when the solver
  // rewords the sentence out of the classifier's vocabulary. Either track
  // still stops a stale declined quote from resurrecting the block under a
  // new error: a newer error no longer matches the held quote's prose.
  const amountGuidance = useMemo(() => {
    const message =
      typeof intent.error === "string" ? intent.error : (intent.error?.message ?? null);
    const isQuoteOwnDecline = message !== null && message === intent.quote?.error;
    return isAmountTooSmall(intent.error) || isQuoteOwnDecline
      ? amountTooSmallGuidance({
          quote: intent.quote,
          fromSymbol: fromToken.symbol,
          fromPriceUsd: prices[fromToken.symbol],
        })
      : null;
  }, [intent.error, intent.quote, fromToken.symbol, prices]);

  // One tap onto the served minimum: fills the pay field through the ordinary
  // input path, so the debounced re-quote and every validation run exactly as
  // if the user had typed it.
  const handleIncreaseToMinimum = (): void => {
    if (amountGuidance?.prefillAmount) handleAmountChange(amountGuidance.prefillAmount);
  };

  return {
    amount,
    handleAmountChange,
    handlePreset,
    amountBigInt,
    currentBalance,
    destinationBalance,
    recipientBalance,
    nativeEthDisplay,
    showWrapNudge,
    showWrap,
    setShowWrap,
    outputAmount,
    payoutField,
    insufficientBalance,
    orderOutOfBounds,
    orderBoundsNotice,
    excessiveSlippage,
    amountGuidance,
    handleIncreaseToMinimum,
    setAmount,
  };
}
