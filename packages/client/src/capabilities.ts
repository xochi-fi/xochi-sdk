// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import {
  chainVmType,
  stealthFactoryFor,
  type SolverCapabilities,
  type TokenCapability,
  type VmType,
} from "@xochi/signer";
import {
  isCantonDestinationChainId,
  isChainId,
  isTronChainId,
  type ChainId,
} from "./shared/chains.js";
import { effectiveStealthChains, TRUSTED_STEALTH_FACTORIES } from "./shared/stealth.js";
import { validateAddressForVm } from "./shared/vmValidation.js";

/**
 * The VM a chain runs, or null when the matrix does not offer it in a VM this
 * client handles: unadvertised, advertised twice, or an unrecognised
 * `vm_type`. Null means refuse; it never falls through to EVM. `cvm` is
 * Canton MainNet's alone (`CANTON_MAINNET_CHAIN_ID`, a destination only), and
 * Canton is only ever `cvm`: a matrix that pairs either with anything else is
 * malformed and refuses. A UI that does not offer Canton keeps it out through
 * `RouteModelOptions.chainEnabledForRole`.
 */
export function capabilityVmType(caps: SolverCapabilities, chainId: number): VmType | null {
  const vm = chainVmType(caps, chainId);
  if (vm === "cvm" || isCantonDestinationChainId(chainId)) {
    return vm === "cvm" && isCantonDestinationChainId(chainId) ? "cvm" : null;
  }
  return vm;
}

/**
 * The caller's static chain list narrowed to the chains the matrix offers,
 * keeping the caller's order. The solver can only remove a chain at runtime,
 * never add one absent from the static registry.
 */
export function renderableDestinationChainIds<T extends number>(
  caps: SolverCapabilities,
  staticChainIds: readonly T[],
): readonly T[] {
  return staticChainIds.filter((chainId) => capabilityVmType(caps, chainId) !== null);
}

const BOTH_ROLES: readonly string[] = ["origin", "destination"];

/**
 * A token's roles. The wire requires `roles`; a token served without a
 * recognised one reads as both, as this widget always has.
 */
function tokenRoles(token: TokenCapability): readonly string[] {
  const roles = token.roles.filter((role) => role === "origin" || role === "destination");
  return roles.length > 0 ? roles : BOTH_ROLES;
}

/** Token symbols the solver can pull on the origin leg. */
export function originTokenSymbols(caps: SolverCapabilities): readonly string[] {
  return caps.tokens.filter((t) => tokenRoles(t).includes("origin")).map((t) => t.symbol);
}

/** Token symbols the solver can deliver on the destination leg. */
export function destinationTokenSymbols(caps: SolverCapabilities): readonly string[] {
  return caps.tokens.filter((t) => tokenRoles(t).includes("destination")).map((t) => t.symbol);
}

/**
 * The advertised order bounds with an absent bound read as no bound: a minimum
 * of 0 and a maximum of Infinity. The maximum excludes live inventory, so the
 * UI never gates on it.
 */
export function orderBounds(caps: SolverCapabilities): { min: number; max: number } {
  return {
    min: caps.orderBoundsUsd.min ?? 0,
    max: caps.orderBoundsUsd.max ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * The served `stealth_chains`. `undefined` only when the field is absent,
 * which means the list is UNKNOWN: every solver since spec 0.9 (Riddler#1104)
 * sends it, so a matrix without one is the static fallback or a regression,
 * never the pre-#1104 "Ethereum L1 only" rule. A present value that is not a
 * list reads as no chains. The signer reads both as unsaid (`null`), and
 * SPEC.md §6 says nothing of either, so this keeps the widget's narrower
 * reading.
 */
export function servedStealthChains(
  caps: Pick<SolverCapabilities, "stealthChains" | "raw">,
): readonly number[] | undefined {
  if (caps.stealthChains !== null) return caps.stealthChains;
  return caps.raw.stealth_chains === undefined ? undefined : [];
}

/**
 * Validate a recipient address for the destination chain's VM. A chain the
 * matrix does not offer in a VM this widget handles is refused outright: no
 * address format is assumed for it.
 */
export function validateDestinationAddress(
  address: string,
  toChainId: number,
  caps: SolverCapabilities,
): { valid: boolean; error?: string } {
  const vm = capabilityVmType(caps, toChainId);
  if (vm === null) {
    return { valid: false, error: "This destination chain is not currently supported" };
  }
  return validateAddressForVm(address, vm);
}

/**
 * Validate an origin-chain refund address (xochi#358). A refund executes on the
 * ORIGIN chain, so the address must match the origin's VM, not the
 * destination's. Null when there is nothing to complain about (valid, or
 * legitimately absent), otherwise a user-facing message.
 */
export function refundAddressError(
  address: string | undefined,
  fromChainId: number,
  caps: SolverCapabilities,
  required = false,
): string | null {
  const trimmed = (address ?? "").trim();
  if (!trimmed) return required ? "Enter a refund address you control" : null;
  const vm = isTronChainId(fromChainId) ? "tvm" : capabilityVmType(caps, fromChainId);
  if (vm === null) return "This origin chain is not currently supported";
  const result = validateAddressForVm(trimmed, vm);
  return result.valid ? null : (result.error ?? "Invalid refund address");
}

/**
 * Solver-advertised stealth destinations narrowed through the exact served
 * factory and this build's per-chain trusted factory allowlist. Missing,
 * duplicated or untrusted advertisements fail closed.
 */
export function stealthDestinationChains(
  capabilities: SolverCapabilities,
  trusted: Readonly<Record<number, readonly string[]>> = TRUSTED_STEALTH_FACTORIES,
): readonly ChainId[] {
  const served = servedStealthChains(capabilities);
  if (served === undefined) return [];
  return effectiveStealthChains(
    served,
    (chainId) => stealthFactoryFor(capabilities, chainId),
    trusted,
  ).filter(isChainId);
}
