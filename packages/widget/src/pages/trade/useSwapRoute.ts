/**
 * useSwapRoute
 *
 * The route half of the swap panel's view-model: which chains and tokens the
 * trade runs between, which direction it runs, and whether the solver can fill
 * that shape at all. Split out of the 1666-line `useSwapPanel` closure
 * (DEBT-014 step 3) and constructed FIRST, because every other group keys off
 * the legs -- the amount is denominated in them, the settlement gating reads
 * the destination chain, and the quote request is parameterized by all four.
 *
 * Owns the four leg values, the flip counter, the solver capability matrix
 * (`useCapabilities`, whose token lists also pick the leg defaults after a
 * chain change), structural route support (`RouteCheck`), and the
 * thin-destination steer.
 *
 * Deliberately does NOT own the pay amount, the settlement mode, the
 * recipient/refund inputs or the quote (`useIntent`). A leg change has to clear
 * or reset all of those, and they belong to hooks constructed after this one,
 * so the composition passes those consequences in as the four `on*` callbacks
 * below rather than this hook reaching into state it does not own.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  EXTENDED_CHAIN_NAMES,
  isSelectableChainId,
  isTronChainId,
  type SelectableChainId,
} from "@xochi/client";
import { thinDestinationWarning, type ThinDestination } from "@xochi/client";
import type { SolverCapabilities } from "@xochi/signer";
import { capabilityVmType, type AddressableVmType } from "@xochi/client";
import { type Token, isChainId } from "../../types/intent.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import type { PairAvailability } from "../../lib/pairAvailability.js";
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_TO_CHAIN_ID,
  DEFAULT_FROM_TOKEN,
  DEFAULT_TO_TOKEN,
  chainEnabledForRole,
  TOKENS,
} from "./config.js";
import type { ExtendedChainId } from "./Selectors.js";
import {
  OPEN_POLICY,
  legChainAllowed,
  legTokenAllowed,
  policyAdmits,
  type EmbedPolicy,
} from "./embedParams.js";
import {
  resolveRouteModel,
  type CapabilityState,
  type ChainDestination,
  type ResolvedRouteAvailability,
  type ExecutableRouteDestination,
  type RouteLeg,
  type RoutePrivacyMode,
} from "@xochi/client";

// Which VM a leg runs decides which address inputs the panel shows. Tron
// first (the static guard: FALLBACK_CAPABILITIES does not carry it), then the
// solver's matrix, then the static registry, where every `ChainId` is EVM by
// construction. A chain none of them classifies resolves to null and is treated
// as non-EVM: it can never take the EVM path (connected wallet as payout) by
// default, and `validateDestinationAddress` / `refundAddressError` refuse it.
export function legVmType(
  capabilities: SolverCapabilities,
  chainId: number,
): AddressableVmType | null {
  return isTronChainId(chainId)
    ? "tvm"
    : (capabilityVmType(capabilities, chainId) ?? (isChainId(chainId) ? "evm" : null));
}

// Pick a sensible default token for a chain after a chain switch. Prefer a
// solver-supported symbol -- what the selector menu actually lists (originTokens
// / destinationTokens) -- and, within that, a stablecoin. Falls back to the raw
// list (still stablecoin-first) while capabilities load. Without this, a chain
// change defaulted to `TOKENS[chain][0]`, which is WETH on several chains: an
// unlisted token that shows "route not supported" until the user reopens the menu
// and picks USDC/USDT (#338).
export function pickDefaultToken<T extends { symbol: string }>(
  tokens: readonly T[],
  allowed: readonly string[],
): T {
  const supported = tokens.filter((t) => allowed.includes(t.symbol));
  const pool = supported.length > 0 ? supported : tokens;
  return (
    pool.find((t) => t.symbol === "USDC") ??
    pool.find((t) => t.symbol === "USDT") ??
    pool.find((t) => t.symbol === "USDG") ??
    pool[0]
  );
}

// Rebind a selected token to canonical metadata for its current chain.
// A capability refresh that removes the symbol leaves the selection in place
// so the route becomes visibly unsupported instead of silently changing assets.
export function resolveTokenForChain<T extends { symbol: string; chainId: number }>(
  current: T,
  chainId: number,
  tokens: readonly T[],
  allowed: readonly string[],
  sameDeployment?: (left: T, right: T) => boolean,
): T | null {
  const sameCoin = tokens.find(
    (token) => token.symbol === current.symbol && allowed.includes(token.symbol),
  );
  if (!sameCoin) return null;
  if (
    current.chainId === chainId &&
    (sameDeployment === undefined || sameDeployment(current, sameCoin))
  ) {
    return null;
  }
  return sameCoin;
}

type SelectableToken = Token & { chainId: SelectableChainId };

function isSelectableToken(token: Token): token is SelectableToken {
  return isSelectableChainId(token.chainId);
}

function sameTokenDeployment(left: Token, right: Token): boolean {
  return (
    left.chainId === right.chainId &&
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    (isTronChainId(left.chainId)
      ? left.address === right.address
      : left.address.toLowerCase() === right.address.toLowerCase())
  );
}

/**
 * Opposite-leg deployments to try after a token pick makes the current pair
 * invalid. Preserve the current opposite leg first, then prefer the same coin
 * on its current chain (ordinary bridging), then the current coin on the picked
 * token's chain (same-chain conversion).
 */
function rankedRepairTokens(
  candidates: readonly SelectableToken[],
  selected: Token,
  current: Token,
  currentChainId: SelectableChainId,
): SelectableToken[] {
  const rank = (candidate: SelectableToken): number => {
    const currentChain = candidate.chainId === currentChainId;
    const selectedChain = candidate.chainId === selected.chainId;
    const currentSymbol = candidate.symbol === current.symbol;
    const selectedSymbol = candidate.symbol === selected.symbol;

    if (currentChain && currentSymbol) return 0;
    if (currentChain && selectedSymbol) return 1;
    if (selectedChain && currentSymbol) return 2;
    if (currentChain) return 3;
    if (selectedChain) return 4;
    if (selectedSymbol) return 5;
    if (currentSymbol) return 6;
    return 7;
  };

  return [...candidates].sort((left, right) => rank(left) - rank(right));
}

/** Both legs at once, for the restore paths (retry prefill, resumed swap). */
export interface SwapRouteLegs {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
}

/**
 * The structural verdict on the selected pair, before any quote.
 *
 * - `supported`: quote it.
 * - `unsupported`: the solver cannot fill this shape; `notice` says why and
 *   which route would work.
 * - `checking`: the only objection is a missing conversion pair, and the
 *   solver's route list has not loaded yet. The fallback served meanwhile lists
 *   no pairs at all, so its silence is not a verdict: say nothing, and do not
 *   quote until the real list answers.
 * - `unknown`: the same objection, but the list failed to load (or the worker
 *   could only serve its own fallback). Still not a verdict, so the panel says
 *   the list is missing and offers `retry`; cross-coin quotes stay paused, as
 *   in any solver outage.
 */
export type RouteCheck =
  | { status: "supported" }
  | { status: "unsupported"; notice: string }
  | { status: "checking" }
  | { status: "unknown"; retry: () => void; retrying: boolean };

/** The pair a notice is about: two coins on two chains. */
export interface RoutePair {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromSymbol: string;
  toSymbol: string;
  fromAddress?: string;
  toAddress?: string;
}

/**
 * What the panel says when a cross-coin pair is unknown because the solver's
 * route list did not load (the `unknown` verdict).
 */
export const ROUTE_LIST_UNAVAILABLE =
  "Couldn't load route capabilities. Retry to see the supported chains, tokens and privacy options.";

/**
 * Why the direction flip is unavailable for this pair under a host's policy,
 * or null. A host's locks hold the route as set, so any lock blocks the flip
 * (the amount is denominated in the send leg, so even an amount lock does); an
 * allow-list blocks it when the reversed route falls outside it. The panel and
 * the configurator (xochi-widget#46) read this one rule.
 */
export function routeFlipBlockedReason(policy: EmbedPolicy, pair: RoutePair): string | null {
  if (policy.locks.length > 0) return "The site sets this route.";
  return policyAdmits(policy, {
    fromChainId: pair.toChainId,
    toChainId: pair.fromChainId,
    fromSymbol: pair.toSymbol,
    toSymbol: pair.fromSymbol,
  })
    ? null
    : "Only this direction is offered.";
}

/**
 * What a leg change costs OUTSIDE the route group.
 *
 * Each of these is a state cell owned by a hook constructed after this one, so
 * the composition supplies the write. They run from event handlers, never
 * during render.
 */
export interface UseSwapRouteParams {
  /** Origin chain or token changed: the pay amount and the quote are dropped. */
  onOriginChange: () => void;
  /**
   * Destination chain changed: the recipient belongs to the old destination and
   * the stealth-switch origin no longer explains anything, so both go with the
   * quote.
   */
  onDestinationChainChange: () => void;
  /** Destination token changed: the quote is dropped. */
  onDestinationTokenChange: () => void;
  /**
   * Direction flipped. Receives the token that is now the ORIGIN (the old
   * destination), because the amount carried across the flip is denominated in
   * it. Also clears both leg-scoped address inputs and the quote.
   */
  onFlip: (nextFromToken: Token) => void;
  /**
   * The legs the panel opens on, read once at mount. Absent: the defaults
   * (Base USDC -> Arbitrum USDC). The frame's URL parameters supply it
   * (embedParams.ts), already validated, so this hook does not re-check it.
   */
  initial?: SwapRouteLegs;
  /**
   * The host's locks and allow-lists (xochi-widget#39, embedParams.ts). A
   * locked leg field, or a value outside an allow-list, is refused at the
   * handlers (`legChainAllowed` / `legTokenAllowed`, the rule the pickers
   * narrow by), so no control can move the route off it. Restores
   * (`applyRoute`) are not filtered: a resumed swap shows the order as it was,
   * and useSwapPanel puts the host's route back once the panel is idle.
   */
  policy?: EmbedPolicy;
}

export interface UseSwapRouteResult {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
  handleFromChainChange: (chainId: ExtendedChainId) => void;
  handleToChainChange: (chainId: ExtendedChainId) => void;
  handleFromTokenChange: (token: Token) => void;
  handleToTokenChange: (token: Token) => void;
  /** Switch to the exact token deployment advertising Stealth on this destination. */
  handleStealthDestinationChange: (chainId: ExtendedChainId) => void;
  /**
   * The destination is zk.money: DAI on Ethereum to a tag (zkMoney.ts). Set by
   * `selectZkMoneyDestination`; changing the receive leg or flipping clears it.
   */
  zkMoneyDestination: boolean;
  /** Whether the exact typed zk.money route is advertised and allowed by host policy. */
  zkMoneyOffered: boolean;
  /** Why zk.money is not offered, or null when it is. */
  zkMoneyBlockedReason: string | null;
  selectZkMoneyDestination: () => void;
  handleSwapTokens: () => void;
  /** Why the direction flip is unavailable for the current pair, or null. */
  flipBlockedReason: string | null;
  swapTurns: number;
  isCrossChain: boolean;
  isNonEvmDest: boolean;
  isNonEvmOrigin: boolean;
  /** Distinct capability-advertised source symbols, for execution guidance. */
  originTokens: readonly string[];
  /** Capability-derived selector inventories after launch gates and host policy. */
  sourceChainIds: readonly SelectableChainId[];
  destinationChainIds: readonly SelectableChainId[];
  originTokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]>;
  destinationTokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]>;
  /** The live capability matrix, read by the amount and settlement groups too. */
  capabilities: SolverCapabilities;
  capabilityState: CapabilityState;
  capabilitiesFetching: boolean;
  retryCapabilities: () => void;
  /** Privacy modes on the exact selected route. */
  selectedPrivacyModes: readonly RoutePrivacyMode[];
  /** Destinations where this exact origin/token and receive token support stealth. */
  stealthDestinationChainIds: readonly SelectableChainId[];
  /** A solver matrix (live or stale) is held, so its VM metadata is known. */
  stealthChainsKnown: boolean;
  /** The authoritative matrix is still loading. */
  capabilitiesLoading: boolean;
  thinDestination: ThinDestination | null;
  canSwitchDestination: boolean;
  /** Whether the host's policy lets the destination move to a chain. */
  destinationChainAllowed: (chainId: number) => boolean;
  switchToPreferredDestination: () => void;
  classifyOriginToken: (token: Token) => PairAvailability;
  classifyDestinationToken: (token: Token) => PairAvailability;
  originChainBlockedReason: (chainId: ExtendedChainId) => string | null;
  destinationChainBlockedReason: (chainId: ExtendedChainId) => string | null;
  routeCheck: RouteCheck;
  /** Quotes and execution are blocked unless the exact selected route is known and supported. */
  routeBlocked: boolean;
  /** Set both legs in one batch; for the restore paths (prefill, resume). */
  applyRoute: (legs: SwapRouteLegs) => void;
}

export function useSwapRoute({
  onOriginChange,
  onDestinationChainChange,
  onDestinationTokenChange,
  onFlip,
  initial,
  policy = OPEN_POLICY,
}: UseSwapRouteParams): UseSwapRouteResult {
  // Chain and token state. Either leg can be non-EVM (Tron): a Tron destination
  // (Wave 2) or a Tron origin deposit route (Wave 3). The connected EVM wallet is
  // still required -- it is the payout address on a Tron-origin route.
  const [fromChainId, setFromChainId] = useState<SelectableChainId>(
    () => initial?.fromChainId ?? DEFAULT_CHAIN_ID,
  );
  const [toChainId, setToChainId] = useState<SelectableChainId>(
    () => initial?.toChainId ?? DEFAULT_TO_CHAIN_ID,
  );
  const [fromToken, setFromToken] = useState(() => initial?.fromToken ?? DEFAULT_FROM_TOKEN);
  const [toToken, setToToken] = useState(() => initial?.toToken ?? DEFAULT_TO_TOKEN);
  // Accumulated 180deg turns of the swap icon -- each flip adds one, so the
  // icon rotates to show the direction change (motion = meaning).
  const [swapTurns, setSwapTurns] = useState(0);
  const [zkMoneyDestination, setZkMoneyDestination] = useState(false);

  const {
    capabilities,
    source: capabilitiesSource,
    isLoading,
    isError,
    isFetching,
    retry,
  } = useCapabilities();
  const capabilityState: CapabilityState = isError
    ? "failed"
    : capabilitiesSource === "live"
      ? "live"
      : capabilitiesSource === "stale"
        ? "stale"
        : "fallback";
  const routeModel = useMemo(
    () =>
      resolveRouteModel(capabilities, capabilityState, {
        chainEnabledForRole,
        presentationTokens: TOKENS,
      }),
    [capabilities, capabilityState],
  );

  const policyAllowsToken = useCallback(
    (leg: "sell" | "buy", token: Token, currentChainId: SelectableChainId, current: Token) => {
      const tokenLocked = policy.locks.includes(leg === "sell" ? "sell" : "buy");
      return tokenLocked
        ? token.symbol === current.symbol
        : legTokenAllowed(policy, leg, token, currentChainId);
    },
    [policy],
  );

  const originTokensByChain = useMemo(() => {
    const entries = routeModel.originChainIds.flatMap((chainId) => {
      if (
        !legChainAllowed(policy, "sell", chainId, {
          chainId: fromChainId,
          symbol: fromToken.symbol,
        })
      ) {
        return [];
      }
      const tokens = (routeModel.originTokens.get(chainId) ?? []).filter((token) =>
        policyAllowsToken("sell", token, fromChainId, fromToken),
      );
      return tokens.length > 0 ? ([[chainId, tokens]] as const) : [];
    });
    return new Map<SelectableChainId, readonly Token[]>(entries);
  }, [fromChainId, fromToken, policy, policyAllowsToken, routeModel]);

  const destinationTokensByChain = useMemo(() => {
    const entries = routeModel.destinationChainIds.flatMap((chainId) => {
      if (
        !legChainAllowed(policy, "buy", chainId, {
          chainId: toChainId,
          symbol: toToken.symbol,
        })
      ) {
        return [];
      }
      const tokens = (routeModel.destinationTokens.get(chainId) ?? []).filter((token) =>
        policyAllowsToken("buy", token, toChainId, toToken),
      );
      return tokens.length > 0 ? ([[chainId, tokens]] as const) : [];
    });
    return new Map<SelectableChainId, readonly Token[]>(entries);
  }, [policy, policyAllowsToken, routeModel, toChainId, toToken]);

  const sourceChainIds = useMemo(
    () => routeModel.originChainIds.filter((chainId) => originTokensByChain.has(chainId)),
    [originTokensByChain, routeModel.originChainIds],
  );
  const destinationChainIds = useMemo(
    () => routeModel.destinationChainIds.filter((chainId) => destinationTokensByChain.has(chainId)),
    [destinationTokensByChain, routeModel.destinationChainIds],
  );
  const originTokens = useMemo(
    () => [
      ...new Set(
        sourceChainIds.flatMap((chainId) =>
          (originTokensByChain.get(chainId) ?? []).map((token) => token.symbol),
        ),
      ),
    ],
    [originTokensByChain, sourceChainIds],
  );

  // A chain badge changes only the chain. Rebind the token to an advertised
  // deployment on that chain; never consult the static catalog as authority.
  useEffect(() => {
    const tokens = originTokensByChain.get(fromChainId);
    if (!tokens || tokens.length === 0) return;
    const next = resolveTokenForChain(
      fromToken,
      fromChainId,
      tokens,
      tokens.map((token) => token.symbol),
      sameTokenDeployment,
    );
    if (next) setFromToken(next);
  }, [fromChainId, fromToken, originTokensByChain]);

  useEffect(() => {
    const tokens = destinationTokensByChain.get(toChainId);
    if (!tokens || tokens.length === 0) return;
    const next = resolveTokenForChain(
      toToken,
      toChainId,
      tokens,
      tokens.map((token) => token.symbol),
      sameTokenDeployment,
    );
    if (next) setToToken(next);
  }, [destinationTokensByChain, toChainId, toToken]);

  const isNonEvmDest = legVmType(capabilities, toChainId) !== "evm";
  const isNonEvmOrigin = legVmType(capabilities, fromChainId) !== "evm";

  const selectedOrigin: RouteLeg = useMemo(
    () => ({ chainId: fromChainId, token: fromToken }),
    [fromChainId, fromToken],
  );
  const selectedDestination: ExecutableRouteDestination | null = useMemo(
    () =>
      zkMoneyDestination
        ? routeModel.zkMoneyDestination
        : { kind: "chain", chainId: toChainId, token: toToken },
    [routeModel.zkMoneyDestination, toChainId, toToken, zkMoneyDestination],
  );
  const selectedAvailability: ResolvedRouteAvailability = useMemo(
    () =>
      selectedDestination === null
        ? { status: "unavailable", reason: "zk.money is not advertised as a destination." }
        : routeModel.resolve(selectedOrigin, selectedDestination),
    [routeModel, selectedDestination, selectedOrigin],
  );
  const selectedPrivacyModes: readonly RoutePrivacyMode[] =
    selectedAvailability.status === "available" ? selectedAvailability.privacyModes : [];

  const routeCheck = useMemo((): RouteCheck => {
    if (selectedAvailability.status === "available") return { status: "supported" };
    if (selectedAvailability.status === "unavailable") {
      return { status: "unsupported", notice: selectedAvailability.reason };
    }
    return isLoading ? { status: "checking" } : { status: "unknown", retry, retrying: isFetching };
  }, [isFetching, isLoading, retry, selectedAvailability]);

  const routeLeg = (token: Token): RouteLeg | null =>
    isSelectableToken(token) ? { chainId: token.chainId, token } : null;
  const chainDestination = (token: Token): ChainDestination | null =>
    isSelectableToken(token) ? { kind: "chain", chainId: token.chainId, token } : null;
  const pairAvailability = (availability: ResolvedRouteAvailability): PairAvailability =>
    availability.status === "available"
      ? { state: "available" }
      : { state: "unsupported", reason: availability.reason };

  /**
   * Find the nearest policy-compatible opposite leg that has an exact typed
   * route. Registry order breaks ties, preserving the incumbent repair behavior.
   */
  const findRouteRepair = useCallback(
    (selected: Token, selectedLeg: "sell" | "buy"): SelectableToken | null => {
      if (!isSelectableToken(selected)) return null;
      const current = selectedLeg === "sell" ? toToken : fromToken;
      const currentChainId = selectedLeg === "sell" ? toChainId : fromChainId;
      const oppositeMap = selectedLeg === "sell" ? destinationTokensByChain : originTokensByChain;
      const candidates = [...oppositeMap.values()].flat().filter(isSelectableToken);

      for (const candidate of rankedRepairTokens(candidates, selected, current, currentChainId)) {
        const origin = selectedLeg === "sell" ? routeLeg(selected) : routeLeg(candidate);
        const destination =
          selectedLeg === "sell" ? chainDestination(candidate) : chainDestination(selected);
        if (
          origin !== null &&
          destination !== null &&
          routeModel.resolve(origin, destination).status === "available"
        ) {
          return candidate;
        }
      }
      return null;
    },
    [
      destinationTokensByChain,
      fromChainId,
      fromToken,
      originTokensByChain,
      routeModel,
      toChainId,
      toToken,
    ],
  );

  const classifyOriginToken = useCallback(
    (token: Token): PairAvailability => {
      const origin = routeLeg(token);
      if (
        origin === null ||
        !policyAllowsToken("sell", token, fromChainId, fromToken) ||
        !(originTokensByChain.get(origin.chainId) ?? []).some((candidate) =>
          sameTokenDeployment(candidate, token),
        )
      ) {
        return {
          state: "unsupported",
          reason: `This site doesn't offer ${token.symbol} as a send token.`,
        };
      }
      if (zkMoneyDestination) {
        return routeModel.zkMoneyDestination === null
          ? { state: "unsupported", reason: "zk.money is not advertised as a destination." }
          : pairAvailability(routeModel.resolve(origin, routeModel.zkMoneyDestination));
      }
      const destination = chainDestination(toToken);
      if (destination === null) {
        return { state: "unsupported", reason: `${toToken.symbol} can't be received here.` };
      }
      const current = routeModel.resolve(origin, destination);
      return current.status === "available" || findRouteRepair(token, "sell") !== null
        ? { state: "available" }
        : pairAvailability(current);
    },
    [
      findRouteRepair,
      fromChainId,
      fromToken,
      originTokensByChain,
      policyAllowsToken,
      routeModel,
      toToken,
      zkMoneyDestination,
    ],
  );

  const classifyDestinationToken = useCallback(
    (token: Token): PairAvailability => {
      const destination = chainDestination(token);
      if (
        destination === null ||
        !policyAllowsToken("buy", token, toChainId, toToken) ||
        !(destinationTokensByChain.get(destination.chainId) ?? []).some((candidate) =>
          sameTokenDeployment(candidate, token),
        )
      ) {
        return {
          state: "unsupported",
          reason: `This site doesn't offer ${token.symbol} as a receive token.`,
        };
      }
      const current = routeModel.resolve(selectedOrigin, destination);
      return current.status === "available" || findRouteRepair(token, "buy") !== null
        ? { state: "available" }
        : pairAvailability(current);
    },
    [
      destinationTokensByChain,
      findRouteRepair,
      policyAllowsToken,
      routeModel,
      selectedOrigin,
      toChainId,
      toToken,
    ],
  );

  const originChainBlockedReason = useCallback(
    (chainId: ExtendedChainId): string | null => {
      if (!isSelectableChainId(chainId) || !sourceChainIds.includes(chainId)) {
        return `${EXTENDED_CHAIN_NAMES[chainId]} is not available as a send network.`;
      }
      const tokens = originTokensByChain.get(chainId) ?? [];
      const token = tokens.find((candidate) => candidate.symbol === fromToken.symbol) ?? tokens[0];
      if (!token) return `Nothing can be sent from ${EXTENDED_CHAIN_NAMES[chainId]} here.`;
      const availability = classifyOriginToken(token);
      return availability.state === "unsupported"
        ? (availability.reason ?? "Route unavailable")
        : null;
    },
    [classifyOriginToken, fromToken.symbol, originTokensByChain, sourceChainIds],
  );

  const destinationChainBlockedReason = useCallback(
    (chainId: ExtendedChainId): string | null => {
      if (!isSelectableChainId(chainId) || !destinationChainIds.includes(chainId)) {
        return `${EXTENDED_CHAIN_NAMES[chainId]} is not available as a receive network.`;
      }
      const tokens = destinationTokensByChain.get(chainId) ?? [];
      const token = tokens.find((candidate) => candidate.symbol === toToken.symbol) ?? tokens[0];
      if (!token) return `Nothing can be received on ${EXTENDED_CHAIN_NAMES[chainId]} here.`;
      const availability = classifyDestinationToken(token);
      return availability.state === "unsupported"
        ? (availability.reason ?? "Route unavailable")
        : null;
    },
    [classifyDestinationToken, destinationChainIds, destinationTokensByChain, toToken.symbol],
  );

  const staticFlipReason = routeFlipBlockedReason(policy, {
    fromChainId,
    toChainId,
    fromSymbol: fromToken.symbol,
    toSymbol: toToken.symbol,
  });
  const reversedAvailability = routeModel.resolve(
    { chainId: toChainId, token: toToken },
    { kind: "chain", chainId: fromChainId, token: fromToken },
  );
  const flipBlockedReason = zkMoneyDestination
    ? "zk.money can only be a receive destination."
    : (staticFlipReason ??
      (reversedAvailability.status === "available" ? null : reversedAvailability.reason));

  const handleSwapTokens = (): void => {
    if (flipBlockedReason !== null) return;
    const tempChain = fromChainId;
    const tempToken = fromToken;
    setZkMoneyDestination(false);
    setFromChainId(toChainId);
    setToChainId(tempChain);
    setFromToken(toToken);
    setToToken(tempToken);
    setSwapTurns((turns) => turns + 1);
    onFlip(toToken);
  };

  const handleFromChainChange = (chainId: ExtendedChainId): void => {
    if (!isSelectableChainId(chainId) || !sourceChainIds.includes(chainId)) return;
    const tokens = originTokensByChain.get(chainId);
    if (!tokens || tokens.length === 0) return;
    const next =
      tokens.find((token) => token.symbol === fromToken.symbol) ??
      pickDefaultToken(
        tokens,
        tokens.map((token) => token.symbol),
      );
    setFromChainId(chainId);
    setFromToken(next);
    onOriginChange();
  };

  const destinationChainAllowed = (chainId: number): boolean =>
    isSelectableChainId(chainId) &&
    destinationChainIds.includes(chainId) &&
    legChainAllowed(policy, "buy", chainId, { chainId: toChainId, symbol: toToken.symbol });

  const handleToChainChange = (chainId: ExtendedChainId): void => {
    if (!isSelectableChainId(chainId) || !destinationChainAllowed(chainId)) return;
    const tokens = destinationTokensByChain.get(chainId);
    if (!tokens || tokens.length === 0) return;
    const next =
      tokens.find((token) => token.symbol === toToken.symbol) ??
      pickDefaultToken(
        tokens,
        tokens.map((token) => token.symbol),
      );
    setZkMoneyDestination(false);
    setToChainId(chainId);
    setToToken(next);
    onDestinationChainChange();
  };

  const zkMoneyRoute =
    routeModel.zkMoneyDestination === null
      ? null
      : routeModel.resolve(selectedOrigin, routeModel.zkMoneyDestination);
  const zkMoneyToken = routeModel.zkMoneyDestination?.token ?? null;
  const zkMoneyPolicyAllowed =
    zkMoneyToken !== null &&
    isSelectableToken(zkMoneyToken) &&
    legChainAllowed(policy, "buy", zkMoneyToken.chainId, {
      chainId: toChainId,
      symbol: toToken.symbol,
    }) &&
    legTokenAllowed(policy, "buy", zkMoneyToken, toChainId);
  const zkMoneyOffered =
    routeModel.zkMoneyDestination !== null &&
    zkMoneyRoute?.status === "available" &&
    zkMoneyPolicyAllowed;
  const zkMoneyBlockedReason = zkMoneyOffered
    ? null
    : routeModel.zkMoneyDestination === null
      ? "zk.money is not advertised."
      : zkMoneyRoute?.status !== "available"
        ? (zkMoneyRoute?.reason ?? "zk.money route unavailable.")
        : "This site doesn't offer zk.money for this route.";

  const selectZkMoneyDestination = (): void => {
    if (!zkMoneyOffered || zkMoneyToken === null || !isSelectableToken(zkMoneyToken)) return;
    setZkMoneyDestination(true);
    setToChainId(zkMoneyToken.chainId);
    setToToken(zkMoneyToken);
    onDestinationChainChange();
  };

  const handleFromTokenChange = (token: Token): void => {
    if (!isSelectableToken(token) || classifyOriginToken(token).state === "unsupported") return;
    if (zkMoneyDestination) {
      setFromChainId(token.chainId);
      setFromToken(token);
      onOriginChange();
      return;
    }
    const destinationRepair = findRouteRepair(token, "sell");
    if (destinationRepair === null) return;

    const destinationChainChanged = destinationRepair.chainId !== toChainId;
    const destinationTokenChanged =
      destinationRepair.chainId !== toToken.chainId ||
      destinationRepair.address !== toToken.address;
    setFromChainId(token.chainId);
    setFromToken(token);
    setToChainId(destinationRepair.chainId);
    setToToken(destinationRepair);
    setZkMoneyDestination(false);
    onOriginChange();
    if (destinationChainChanged) onDestinationChainChange();
    else if (destinationTokenChanged) onDestinationTokenChange();
  };

  const handleToTokenChange = (token: Token): void => {
    if (!isSelectableToken(token) || classifyDestinationToken(token).state === "unsupported")
      return;
    const sourceRepair = findRouteRepair(token, "buy");
    if (sourceRepair === null) return;

    const sourceChanged =
      sourceRepair.chainId !== fromChainId || sourceRepair.address !== fromToken.address;
    setZkMoneyDestination(false);
    setToChainId(token.chainId);
    setToToken(token);
    setFromChainId(sourceRepair.chainId);
    setFromToken(sourceRepair);
    if (sourceChanged) onOriginChange();
    onDestinationTokenChange();
  };

  // A destination the solver can fill but the recipient cannot realistically
  // use (USDC on Tron). Distinct from route support: this is about what happens
  // to the money AFTER it lands. See destination-liquidity.ts.
  const thinDestination = useMemo(
    () => thinDestinationWarning(toChainId, toToken.symbol),
    [toChainId, toToken.symbol],
  );

  // One-tap switch to the token people on that chain actually hold. It must be
  // in the advertised destination inventory; static metadata cannot grant it.
  const preferredDestinationToken = useMemo(() => {
    if (!thinDestination) return null;
    return (
      destinationTokensByChain
        .get(toChainId)
        ?.find((token) => token.symbol === thinDestination.preferred) ?? null
    );
  }, [destinationTokensByChain, thinDestination, toChainId]);

  const switchToPreferredDestination = (): void => {
    if (preferredDestinationToken) handleToTokenChange(preferredDestinationToken);
  };

  const stealthDestinationToken = useCallback(
    (chainId: SelectableChainId): SelectableToken | null => {
      const token = destinationTokensByChain
        .get(chainId)
        ?.find((candidate) => candidate.symbol === toToken.symbol);
      if (!token || !isSelectableToken(token)) return null;
      const availability = routeModel.resolve(selectedOrigin, {
        kind: "chain",
        chainId,
        token,
      });
      return availability.status === "available" && availability.privacyModes.includes("stealth")
        ? token
        : null;
    },
    [destinationTokensByChain, routeModel, selectedOrigin, toToken.symbol],
  );
  const stealthDestinationChainIds = useMemo(
    () => destinationChainIds.filter((chainId) => stealthDestinationToken(chainId) !== null),
    [destinationChainIds, stealthDestinationToken],
  );
  const handleStealthDestinationChange = (chainId: ExtendedChainId): void => {
    if (!isSelectableChainId(chainId)) return;
    const token = stealthDestinationToken(chainId);
    if (token === null || !destinationChainAllowed(chainId)) return;
    const chainChanged = chainId !== toChainId;
    setZkMoneyDestination(false);
    setToChainId(chainId);
    setToToken(token);
    if (chainChanged) onDestinationChainChange();
    else onDestinationTokenChange();
  };

  // Restore both legs without the leg-change consequences: the restore paths
  // (retry prefill, resumed swap) set the amount and the settlement mode from
  // the record themselves, so clearing them here would undo the restore.
  const applyRoute = useCallback((legs: SwapRouteLegs): void => {
    setZkMoneyDestination(false);
    setFromChainId(legs.fromChainId);
    setToChainId(legs.toChainId);
    setFromToken(legs.fromToken);
    setToToken(legs.toToken);
  }, []);

  const isCrossChain = fromChainId !== toChainId;

  return {
    fromChainId,
    toChainId,
    fromToken,
    toToken,
    handleFromChainChange,
    handleToChainChange,
    handleFromTokenChange,
    handleToTokenChange,
    handleStealthDestinationChange,
    zkMoneyDestination,
    zkMoneyOffered,
    zkMoneyBlockedReason,
    selectZkMoneyDestination,
    handleSwapTokens,
    flipBlockedReason,
    swapTurns,
    isCrossChain,
    isNonEvmDest,
    isNonEvmOrigin,
    originTokens,
    sourceChainIds,
    destinationChainIds,
    originTokensByChain,
    destinationTokensByChain,
    capabilities,
    capabilityState,
    capabilitiesFetching: isFetching,
    retryCapabilities: retry,
    selectedPrivacyModes,
    stealthDestinationChainIds,
    stealthChainsKnown: capabilityState === "live" || capabilityState === "stale",
    capabilitiesLoading: isLoading,
    thinDestination,
    canSwitchDestination:
      preferredDestinationToken !== null &&
      classifyDestinationToken(preferredDestinationToken).state === "available",
    destinationChainAllowed,
    switchToPreferredDestination,
    classifyOriginToken,
    classifyDestinationToken,
    originChainBlockedReason,
    destinationChainBlockedReason,
    routeCheck,
    routeBlocked: routeCheck.status !== "supported",
    applyRoute,
  };
}
