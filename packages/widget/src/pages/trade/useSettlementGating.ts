/**
 * useSettlementGating
 *
 * The privacy half of the swap panel's view-model: which settlement mode the
 * order runs in, whether the deeper modes are offerable at all, the single
 * guidance line that answers a settlement tap, and the two leg-scoped address
 * inputs (recipient on a non-EVM destination, refund on a non-EVM origin).
 * Split out of the 1666-line `useSwapPanel` closure (DEBT-014 step 3).
 *
 * Owns the quote as well (`useIntent`), and that is deliberate rather than
 * incidental: the intent request is parameterized by the settlement mode, the
 * recipient and the refund address -- all owned here -- on top of the legs this
 * hook receives, and the availability answers it gates on
 * (`quote.settlementOptions`, the decline `error`) come straight back out of
 * it. Splitting the two would put the settlement state in the composition and
 * the gating that polices it down here, which is the ownership split DEBT-014
 * exists to remove. Every group downstream reads the intent from this hook's
 * result.
 *
 * Deliberately does NOT own the legs (it receives them, and moves the
 * destination through the route group's own handler so a stealth fix behaves
 * exactly like a manual chain switch), the pay amount, or the flow modal.
 *
 * A new eligible route defaults to Stealth without prompting. A Public opt-in,
 * an explicit host mode, and a restored order remain sticky. Setup is explicit;
 * Stealth quotes require a wallet, keys, and live exact-route authorization.
 * Opening confirm and signing also require a matching private quote.
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { EmbedCodes } from "./embedParams.js";
import { useToast } from "../../components/Toast.js";
import { useIntent, type UseIntentReturn } from "../../hooks/useIntent.js";
import { useStealth } from "../../hooks/useStealth.js";
import type { SettlementType } from "../../types/index.js";
import {
  type IntentDestination,
  type ChainId,
  DEFAULT_DESTINATION,
  STEALTH_DESTINATION,
  isChainId,
} from "../../types/intent.js";
import type { RoutePrivacyMode, SolverCapabilities } from "@xochi/signer";
import { type SelectableChainId } from "@xochi/client";
import { validateDestinationAddress, refundAddressError } from "@xochi/client";
import {
  SHIELDED_SETTLEMENT_LIVE,
  STEALTH_SETTLEMENT_LIVE,
  stealthDestinationTarget as resolveStealthDestinationTarget,
} from "./config.js";
import type { ExtendedChainId } from "./Selectors.js";
import type { CapabilityState } from "@xochi/client";
import {
  isSettlementAvailable,
  settlementFallback,
  settlementRefusalReason,
  shieldedToggleState,
  stealthToggleState,
} from "@xochi/client";
import {
  defaultSettlementSelection,
  settlementSelectionDecision,
  shieldedFixFor,
  stealthFixFor,
  type SettlementFix,
} from "../../lib/settlementAvailability.js";
import { isAmountTooSmall } from "../../lib/errorCategory.js";
import { normalizeZkMoneyTag, zkMoneyTagError, zkMoneyTagValid } from "./zkMoney.js";

/**
 * The single guidance line the panel can be showing, or null for none.
 *
 * One slot, so one value. All three are answers to a settlement tap and they
 * render into the same place (the caption row, or the alert directly under it),
 * so at most one can ever be true -- an invariant that used to live in a
 * comment over three independent booleans and had to be re-obeyed at every one
 * of the eleven places that wrote them.
 */
export type PanelNotice = "stealth_needs_wallet" | "stealth_needs_l1_destination" | "shielded_soon";

export interface UseSettlementGatingParams {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  /** Token addresses, not the Token objects: only the quote request needs them. */
  fromTokenAddress: string;
  toTokenAddress: string;
  capabilities: SolverCapabilities;
  /** Privacy modes advertised on this exact selected route. */
  routePrivacyModes: readonly RoutePrivacyMode[];
  /** Destinations advertising Stealth for this origin/token and receive token. */
  stealthDestinationChainIds: readonly SelectableChainId[];
  /** Only `live` capability data may authorize settlement, including Public. */
  capabilityState: CapabilityState;
  /** A capability load, retry, or refresh is currently in flight. */
  capabilitiesFetching: boolean;
  isNonEvmDest: boolean;
  isNonEvmOrigin: boolean;
  /** The destination is zk.money (useSwapRoute): one tag field, settled public. */
  zkMoneyDestination: boolean;
  /**
   * The route group's destination-chain handler. The stealth destination fix
   * goes through it so that tap clears the recipient and resets the quote
   * exactly as a manual chain switch does.
   */
  handleToChainChange: (chainId: ExtendedChainId) => void;
  isConnected: boolean;
  address: string | undefined;
  trustScore: number;
  slippageBps: number;
  /** Confirm modal open: the quote refresh runs in silent mode while it is. */
  flowOpen: boolean;
  /** Fired once when a stealth swap settles, so the receive panel can auto-scan. */
  onStealthSettled?: () => void;
  /**
   * An explicit host preference. Omitted means Stealth on an eligible route.
   * Read once; subsequent wallet and quote changes never replace a choice.
   */
  initialSettlement?: SettlementType;
  /** Do not persist a provisional route's automatic mode before URL hydration. */
  openingSettled: boolean;
  /**
   * Whether the destination may move to `chainId` (false where a host's lock
   * or allow-list holds it, xochi-widget#39). The stealth notice offers a move
   * only to a stealth chain this allows, and none when it allows none.
   */
  stealthDestinationAllowed?: (chainId: number) => boolean;
  /** Referral and promo codes from the frame URL (embedParams.ts), sent on every quote. */
  codes?: EmbedCodes;
}

export interface UseSettlementGatingResult {
  intent: UseIntentReturn;
  settlement: SettlementType;
  handleSettlementChange: (next: SettlementType) => void;
  setupStealth: () => Promise<void>;
  stealthSetupLoading: boolean;
  stealthSetupError: string | null;
  dismissSettlementNotice: () => void;
  notice: PanelNotice | null;
  shieldedClickable: boolean;
  shieldedPreLive: boolean;
  shieldedRefusalReason: string | null;
  shieldedRouteAvailable: boolean | undefined;
  stealthSelectable: boolean;
  stealthClickable: boolean;
  /** The one fix an unavailable mode shows; null when the mode is available. */
  stealthFix: SettlementFix | null;
  shieldedFix: SettlementFix | null;
  /** The selected mode's fix: non-null means submit is blocked until acted on. */
  settlementFix: SettlementFix | null;
  stealthUnavailable: boolean;
  stealthRequestRejected: boolean;
  stealthRouteAvailable: boolean | undefined;
  stealthRefusalReason: string | null;
  /** Trusted stealth destinations in solver-advertised order. */
  stealthChains: readonly ChainId[];
  stealthDestinationSupported: boolean;
  /** Where the destination fix moves; null when no move is needed or possible. */
  stealthDestinationTarget: ChainId | null;
  stealthDestinationTooSmall: boolean;
  stealthDestinationFrom: SelectableChainId | null;
  dismissStealthDestinationNotice: () => void;
  handleUseStealthDestination: () => void;
  /** Commit Stealth on an exact advertised destination. */
  selectStealth: (destinationChainId: ChainId) => void;
  /**
   * False when stealth needs another destination and the host allows none of
   * the stealth chains (see `stealthDestinationAllowed`): no move is offered.
   */
  stealthDestinationReachable: boolean;
  revertStealthDestination: () => void;
  recipientAddress: string;
  setRecipientAddress: Dispatch<SetStateAction<string>>;
  recipientInvalid: boolean;
  recipientMissing: boolean;
  recipientCheck: { valid: boolean; error?: string };
  trimmedRecipient: string;
  /** The tag field as typed; `zkMoneyTag` is what the quote asks for. */
  recipientTag: string;
  setRecipientTag: Dispatch<SetStateAction<string>>;
  zkMoneyTag: string;
  zkMoneyTagError: string | null;
  refundAddress: string;
  setRefundAddress: Dispatch<SetStateAction<string>>;
  refundError: string | null;
  refundInvalid: boolean;
  /** The destination as the LIVE form describes it; the flow binds it at confirm. */
  destination: IntentDestination;
  /** Who actually receives the payout, for the recipient balance lookup. */
  payoutAddress: string | undefined;
  /** Put the shielded line down; the composition wires it to trade edits. */
  dismissShieldedNotice: () => void;
  /** Restore a mode from a record (retry prefill), bypassing the tap decision. */
  restoreSettlement: (next: SettlementType) => void;
  /** Drop the recipient: any destination change invalidates it. */
  clearRecipient: () => void;
  /** Drop the refund address: it is origin-chain-VM-shaped. */
  clearRefund: () => void;
  /** Forget where the stealth destination switch moved from. */
  clearStealthDestinationOrigin: () => void;
}

export function useSettlementGating({
  fromChainId,
  toChainId,
  fromTokenAddress,
  toTokenAddress,
  capabilities,
  routePrivacyModes,
  stealthDestinationChainIds,
  capabilityState,
  capabilitiesFetching,
  isNonEvmDest,
  isNonEvmOrigin,
  zkMoneyDestination,
  handleToChainChange,
  isConnected,
  address,
  trustScore,
  slippageBps,
  flowOpen,
  onStealthSettled,
  initialSettlement,
  openingSettled,
  stealthDestinationAllowed = () => true,
  codes,
}: UseSettlementGatingParams): UseSettlementGatingResult {
  const { showToast } = useToast();
  const stealth = useStealth();

  // Recipient address on a non-EVM destination (Tron). The user types it; EVM
  // routes settle to the connected wallet, so it stays empty there.
  const [recipientAddress, setRecipientAddress] = useState("");
  // The zk.money tag, typed with or without its `@`; the Worker resolves it.
  const [recipientTag, setRecipientTag] = useState("");
  const [refundAddress, setRefundAddress] = useState("");
  const [selectedSettlement, setSettlement] = useState<SettlementType | null>(
    initialSettlement ?? null,
  );

  const trimmedRecipient = recipientAddress.trim();
  const recipientCheck: { valid: boolean; error?: string } = isNonEvmDest
    ? validateDestinationAddress(trimmedRecipient, toChainId, capabilities)
    : { valid: true };
  const zkMoneyTag = normalizeZkMoneyTag(recipientTag);
  const tagError = zkMoneyDestination ? zkMoneyTagError(zkMoneyTag) : null;
  // Either leg-scoped recipient input, under the one pair of names the amount
  // group (quote trigger) and the flow (CTA) gate on.
  const recipientMissing =
    (isNonEvmDest && trimmedRecipient.length === 0) ||
    (zkMoneyDestination && zkMoneyTag.length === 0);
  // Invalid = required but not a valid value (empty counts as not-yet-valid).
  const recipientInvalid =
    (isNonEvmDest && !recipientCheck.valid) || (zkMoneyDestination && !zkMoneyTagValid(zkMoneyTag));

  const trimmedRefund = refundAddress.trim();
  const refundError = isNonEvmOrigin
    ? refundAddressError(trimmedRefund, fromChainId, capabilities)
    : null;
  // Only blocks when non-empty and wrong. An empty refund address is allowed.
  const refundInvalid = refundError !== null;

  /**
   * The refund address as actually SENT with the quote request. Normalized here
   * so a half-typed or wrong-VM value never reaches the solver as a refund
   * target.
   *
   * NOT the value the deposit screen echoes. That one comes off the verified
   * binding (`intent.attestedDeposit`), because this expression tracks the live
   * input and
   * the input keeps moving after the quote is bound: with the flow modal open,
   * re-quoting is suppressed entirely, so a later edit or a wallet autofill
   * changes this while the signed field stays as it was. Echoing this would name
   * an address the refund cannot reach.
   */
  const effectiveRefundAddress =
    isNonEvmOrigin && !refundInvalid ? trimmedRefund || undefined : undefined;

  // Exact typed routes are the sole settlement authority. A stale matrix may
  // still help selector continuity elsewhere, but it cannot authorize any
  // quote, including Public.
  const liveCapabilities = capabilityState === "live";
  const routeAdvertisesPublic = liveCapabilities && routePrivacyModes.includes("public");
  const routeAdvertisesStealth =
    liveCapabilities && !zkMoneyDestination && routePrivacyModes.includes("stealth");
  const routeAdvertisesShielded =
    liveCapabilities && !zkMoneyDestination && routePrivacyModes.includes("shielded");
  const stealthChains = useMemo(
    () => (liveCapabilities ? stealthDestinationChainIds.filter(isChainId) : []),
    [liveCapabilities, stealthDestinationChainIds],
  );
  const stealthDestinationSupported =
    routeAdvertisesStealth && stealthChains.some((chainId) => chainId === toChainId);
  const stealthEligible = STEALTH_SETTLEMENT_LIVE && stealthDestinationSupported;
  const settlement: SettlementType = zkMoneyDestination
    ? "public"
    : (defaultSettlementSelection(selectedSettlement, stealthEligible) ?? "public");
  useEffect(() => {
    if (openingSettled && !zkMoneyDestination) {
      setSettlement((selected) => defaultSettlementSelection(selected, stealthEligible));
    }
  }, [openingSettled, stealthEligible, zkMoneyDestination]);
  // The fix moves only to a live exact route that advertises Stealth and that
  // the host permits. Static chain metadata and the legacy stealth list never
  // contribute a destination.
  const stealthDestinationTarget = resolveStealthDestinationTarget(
    stealthChains.filter((chainId) => chainId === toChainId || stealthDestinationAllowed(chainId)),
    toChainId,
  );
  const stealthDestinationReachable =
    stealthDestinationTarget !== null ||
    resolveStealthDestinationTarget(stealthChains, toChainId) === null;

  const stealthRouteAuthorized =
    STEALTH_SETTLEMENT_LIVE && routeAdvertisesStealth && stealthDestinationSupported;
  const shieldedRouteAuthorized = SHIELDED_SETTLEMENT_LIVE && routeAdvertisesShielded;
  const stealthAuthorized = stealthRouteAuthorized && isConnected && stealth.metaAddress !== null;
  // zk.money is the typed Public tag-deposit rail even though its navigation
  // affordance lives under Shielded. Every other selection is requested as-is:
  // an unauthorized private choice must never silently mint a Public quote.
  const requestedSettlement: SettlementType = zkMoneyDestination ? "public" : settlement;
  const settlementRouteAuthorized =
    requestedSettlement === "public"
      ? routeAdvertisesPublic
      : requestedSettlement === "stealth"
        ? stealthAuthorized
        : shieldedRouteAuthorized;

  const intent = useIntent({
    fromChainId,
    toChainId,
    fromToken: fromTokenAddress,
    toToken: toTokenAddress,
    settlementPreference: requestedSettlement,
    settlementAuthorized: settlementRouteAuthorized,
    trustScore,
    slippageBps,
    // Only send a recipient for a non-EVM destination (EVM settles to wallet).
    recipientAddress: isNonEvmDest ? trimmedRecipient : undefined,
    // zk.money: the tag, never an address; the Worker binds the resolved one.
    recipientTag: zkMoneyDestination ? zkMoneyTag : undefined,
    // Only send a refund address for a deposit-route origin, and only once it is
    // valid: a half-typed value must not reach the solver as the refund target.
    refundAddress: effectiveRefundAddress,
    stealthMetaAddress:
      requestedSettlement === "stealth" && stealth.metaAddress ? stealth.metaAddress : undefined,
    // Modal open -> the refresh timer runs in SILENT mode (updates the quote in
    // place, no "quoting" flash, failures non-destructive), so the confirm quote
    // stays live and never dead-ends on "expired" while the user reviews it.
    paused: flowOpen,
    ref: codes?.ref ?? undefined,
    promo: codes?.promo ?? undefined,
  });

  // Auto-scan the stealth receive panel once a stealth swap settles, so the
  // one-time private payment appears to claim without the user knowing to press
  // Scan. Fires once per intent, on the first settled/reconciling/completed tick
  // (stealth intents may never reach "completed" upstream, so settling counts).
  const stealthSettledRef = useRef<string | null>(null);
  useEffect(() => {
    if (settlement !== "stealth" || !onStealthSettled) return;
    const id = intent.intentId;
    if (!id) return;
    const settled =
      intent.status === "settling" || intent.status === "completed" || intent.reconciling;
    if (settled && stealthSettledRef.current !== id) {
      stealthSettledRef.current = id;
      onStealthSettled();
    }
  }, [settlement, intent.intentId, intent.status, intent.reconciling, onStealthSettled]);

  // Exact route advertisement grants the mode; quote options can only narrow
  // that grant at runtime. A positive quote option cannot add a mode omitted
  // from the typed route.
  const settlementOptions = zkMoneyDestination ? undefined : intent.quote?.settlementOptions;
  const quotedStealthAvailable = isSettlementAvailable(settlementOptions, "stealth");
  const stealthRouteAvailable = routeAdvertisesStealth && quotedStealthAvailable !== false;
  // The solver's sentence is useful only for a real runtime refusal. On an
  // unadvertised or non-live route, capability guidance owns the copy.
  const stealthRefusalReason =
    routeAdvertisesStealth && quotedStealthAvailable === false
      ? settlementRefusalReason(settlementOptions, "stealth")
      : null;
  const {
    clickable: stealthClickable,
    selectable: stealthSelectable,
    blockedByDestination: stealthBlockedByDestination,
  } = stealthToggleState({
    live: STEALTH_SETTLEMENT_LIVE && liveCapabilities && stealthChains.length > 0,
    destinationSupported: stealthDestinationSupported,
    routeAvailable: stealthRouteAvailable,
  });

  // Shielded direct settlement remains pre-live. Keep its future branch under
  // the same exact-route rule so flipping the feature flag cannot make a quote
  // option or static metadata authoritative.
  const quotedShieldedAvailable = isSettlementAvailable(
    intent.quote?.settlementOptions,
    "shielded",
  );
  const shieldedRouteAvailable = routeAdvertisesShielded && quotedShieldedAvailable !== false;
  const shieldedRefusalReason =
    routeAdvertisesShielded && quotedShieldedAvailable === false
      ? settlementRefusalReason(intent.quote?.settlementOptions, "shielded")
      : null;
  const {
    clickable: shieldedClickable,
    selectable: shieldedSelectable,
    preLive: shieldedPreLive,
  } = shieldedToggleState({
    live: SHIELDED_SETTLEMENT_LIVE && routeAdvertisesShielded,
    routeAvailable: shieldedRouteAvailable,
  });

  // The one caption/nudge slot, as one value.
  //
  // These three were three independent booleans, and their mutual exclusivity
  // was enforced only by a comment asking every future writer to clear the
  // other two. Six of the setter calls in `handleSettlementChange` existed for
  // no other reason, and a single missed one puts two answers to the same tap
  // on screen at once -- in an aria-live region, where a stale line gets
  // announced as if it were the answer. Making the slot one nullable union
  // makes "at most one" true by construction instead of by obedience.
  //
  //   stealth_needs_wallet         Explain an unavailable destination anonymously;
  //     selecting Stealth never starts a signature flow on its own.
  //   stealth_needs_l1_destination The user clicked Stealth on a destination
  //     outside the stealth chains. That click is the only moment we know they want stealth,
  //     so it is the moment to say what stands in the way.
  //   shielded_soon                The user tapped Shielded before it ships.
  const [notice, setNotice] = useState<PanelNotice | null>(null);

  /**
   * Put a notice down, but only if it is still the one on screen.
   *
   * Every clear in this hook is answering ONE of the three, and a blind
   * `setNotice(null)` would also silence whichever unrelated notice happened to
   * have replaced it since. Reading the current value keeps each clear as
   * narrow as the three separate `setX(false)` calls it replaces.
   */
  const clearNotice = useCallback((kind: PanelNotice): void => {
    setNotice((current) => (current === kind ? null : current));
  }, []);

  useEffect(() => {
    if (stealthDestinationSupported || stealthChains.length === 0) {
      clearNotice("stealth_needs_l1_destination");
    }
  }, [stealthDestinationSupported, stealthChains.length, clearNotice]);

  // The trade-edit clear for `shielded_soon` is wired by the composition: the
  // edit it watches for is a leg or amount change, which are two other groups'
  // state, so neither side of it belongs here. This is the narrow write it
  // calls.
  const dismissShieldedNotice = useCallback((): void => {
    clearNotice("shielded_soon");
  }, [clearNotice]);

  // Declining the offer is an answer too. Without this the notice could only be
  // cleared by taking one of its two branches (move to Ethereum, or pick
  // Public), so a user who wanted neither was left with a standing alert above
  // the amount field and no way to put it down. It is guidance rather than a
  // verdict, and guidance you cannot dismiss reads as an error.
  const dismissStealthDestinationNotice = useCallback((): void => {
    clearNotice("stealth_needs_l1_destination");
  }, [clearNotice]);

  // Where the destination was before the stealth destination fix moved it, or
  // null when the user did not get here through that button.
  //
  // Held because that one tap can turn a working quote into a refusal. Cost is
  // `max(gas floor of the destination, the fee rate)` and the L1 floor is about
  // 20x an L2's, so a small order that quoted fine on Arbitrum comes back
  // "Amount too small" on Ethereum. The server names the exact amount that would
  // work (`minimum_amount_usd`, folded into the decline sentence the panel
  // renders); what it cannot know is that the destination changed a moment ago,
  // so the refusal arrives looking unrelated to the tap that caused it.
  //
  // Only the ORIGIN of the change is remembered, never a threshold. The minimum
  // is gas-derived and moves per corridor -- cost-guard.ts is explicit that it
  // is a consequence, not a constant -- so the client must not carry a copy.
  const [stealthDestinationFrom, setStealthDestinationFrom] = useState<SelectableChainId | null>(
    null,
  );

  // Safety net for a non-public settlement the solver turns down after quoting.
  // Two shapes, two different pieces of copy (see settlementFallback):
  //   route_unsupported -> the MODE isn't fillable on this route, so name that
  //     and offer Public instead of the misleading token-unsupported line.
  //   request_rejected  -> the solver rejected the request itself. Keep the
  //     generic error copy (it names the field), and just add the Public escape
  //     hatch, which drops the settlement-only fields the solver refused.
  const settlementFallbackKind = settlementFallback({
    settlement,
    status: intent.status,
    error: intent.error,
    errorCategory: intent.quote?.errorCategory,
  });
  const stealthUnavailable = settlementFallbackKind === "route_unsupported";
  const stealthRequestRejected = settlementFallbackKind === "request_rejected";

  // The one fix each unavailable mode shows, or null when it is available.
  // Ordered by what the user must do first. A mode that loses exact-route
  // authority stays selected, but quoting and submit are both blocked.
  const publicFix: SettlementFix | null = routeAdvertisesPublic
    ? null
    : !liveCapabilities
      ? capabilitiesFetching
        ? "route_loading"
        : "route_unavailable"
      : "route";
  const stealthFix = stealthFixFor({
    live: STEALTH_SETTLEMENT_LIVE,
    stealthChainsKnown: liveCapabilities,
    capabilitiesLoading: capabilitiesFetching,
    hasStealthChains: stealthChains.length > 0,
    connected: isConnected,
    destinationSupported: stealthDestinationSupported,
    metaAddressReady: stealth.metaAddress !== null,
    quotedSettlement:
      settlement === "stealth" && intent.quote ? intent.receipt.settlement.mode : undefined,
    routeAvailable: stealthRouteAvailable,
  });
  const shieldedFix = shieldedFixFor({
    live: !shieldedPreLive,
    routeAvailable: shieldedRouteAvailable,
  });
  const modeFix =
    requestedSettlement === "public"
      ? publicFix
      : requestedSettlement === "stealth"
        ? stealthFix
        : shieldedFix;
  const settlementFix: SettlementFix | null =
    modeFix ??
    (intent.quote && intent.receipt.settlement.mode !== requestedSettlement ? "quote" : null);

  // Selection never prompts a wallet. Commit only against a destination that
  // a live exact route advertised; setup remains explicit and retryable.
  const selectStealth = useCallback(
    (destinationChainId: ChainId): void => {
      if (
        !STEALTH_SETTLEMENT_LIVE ||
        !liveCapabilities ||
        !stealthChains.includes(destinationChainId)
      ) {
        return;
      }
      setSettlement("stealth");
    },
    [liveCapabilities, stealthChains],
  );
  const setupStealth = useCallback(async (): Promise<void> => {
    if (!isConnected || stealth.isLoading || stealth.metaAddress) return;
    const ok = await stealth.initializeKeys();
    if (!ok) showToast("Stealth setup failed. Retry or choose Public.", "error");
  }, [isConnected, stealth, showToast]);

  // Settlement toggle.
  const handleSettlementChange = useCallback(
    (next: SettlementType): void => {
      const decision = settlementSelectionDecision({
        next,
        connected: isConnected,
        stealthSelectable,
        stealthBlockedByDestination,
        shieldedSelectable,
        shieldedPreLive,
      });
      // One assignment per decision, and the slot is single-valued, so raising
      // one notice puts any other down without a call to say so.
      if (decision === "select_public") {
        setNotice(null);
        setSettlement("public");
      } else if (decision === "show_wallet_nudge") {
        setNotice("stealth_needs_wallet");
      } else if (decision === "show_destination_nudge") {
        setNotice("stealth_needs_l1_destination");
      } else if (decision === "show_shielded_soon") {
        setNotice("shielded_soon");
      } else if (decision === "select_stealth" && isChainId(toChainId)) {
        setNotice(null);
        selectStealth(toChainId);
      } else if (decision === "select_shielded") {
        // Dormant until SHIELDED_SETTLEMENT_LIVE flips. Unreachable today
        // (`shieldedPreLive` short-circuits above), kept live-correct so the
        // flip is a flag change rather than a new code path.
        setNotice(null);
        setSettlement("shielded");
      }
    },
    [
      isConnected,
      selectStealth,
      shieldedPreLive,
      shieldedSelectable,
      stealthBlockedByDestination,
      stealthSelectable,
      toChainId,
    ],
  );

  // Accept the notice: move to the first solver-advertised trusted chain and
  // select stealth. Goes through handleToChainChange so recipient and quote
  // invalidation are identical to a manual chain switch.
  const handleUseStealthDestination = (): void => {
    if (
      stealthDestinationTarget === null ||
      !liveCapabilities ||
      !stealthChains.includes(stealthDestinationTarget)
    ) {
      return;
    }
    const previousDestination = toChainId;
    handleToChainChange(stealthDestinationTarget);
    setStealthDestinationFrom(previousDestination);
    clearNotice("stealth_needs_l1_destination");
    selectStealth(stealthDestinationTarget);
  };

  // The destination change we made is what the solver is refusing. Only ever
  // true when all three hold: the switch happened, the destination is still the
  // Ethereum it moved us to, and the decline the panel is showing is the
  // below-the-minimum one. Read through the same categorizer that renders the
  // notice, so the extra explanation cannot appear beside a different error.
  const stealthDestinationTooSmall =
    stealthDestinationFrom !== null &&
    stealthDestinationSupported &&
    toChainId === 1 &&
    isAmountTooSmall(intent.error);

  // One tap back to where the destination was. Moving off every stealth chain
  // keeps the selection blocked and its destination fix visible.
  const revertStealthDestination = (): void => {
    if (stealthDestinationFrom !== null) handleToChainChange(stealthDestinationFrom);
  };

  // The destination as the live form describes it. Derived here so the flow
  // group can bind it at dispatch; the modal reads `flowDestination`, which
  // prefers the bound copy over this one.
  const destination: IntentDestination = zkMoneyDestination
    ? { ...DEFAULT_DESTINATION, recipientTag: zkMoneyTag }
    : settlement === "stealth" && stealthAuthorized
      ? STEALTH_DESTINATION
      : isNonEvmDest
        ? { ...DEFAULT_DESTINATION, recipientAddress: trimmedRecipient }
        : DEFAULT_DESTINATION;

  // Who actually receives the payout: a typed address on a non-EVM destination,
  // otherwise the connected wallet. Only query once a typed address is complete
  // and valid, so we neither fire on every keystroke nor look up a typo. A tag
  // has no address this side knows until the quote binds one: nothing to read.
  const payoutAddress = zkMoneyDestination
    ? undefined
    : isNonEvmDest
      ? recipientInvalid || !trimmedRecipient
        ? undefined
        : trimmedRecipient
      : address;

  const clearRecipient = useCallback((): void => {
    setRecipientAddress("");
    setRecipientTag("");
  }, []);

  const clearRefund = useCallback((): void => {
    setRefundAddress("");
  }, []);

  const clearStealthDestinationOrigin = useCallback((): void => {
    setStealthDestinationFrom(null);
  }, []);

  return {
    intent,
    settlement,
    handleSettlementChange,
    setupStealth,
    stealthSetupLoading: stealth.isLoading,
    stealthSetupError: stealth.error,
    dismissSettlementNotice: () => setNotice(null),
    notice,
    shieldedClickable,
    shieldedPreLive,
    shieldedRefusalReason,
    shieldedRouteAvailable,
    stealthSelectable,
    stealthClickable,
    stealthFix,
    shieldedFix,
    settlementFix,
    stealthUnavailable,
    stealthRequestRejected,
    stealthRouteAvailable,
    stealthRefusalReason,
    stealthChains,
    stealthDestinationSupported,
    stealthDestinationTarget,
    stealthDestinationTooSmall,
    stealthDestinationFrom,
    dismissStealthDestinationNotice,
    handleUseStealthDestination,
    selectStealth,
    stealthDestinationReachable,
    revertStealthDestination,
    recipientAddress,
    setRecipientAddress,
    recipientInvalid,
    recipientMissing,
    recipientCheck,
    trimmedRecipient,
    recipientTag,
    setRecipientTag,
    zkMoneyTag,
    zkMoneyTagError: tagError,
    refundAddress,
    setRefundAddress,
    refundError,
    refundInvalid,
    destination,
    payoutAddress,
    dismissShieldedNotice,
    restoreSettlement: setSettlement,
    clearRecipient,
    clearRefund,
    clearStealthDestinationOrigin,
  };
}
