/**
 * useSwapPanel
 *
 * View-model hook for SwapPanel: one flat object the (thin) SwapPanel component
 * renders, so the component is JSX-only and this side is logic-only.
 *
 * As of DEBT-014 step 3 this file is a COMPOSITION, not the logic. The 1666-line
 * single closure it used to be held twenty `useState`s in one scope, which meant
 * any reader had to hold all of them to change one. It is now four focused hooks
 * called in strict dependency order, each taking the previous ones' outputs as
 * explicit arguments:
 *
 *   useSwapRoute         chains, tokens, direction, route viability
 *   useSettlementGating  settlement mode, privacy gating, addresses, the quote
 *   useSwapAmount        amount entry, balances, payout, bounds
 *   useSwapFlow          submission, the flow modal, resume, the CTA
 *
 * The public view-model stays flat: flow actions are forwarded explicitly so
 * SwapPanel remains JSX-only and never reaches into a child hook.
 *
 * What stays here is what genuinely belongs to no single group: the wallet
 * facts, the trust score, the two disclosure toggles, the slippage setting, and
 * the two cells more than one group reads (`flowOpen`, `resumed` -- see below).
 * Plus the cross-group wiring: the four `on*` transitions a leg change owes the
 * groups downstream of the route, and the one effect whose trigger and whose
 * target sit in different groups.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTrustScore } from "../../hooks/useTrustScore.js";
import { formatTokenAmount } from "../../utils/format.js";
import { DEFAULT_SLIPPAGE_BPS, getTokenInfoForChain } from "@xochi/client";
import type { ResumedSwap } from "./resumeSwap.js";
import type { SettlementType } from "../../types/index.js";
import { useSwapRoute } from "./useSwapRoute.js";
import { useSettlementGating } from "./useSettlementGating.js";
import { useSwapAmount } from "./useSwapAmount.js";
import { useSwapFlow, type SwapPrefill } from "./useSwapFlow.js";
import { useEmbedDefaults } from "./useEmbedDefaults.js";
import {
  policyHolds,
  sameEmbedDefaults,
  type EmbedDefaults,
  type EmbedPolicy,
} from "./embedParams.js";

export type { SwapPrefill } from "./useSwapFlow.js";

export function useSwapPanel(
  prefill: SwapPrefill | null | undefined,
  /** Fired once when a stealth swap settles, so the receive panel can auto-scan. */
  onStealthSettled?: () => void,
) {
  // The wallet's ACTUAL chain, from the connection. Not `useChainId()`: wagmi
  // does not sync a connector chain it has no config for, so on an unlisted
  // network (Metatarz's 31337) that keeps the last configured chain and the
  // wrong-chain gate below would pass (xochi#539). Undefined = no connection.
  const { isConnected, address, chainId: connectedChainId } = useAccount();
  const { openConnectModal } = useConnectModal();

  // Effective score (0 while trust economics is off). It drives the tier ladder,
  // the quote's fallback fee anatomy and the tier persisted with each swap.
  const { trustScore } = useTrustScore();

  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [showSettings, setShowSettings] = useState(false);
  const [showExplainer, setShowExplainer] = useState(false);

  // Read by three groups, so it is held here rather than by the flow group that
  // opens and closes it: it pauses the quote refresh (`paused` in the settlement
  // hook, which owns useIntent), it suppresses the input-driven re-quote in the
  // amount hook, and it gates the resume effect in the flow hook.
  const [flowOpen, setFlowOpen] = useState(false);

  // The RESUMED swap, if any: its intent id and the payout its record captured
  // at submit time. A resumed intent carries no quote (the served one is gone and
  // is never synthesized), so this is the only source for the modal's "you
  // receive" line. Null for any ordinary swap, where the live quote answers.
  //
  // Keyed BY INTENT ID, not held as a bare amount. A bare amount outlives the
  // swap it belongs to: it was cleared in exactly one place (the terminal branch
  // of handleCloseFlow), every resumable status is non-terminal, and the payout
  // fallback fires whenever there is no quote -- which is the state after any
  // reset. So a stale figure rendered as a live "You receive" beside a pair that
  // was never quoted, and got reformatted with a new token's decimals on a leg
  // change. Pairing it with the id means it stops applying the moment the intent
  // does, with no cleanup call to forget. See xochi#339 and #389.
  //
  const [resumed, setResumed] = useState<ResumedSwap | null>(null);

  // Opening route and mode resolve against capabilities; explicit URL choices
  // remain distinct from automatic privacy defaults.
  const embed = useEmbedDefaults();

  // The host's locks and allow-lists (xochi-widget#39), from the same resolved
  // parameters: the seed until the matrix first answers, then that settled
  // answer, pinned (set by the one-shot settle effect below) so a later matrix
  // change cannot move a lock mid-session.
  const [pinnedSettled, setPinnedSettled] = useState<EmbedDefaults | null>(null);
  const opened = pinnedSettled ?? embed.seed;
  const policy: EmbedPolicy = opened;
  const amountLocked = policy.locks.includes("amount");

  // A Retry from Activity restores a past order wholesale. One that a lock or
  // an allow-list would refuse is not applied: the panel starts over as the host
  // set it (below). A locked amount refuses every retry, since a retry restores
  // its amount. A refused Retry is discarded for good: its nonce is remembered,
  // so the policy settling later (seed to matrix answer) cannot admit it then.
  const refusedNonce = useRef<number | null>(null);
  const admittedPrefill = useMemo(() => {
    if (!prefill) return prefill;
    if (refusedNonce.current === prefill.nonce) return null;
    const fromToken = getTokenInfoForChain(prefill.fromToken, prefill.fromChainId);
    const toToken = getTokenInfoForChain(prefill.toToken, prefill.toChainId);
    if (!fromToken || !toToken) {
      refusedNonce.current = prefill.nonce;
      return null;
    }
    const legs = {
      fromChainId: prefill.fromChainId,
      toChainId: prefill.toChainId,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol,
    };
    if (policyHolds(opened, legs, null)) return prefill;
    refusedNonce.current = prefill.nonce;
    return null;
  }, [prefill, opened]);
  const routeEdited = useRef(false);

  // The route group is constructed FIRST -- every other group is denominated in
  // its legs -- but a leg change invalidates state those later groups own. Each
  // callback below is that debt, paid explicitly. They run from event handlers,
  // never during render, so the consts they close over are initialized by the
  // time they are called.
  const route = useSwapRoute({
    initial: embed.seed,
    policy,
    onOriginChange: () => {
      routeEdited.current = true;
      amounts.setAmount("");
      gating.intent.reset();
    },
    onDestinationChainChange: () => {
      routeEdited.current = true;
      gating.clearRecipient();
      gating.intent.reset();
    },
    onDestinationTokenChange: () => {
      routeEdited.current = true;
      gating.intent.reset();
    },
    onFlip: (nextFromToken) => {
      routeEdited.current = true;
      // Flip the quote instead of clearing it. With a live quote the output
      // becomes the new input ("5 ETH -> 9012 USDC" flips to "9012 USDC -> ~5 ETH");
      // toToken's decimals are correct because it becomes the new fromToken. With
      // no quote yet, keep whatever the user typed so a flip never erases input.
      const carriedAmount =
        gating.intent.quote?.toAmount != null && gating.intent.quote.toAmount !== "0"
          ? formatTokenAmount(BigInt(gating.intent.quote.toAmount), nextFromToken.decimals, 6)
          : amounts.amount;
      amounts.setAmount(carriedAmount);
      // Both leg-scoped inputs go, for the same reason. The recipient belongs to
      // the old destination; the refund address belongs to the old ORIGIN and is
      // origin-chain-VM-shaped (base58 on Tron, hex on EVM), so after a flip that
      // crosses VMs it is not merely stale, it is unspendable. Leaving it made the
      // panel fail its own `refundAddressError` check on a value the user never
      // typed for this route.
      gating.clearRecipient();
      gating.clearRefund();
      gating.intent.reset();
    },
  });

  const gating = useSettlementGating({
    fromChainId: route.fromChainId,
    toChainId: route.toChainId,
    fromTokenAddress: route.fromToken.address,
    toTokenAddress: route.toToken.address,
    capabilities: route.capabilities,
    routePrivacyModes: route.selectedPrivacyModes,
    stealthDestinationChainIds: route.stealthDestinationChainIds,
    capabilityState: route.capabilityState,
    capabilitiesFetching: route.capabilitiesFetching,
    isNonEvmDest: route.isNonEvmDest,
    isNonEvmOrigin: route.isNonEvmOrigin,
    zkMoneyDestination: route.zkMoneyDestination,
    isConnected,
    address,
    trustScore,
    slippageBps,
    flowOpen,
    onStealthSettled,
    initialSettlement: embed.settlementPreference,
    openingSettled: pinnedSettled !== null,
    codes: embed.codes,
  });

  const destinationPickerMode: "public" | "stealth" =
    gating.settlement === "stealth" ? "stealth" : "public";
  const stealthDestinations = route.liveStealthDestinations;
  const stealthDestinationGuidance =
    destinationPickerMode === "stealth"
      ? {
          status: stealthDestinations.status,
          chainIds: stealthDestinations.chainIds,
          selectedPairSupported: stealthDestinations.selectedPairSupported,
        }
      : null;
  const destinationHandlers = useRef({
    mode: destinationPickerMode,
    chainChange: route.handleToChainChange,
    tokenChange: route.handleToTokenChange,
  });
  destinationHandlers.current = {
    mode: destinationPickerMode,
    chainChange:
      destinationPickerMode === "stealth"
        ? stealthDestinations.handleChainChange
        : route.handleToChainChange,
    tokenChange:
      destinationPickerMode === "stealth"
        ? stealthDestinations.handleTokenChange
        : route.handleToTokenChange,
  };
  const handleToChainChange: typeof route.handleToChainChange = (chainId) => {
    const current = destinationHandlers.current;
    if (current.mode === destinationPickerMode) current.chainChange(chainId);
  };
  const handleToTokenChange: typeof route.handleToTokenChange = (token) => {
    const current = destinationHandlers.current;
    if (current.mode === destinationPickerMode) current.tokenChange(token);
  };
  const originHandlers = useRef({
    mode: destinationPickerMode,
    chainChange: route.handleFromChainChange,
    tokenChange: route.handleFromTokenChange,
  });
  originHandlers.current = {
    mode: destinationPickerMode,
    chainChange:
      destinationPickerMode === "stealth"
        ? route.stealthOrigins.handleChainChange
        : route.handleFromChainChange,
    tokenChange:
      destinationPickerMode === "stealth"
        ? route.stealthOrigins.handleTokenChange
        : route.handleFromTokenChange,
  };
  const handleFromChainChange: typeof route.handleFromChainChange = (chainId) => {
    const current = originHandlers.current;
    if (current.mode === destinationPickerMode) current.chainChange(chainId);
  };
  const handleFromTokenChange: typeof route.handleFromTokenChange = (token) => {
    const current = originHandlers.current;
    if (current.mode === destinationPickerMode) current.tokenChange(token);
  };

  const amounts = useSwapAmount({
    fromChainId: route.fromChainId,
    toChainId: route.toChainId,
    fromToken: route.fromToken,
    toToken: route.toToken,
    capabilities: route.capabilities,
    routeBlocked: route.routeBlocked,
    isNonEvmDest: route.isNonEvmDest,
    intent: gating.intent,
    resumed,
    payoutAddress: gating.payoutAddress,
    recipientInvalid: gating.recipientInvalid,
    isConnected,
    connectedChainId,
    flowOpen,
    initialAmount: embed.seed.amount,
    amountLocked,
  });

  const flow = useSwapFlow({
    prefill: admittedPrefill,
    intent: gating.intent,
    isConnected,
    address,
    connectedChainId,
    fromChainId: route.fromChainId,
    toChainId: route.toChainId,
    fromToken: route.fromToken,
    toToken: route.toToken,
    routeCheck: route.routeCheck,
    applyRoute: route.applyRoute,
    amount: amounts.amount,
    amountBigInt: amounts.amountBigInt,
    insufficientBalance: amounts.insufficientBalance,
    currentBalance: amounts.currentBalance,
    excessiveSlippage: amounts.excessiveSlippage,
    orderOutOfBounds: amounts.orderOutOfBounds,
    setAmount: amounts.setAmount,
    settlement: gating.settlement,
    settlementFix: gating.settlementFix,
    destination: gating.destination,
    recipientMissing: gating.recipientMissing,
    recipientInvalid: gating.recipientInvalid,
    restoreSettlement: gating.restoreSettlement,
    clearRecipient: gating.clearRecipient,
    restoreRecipientTag: gating.setRecipientTag,
    restoreRefundAddress: gating.setRefundAddress,
    flowOpen,
    setFlowOpen,
    resumed,
    setResumed,
  });

  // Leaving the tag rail is navigation, not permission to repair either leg.
  const handleSettlementChange = (next: SettlementType): void => {
    if (route.zkMoneyDestination && next !== "shielded") {
      route.leaveZkMoneyDestination();
    }
    gating.handleSettlementChange(next);
  };

  const handleZkMoneySelect = (): void => {
    if (!route.zkMoneyOffered || route.zkMoneyDestination) return;
    route.selectZkMoneyDestination();
    gating.dismissSettlementNotice();
  };

  // Put the shielded line down once the user moves on. Its condition never
  // resolves on its own (the rail is not shipped, so unlike the stealth
  // destination nudge there is no state that answers it), so without this the
  // caption keeps describing an unselected mode for the rest of the session:
  // it would still be sitting over the amount field at signing time, in a live
  // region, on a trade that is settling publicly. Editing the trade is the
  // signal that the tap has been answered.
  //
  // Wired here rather than inside either hook because it crosses them: the edit
  // it watches for is the route's legs and the amount group's amount, and the
  // line it puts down belongs to the settlement group.
  useEffect(() => {
    gating.dismissShieldedNotice();
  }, [
    route.fromChainId,
    route.toChainId,
    route.fromToken.address,
    route.toToken.address,
    amounts.amount,
    gating.dismissShieldedNotice,
  ]);

  // Re-check the frame URL parameters once the capability matrix has answered.
  // The panel opened on `seed`, resolved before the matrix arrived; the live
  // matrix can refuse a pair the fallback could not judge, or offer a chain the
  // fallback lacks. Applied once, and only over an untouched panel: anything
  // the user has already changed is theirs, and a resumed swap has already
  // replaced the seed.
  //
  // Apply route/amount independently of privacy: automatic mode promotion is
  // not a user edit, and hydration never replaces a chosen privacy mode.
  const embedSettled = useRef(false);
  useEffect(() => {
    const { seed, settled } = embed;
    if (embedSettled.current || settled === null) return;
    embedSettled.current = true;
    setPinnedSettled(settled);
    if (routeEdited.current || admittedPrefill || flow.executionStartTime !== null) return;
    if (sameEmbedDefaults(settled, seed)) return;
    const untouched = sameEmbedDefaults(
      {
        fromChainId: route.fromChainId,
        toChainId: route.toChainId,
        fromToken: route.fromToken,
        toToken: route.toToken,
        amount: amounts.amount,
        settlement: seed.settlement,
      },
      seed,
    );
    if (!untouched) return;
    gating.intent.reset();
    route.applyRoute(settled);
    amounts.setAmount(settled.amount);
    // Keyed on the matrix answering (`embed.settled`); the guard above makes it
    // one-shot, and the panel values are read only to see whether it is untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embed.settled]);

  // Hold the host's locks and allow-lists (xochi-widget#39). The handlers
  // refuse every change that would break them, but the restore paths do not
  // filter: a resumed swap shows its own order, and the matrix settling moves
  // what the frame opened on. So once the panel is at rest again (no flow open
  // or being resumed, no swap under way), a locked field that differs from what
  // the frame opened on, or a route outside the lists, restores the frame's
  // opening state wholesale, as a Retry prefill restores its own: legs, amount
  // and mode, and the leg-scoped inputs cleared. At most once per drift, so a
  // route the panel cannot take as-is never loops.
  const heldDrift = useRef<string | null>(null);
  const atRest =
    !flowOpen &&
    // A resume restores the legs first and opens its flow only once its
    // deposit binding is proven; the start time it sets marks that window.
    flow.executionStartTime === null &&
    (gating.intent.status === "idle" ||
      gating.intent.status === "quoting" ||
      gating.intent.status === "quoted");
  useEffect(() => {
    if (!atRest) return;
    const current = {
      fromChainId: route.fromChainId,
      toChainId: route.toChainId,
      fromSymbol: route.fromToken.symbol,
      toSymbol: route.toToken.symbol,
    };
    if (policyHolds(opened, current, amounts.amount)) {
      heldDrift.current = null;
      return;
    }
    const drift = JSON.stringify([current, amounts.amount]);
    if (heldDrift.current === drift) return;
    heldDrift.current = drift;
    gating.intent.reset();
    gating.clearRecipient();
    gating.clearRefund();
    route.applyRoute(opened);
    amounts.setAmount(opened.amount);
    // The route and amount are what it compares; the setters are stable and
    // the gating group is read only to reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    opened,
    atRest,
    route.fromChainId,
    route.toChainId,
    route.fromToken.symbol,
    route.toToken.symbol,
    amounts.amount,
  ]);

  // A re-quote from the flow or an error (Try again / New quote) prices the
  // panel's current route. A resumed swap can have put one there that the
  // host's policy refuses, and the hold waits for rest, so that retry starts
  // over instead: the flow closes, the intent resets, and the hold restores the
  // frame's own route before anything is priced.
  const retryQuote = (): void => {
    const legs = {
      fromChainId: route.fromChainId,
      toChainId: route.toChainId,
      fromSymbol: route.fromToken.symbol,
      toSymbol: route.toToken.symbol,
    };
    if (!policyHolds(opened, legs, amounts.amount)) flow.handleStartOver();
    else gating.intent.refreshQuote();
  };

  // A Retry the host's policy refused starts over, as `retryQuote` does for a
  // refused route: the flow closes, the intent resets, and the hold restores the
  // frame's own route. Once per refused click (nonce).
  const startedOverNonce = useRef<number | null>(null);
  const refusedRetry = prefill && admittedPrefill === null ? prefill.nonce : null;
  useEffect(() => {
    if (refusedRetry === null || startedOverNonce.current === refusedRetry) return;
    startedOverNonce.current = refusedRetry;
    flow.handleStartOver();
    // Keyed on the refused nonce; the start-over handler is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusedRetry]);

  return {
    settlement: gating.settlement,
    handleSettlementChange,
    setupStealth: gating.setupStealth,
    stealthSetupLoading: gating.stealthSetupLoading,
    stealthSetupError: gating.stealthSetupError,
    shieldedClickable: gating.shieldedClickable,
    shieldedPreLive: gating.shieldedPreLive,
    notice: gating.notice,
    shieldedRefusalReason: gating.shieldedRefusalReason,
    shieldedRouteAvailable: gating.shieldedRouteAvailable,
    stealthSelectable: gating.stealthSelectable,
    stealthClickable: gating.stealthClickable,
    stealthFix: gating.stealthFix,
    shieldedFix: gating.shieldedFix,
    settlementFix: gating.settlementFix,
    stealthChains: gating.stealthChains,
    stealthDestinationSupported: gating.stealthDestinationSupported,
    stealthRouteAvailable: gating.stealthRouteAvailable,
    stealthRefusalReason: gating.stealthRefusalReason,
    showSettings,
    setShowSettings,
    slippageBps,
    setSlippageBps,
    trustScore,
    intent: gating.intent,
    fromToken: route.fromToken,
    toToken: route.toToken,
    fromChainId: route.fromChainId,
    toChainId: route.toChainId,
    amount: amounts.amount,
    handleAmountChange: amounts.handleAmountChange,
    handlePreset: amounts.handlePreset,
    currentBalance: amounts.currentBalance,
    destinationBalance: amounts.destinationBalance,
    isConnected,
    address,
    openConnectModal,
    showWrapNudge: amounts.showWrapNudge,
    nativeEthDisplay: amounts.nativeEthDisplay,
    showWrap: amounts.showWrap,
    setShowWrap: amounts.setShowWrap,
    swapTurns: route.swapTurns,
    isCrossChain: route.isCrossChain,
    outputAmount: amounts.outputAmount,
    payoutField: amounts.payoutField,
    amountBigInt: amounts.amountBigInt,
    isNonEvmDest: route.isNonEvmDest,
    recipientAddress: gating.recipientAddress,
    setRecipientAddress: gating.setRecipientAddress,
    recipientInvalid: gating.recipientInvalid,
    recipientMissing: gating.recipientMissing,
    recipientCheck: gating.recipientCheck,
    trimmedRecipient: gating.trimmedRecipient,
    zkMoneyDestination: route.zkMoneyDestination,
    zkMoneyOffered: route.zkMoneyOffered,
    zkMoneyBlockedReason: route.zkMoneyBlockedReason,
    handleZkMoneySelect,
    recipientTag: gating.recipientTag,
    setRecipientTag: gating.setRecipientTag,
    zkMoneyTag: gating.zkMoneyTag,
    zkMoneyTagError: gating.zkMoneyTagError,
    isNonEvmOrigin: route.isNonEvmOrigin,
    refundAddress: gating.refundAddress,
    setRefundAddress: gating.setRefundAddress,
    refundError: gating.refundError,
    refundInvalid: gating.refundInvalid,
    sourceChainIds: route.sourceChainIds,
    destinationPickerMode,
    stealthDestinationGuidance,
    destinationChainIds:
      destinationPickerMode === "stealth"
        ? stealthDestinations.chainIds
        : route.destinationChainIds,
    originTokensByChain: route.originTokensByChain,
    destinationTokensByChain:
      destinationPickerMode === "stealth"
        ? stealthDestinations.tokensByChain
        : route.destinationTokensByChain,
    classifyOriginToken:
      destinationPickerMode === "stealth"
        ? route.stealthOrigins.classifyToken
        : route.classifyOriginToken,
    classifyDestinationToken:
      destinationPickerMode === "stealth"
        ? stealthDestinations.classifyToken
        : route.classifyDestinationToken,
    originChainBlockedReason:
      destinationPickerMode === "stealth"
        ? route.stealthOrigins.chainBlockedReason
        : route.originChainBlockedReason,
    destinationChainBlockedReason:
      destinationPickerMode === "stealth"
        ? stealthDestinations.chainBlockedReason
        : route.destinationChainBlockedReason,
    routeCheck: route.routeCheck,
    routeBlocked: route.routeBlocked,
    orderOutOfBounds: amounts.orderOutOfBounds,
    orderBoundsNotice: amounts.orderBoundsNotice,
    excessiveSlippage: amounts.excessiveSlippage,
    amountGuidance: amounts.amountGuidance,
    handleIncreaseToMinimum: amounts.handleIncreaseToMinimum,
    stealthUnavailable: gating.stealthUnavailable,
    stealthRequestRejected: gating.stealthRequestRejected,
    originTokens: route.originTokens,
    cta: flow.cta,
    needsChainSwitch: flow.needsChainSwitch,
    quoteStale: flow.quoteStale,
    insufficientBalance: amounts.insufficientBalance,
    handleMarketSubmit: flow.handleMarketSubmit,
    handleConfirmSwap: flow.handleConfirmSwap,
    handleCancelSign: flow.handleCancelSign,
    handleCloseFlow: flow.handleCloseFlow,
    handleStartOver: flow.handleStartOver,
    retryQuote,
    resumedDeposit: flow.resumedDeposit,
    handleSwapTokens: route.handleSwapTokens,
    flipBlockedReason: route.flipBlockedReason,
    handleFromChainChange,
    handleToChainChange,
    handleFromTokenChange,
    handleToTokenChange,
    thinDestination: route.thinDestination,
    canSwitchDestination:
      destinationPickerMode === "stealth"
        ? route.thinDestination !== null &&
          (stealthDestinations.tokensByChain.get(route.toChainId) ?? []).some(
            (token) => token.symbol === route.thinDestination?.preferred,
          )
        : route.canSwitchDestination,
    switchToPreferredDestination: () => {
      const tokensByChain =
        destinationPickerMode === "stealth"
          ? stealthDestinations.tokensByChain
          : route.destinationTokensByChain;
      const token = tokensByChain
        .get(route.toChainId)
        ?.find((candidate) => candidate.symbol === route.thinDestination?.preferred);
      if (token) handleToTokenChange(token);
    },
    recipientBalance: amounts.recipientBalance,
    showExplainer,
    setShowExplainer,
    flowOpen,
    flowReopenable: flow.flowReopenable,
    // What the flow modal renders: the dispatched order's own destination
    // while one is in flight, the live form's otherwise. Never the live
    // toggle for an executed order (see executedDestination in useSwapFlow).
    flowDestination: flow.flowDestination,
    // The host's locks and allow-lists, for the selectors and the amount field.
    policy,
    executionStartTime: flow.executionStartTime,
  };
}
