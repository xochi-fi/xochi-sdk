// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import {
  type AdvertisedRouteQuery,
  type CapabilityRoute,
  type RoutePrivacyMode as CapabilityRoutePrivacyMode,
  type SolverCapabilities,
} from "@xochi/signer";
import {
  isSelectableChainId,
  isTronChainId,
  type ExtendedChainId,
  type SelectableChainId,
} from "./shared/chains.js";
import { validateAddressForVm } from "./shared/vmValidation.js";
import type { TokenInfo } from "./shared/tokens.js";
export interface RouteToken extends TokenInfo {
  chainId: ExtendedChainId;
  logoUri?: string;
}
export interface RouteModelOptions {
  chainEnabledForRole(chainId: number, role: "origin" | "destination"): boolean;
  presentationTokens: Readonly<Partial<Record<SelectableChainId, readonly RouteToken[]>>>;
}
import { capabilityVmType, type AddressableVmType } from "./capabilities.js";
import { stealthDestinationChains } from "./capabilities.js";

export type CapabilityState = "live" | "stale" | "fallback" | "failed";
type RoutePrivacyMode = CapabilityRoutePrivacyMode;

export interface RouteLeg {
  chainId: SelectableChainId;
  token: RouteToken;
}

export interface ChainDestination extends RouteLeg {
  kind: "chain";
}

export interface ZkMoneyDestination {
  kind: "zk_money";
  token: RouteToken;
}

export type ExecutableRouteDestination = ChainDestination | ZkMoneyDestination;

export type ResolvedRouteAvailability =
  | { status: "available"; privacyModes: readonly RoutePrivacyMode[] }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason: string };

export interface ResolvedRouteModel {
  state: CapabilityState;
  originChainIds: readonly SelectableChainId[];
  destinationChainIds: readonly SelectableChainId[];
  originTokens: ReadonlyMap<SelectableChainId, readonly RouteToken[]>;
  destinationTokens: ReadonlyMap<SelectableChainId, readonly RouteToken[]>;
  zkMoneyDestination: ZkMoneyDestination | null;
  resolve(origin: RouteLeg, destination: ExecutableRouteDestination): ResolvedRouteAvailability;
}

type RouteRole = "origin" | "destination";
type ValidatedTokens = ReadonlyMap<SelectableChainId, ReadonlyMap<string, RouteToken>>;

const ETHEREUM_CHAIN_ID: SelectableChainId = 1;
const ROUTES_NOT_LOADED = "Routes could not be loaded";

function tokenKey(chainId: number, symbol: string): string {
  return `${chainId}:${symbol.length}:${symbol}`;
}

function routeScalarsKey(
  originChainId: number,
  originToken: string,
  destination:
    | { kind: "chain"; chainId: number; token: string }
    | { kind: "zk_money"; token: string },
): string {
  const origin = tokenKey(originChainId, originToken);
  return destination.kind === "chain"
    ? `${origin}>chain:${tokenKey(destination.chainId, destination.token)}`
    : `${origin}>zk_money:${destination.token.length}:${destination.token}`;
}

function routeKey(route: CapabilityRoute): string {
  return routeScalarsKey(route.origin.chainId, route.origin.token, route.destination);
}

function destinationQuery(
  destination: ExecutableRouteDestination,
): AdvertisedRouteQuery["destination"] {
  return destination.kind === "chain"
    ? {
        kind: "chain",
        chainId: destination.chainId,
        token: destination.token.symbol,
      }
    : { kind: "zk_money", token: destination.token.symbol };
}

function queryKey(origin: RouteLeg, destination: ExecutableRouteDestination): string {
  return routeScalarsKey(origin.chainId, origin.token.symbol, destinationQuery(destination));
}

function uniqueChainIds(
  capabilities: SolverCapabilities,
  role: RouteRole,
  options: RouteModelOptions,
): readonly SelectableChainId[] {
  const counts = new Map<number, number>();
  for (const chain of capabilities.chains) {
    counts.set(chain.chainId, (counts.get(chain.chainId) ?? 0) + 1);
  }

  return capabilities.chains.flatMap((chain) =>
    counts.get(chain.chainId) === 1 &&
    isSelectableChainId(chain.chainId) &&
    capabilityVmType(capabilities, chain.chainId) !== null &&
    options.chainEnabledForRole(chain.chainId, role)
      ? [chain.chainId]
      : [],
  );
}

function presentationToken(
  chainId: SelectableChainId,
  symbol: string,
  address: string,
  vm: AddressableVmType,
  TOKENS: RouteModelOptions["presentationTokens"],
): RouteToken | undefined {
  const sameAddress = (candidate: RouteToken): boolean =>
    candidate.symbol === symbol &&
    (vm === "evm"
      ? candidate.address.toLowerCase() === address.toLowerCase()
      : candidate.address === address);
  return (
    TOKENS[chainId]?.find(sameAddress) ??
    Object.values(TOKENS)
      .flatMap((tokens) => tokens ?? [])
      .find((candidate) => candidate.symbol === symbol)
  );
}

function validatedTokensByChain(
  chainIds: readonly SelectableChainId[],
  capabilities: SolverCapabilities,
  role: RouteRole,
  options: RouteModelOptions,
): ValidatedTokens {
  const symbolCounts = new Map<string, number>();
  for (const capability of capabilities.tokens) {
    const key = capability.symbol.toLowerCase();
    symbolCounts.set(key, (symbolCounts.get(key) ?? 0) + 1);
  }

  const result = new Map<SelectableChainId, ReadonlyMap<string, RouteToken>>();
  for (const chainId of chainIds) {
    const vm = capabilityVmType(capabilities, chainId);
    const tokens = new Map<string, RouteToken>();
    if (vm === null) {
      result.set(chainId, tokens);
      continue;
    }

    for (const capability of capabilities.tokens) {
      const address = Object.prototype.hasOwnProperty.call(capability.addresses, chainId)
        ? capability.addresses[chainId]
        : undefined;
      if (
        symbolCounts.get(capability.symbol.toLowerCase()) !== 1 ||
        !capability.roles.includes(role) ||
        (role === "destination" && capability.symbol === "USDC_E") ||
        address === undefined ||
        !validateAddressForVm(address, vm).valid ||
        capability.decimals === null ||
        !Number.isInteger(capability.decimals) ||
        capability.decimals < 0 ||
        capability.decimals > 255
      ) {
        continue;
      }

      const presentation = presentationToken(
        chainId,
        capability.symbol,
        address,
        vm,
        options.presentationTokens,
      );
      tokens.set(capability.symbol, {
        address,
        symbol: capability.symbol,
        name: presentation?.name ?? capability.symbol,
        decimals: capability.decimals,
        chainId,
        ...(presentation?.logoUri === undefined ? {} : { logoUri: presentation.logoUri }),
      });
    }
    result.set(chainId, tokens);
  }
  return result;
}

function trustedPrivacyModes(
  route: CapabilityRoute,
  stealthChains: ReadonlySet<number>,
): readonly RoutePrivacyMode[] {
  if (!("chainId" in route.destination)) {
    return route.privacyModes.includes("public") ? ["public"] : [];
  }
  const destinationChainId = route.destination.chainId;
  return route.privacyModes.filter(
    (mode) => mode !== "stealth" || stealthChains.has(destinationChainId),
  );
}

function exactToken(tokens: ValidatedTokens, chainId: number, symbol: string): RouteToken | null {
  return isSelectableChainId(chainId) ? (tokens.get(chainId)?.get(symbol) ?? null) : null;
}

function sameToken(left: RouteToken, right: RouteToken): boolean {
  return (
    left.chainId === right.chainId &&
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    (isTronChainId(left.chainId)
      ? left.address === right.address
      : left.address.toLowerCase() === right.address.toLowerCase())
  );
}

function containsExactToken(tokens: readonly RouteToken[], selected: RouteToken): boolean {
  return tokens.some((token) => sameToken(token, selected));
}

function routeInventories(
  capabilities: SolverCapabilities,
  origins: ValidatedTokens,
  destinations: ValidatedTokens,
  stealthChains: ReadonlySet<number>,
): {
  routesByKey: ReadonlyMap<string, CapabilityRoute>;
  originEndpoints: ReadonlySet<string>;
  destinationEndpoints: ReadonlySet<string>;
  zkMoneyDestination: ZkMoneyDestination | null;
} {
  const routeCounts = new Map<string, number>();
  for (const route of capabilities.routes ?? []) {
    const key = routeKey(route);
    routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
  }

  const validRoutes = (capabilities.routes ?? []).filter((route) => {
    if (routeCounts.get(routeKey(route)) !== 1) return false;
    if (exactToken(origins, route.origin.chainId, route.origin.token) === null) return false;
    if (trustedPrivacyModes(route, stealthChains).length === 0) return false;
    if (route.destination.kind === "chain") {
      return exactToken(destinations, route.destination.chainId, route.destination.token) !== null;
    }
    return exactToken(destinations, ETHEREUM_CHAIN_ID, route.destination.token) !== null;
  });

  const routesByKey = new Map(validRoutes.map((route) => [routeKey(route), route]));

  const originEndpoints = new Set<string>();
  const destinationEndpoints = new Set<string>();
  const zkMoneySymbols = new Set<string>();
  for (const route of validRoutes) {
    originEndpoints.add(tokenKey(route.origin.chainId, route.origin.token));
    if (route.destination.kind === "chain") {
      destinationEndpoints.add(tokenKey(route.destination.chainId, route.destination.token));
    } else {
      zkMoneySymbols.add(route.destination.token);
    }
  }

  const zkMoneySymbol = zkMoneySymbols.size === 1 ? [...zkMoneySymbols][0] : undefined;
  const zkMoneyToken =
    zkMoneySymbol === undefined
      ? null
      : (destinations.get(ETHEREUM_CHAIN_ID)?.get(zkMoneySymbol) ?? null);

  return {
    routesByKey,
    originEndpoints,
    destinationEndpoints,
    zkMoneyDestination: zkMoneyToken === null ? null : { kind: "zk_money", token: zkMoneyToken },
  };
}

function advertisedTokens(
  chainIds: readonly SelectableChainId[],
  candidates: ValidatedTokens,
  endpoints: ReadonlySet<string>,
): ReadonlyMap<SelectableChainId, readonly RouteToken[]> {
  const result = new Map<SelectableChainId, readonly RouteToken[]>();
  for (const chainId of chainIds) {
    const tokens = [...(candidates.get(chainId)?.values() ?? [])].filter((token) =>
      endpoints.has(tokenKey(chainId, token.symbol)),
    );
    if (tokens.length > 0) result.set(chainId, tokens);
  }
  return result;
}

function displayTokens(
  chainIds: readonly SelectableChainId[],
  candidates: ValidatedTokens,
): ReadonlyMap<SelectableChainId, readonly RouteToken[]> {
  const result = new Map<SelectableChainId, readonly RouteToken[]>();
  for (const chainId of chainIds) {
    const tokens = [...(candidates.get(chainId)?.values() ?? [])];
    if (tokens.length > 0) result.set(chainId, tokens);
  }
  return result;
}

/**
 * Resolve the complete trade surface from one capability snapshot. Capability
 * addresses, decimals, typed routes and privacy modes are authoritative. Static
 * token data supplies display metadata only and never grants an endpoint.
 * Bridged USDC is accepted as payment, but never offered as a payout token.
 */
export function resolveRouteModel(
  capabilities: SolverCapabilities,
  state: CapabilityState,
  options: RouteModelOptions,
): ResolvedRouteModel {
  const candidateOriginChains = uniqueChainIds(capabilities, "origin", options);
  const candidateDestinationChains = uniqueChainIds(capabilities, "destination", options);
  const candidateOrigins = validatedTokensByChain(
    candidateOriginChains,
    capabilities,
    "origin",
    options,
  );
  const candidateDestinations = validatedTokensByChain(
    candidateDestinationChains,
    capabilities,
    "destination",
    options,
  );
  const stealthChains = new Set<number>(stealthDestinationChains(capabilities));
  const inventory = routeInventories(
    capabilities,
    candidateOrigins,
    candidateDestinations,
    stealthChains,
  );
  const showUnconfirmedMetadata = state !== "live" && capabilities.routes === null;
  const origins = showUnconfirmedMetadata
    ? displayTokens(candidateOriginChains, candidateOrigins)
    : advertisedTokens(candidateOriginChains, candidateOrigins, inventory.originEndpoints);
  const destinations = showUnconfirmedMetadata
    ? displayTokens(candidateDestinationChains, candidateDestinations)
    : advertisedTokens(
        candidateDestinationChains,
        candidateDestinations,
        inventory.destinationEndpoints,
      );
  const routesByKey = inventory.routesByKey;

  const resolve = (
    origin: RouteLeg,
    destination: ExecutableRouteDestination,
  ): ResolvedRouteAvailability => {
    if (state !== "live" || capabilities.routes === null) {
      return { status: "unknown", reason: ROUTES_NOT_LOADED };
    }
    if (!containsExactToken(origins.get(origin.chainId) ?? [], origin.token)) {
      return {
        status: "unavailable",
        reason: `${origin.token.symbol} cannot be sent from this chain.`,
      };
    }
    if (destination.kind === "zk_money") {
      if (
        inventory.zkMoneyDestination === null ||
        !sameToken(inventory.zkMoneyDestination.token, destination.token)
      ) {
        return { status: "unavailable", reason: "zk.money is not advertised." };
      }
    } else if (
      !containsExactToken(destinations.get(destination.chainId) ?? [], destination.token)
    ) {
      return {
        status: "unavailable",
        reason: `${destination.token.symbol} cannot be received on this chain.`,
      };
    }

    const exact = routesByKey.get(queryKey(origin, destination));
    if (exact === undefined) {
      return { status: "unavailable", reason: "This exact route is not advertised." };
    }
    const privacyModes = trustedPrivacyModes(exact, stealthChains);
    if (privacyModes.length === 0) {
      return { status: "unavailable", reason: "This route has no available privacy mode." };
    }
    return { status: "available", privacyModes };
  };

  return {
    state,
    originChainIds: [...origins.keys()],
    destinationChainIds: [...destinations.keys()],
    originTokens: origins,
    destinationTokens: destinations,
    zkMoneyDestination: inventory.zkMoneyDestination,
    resolve,
  };
}
