/**
 * Intent Types
 *
 * Type definitions for the cross-chain intent system.
 * Supports Riddler integration and Aztec privacy layer.
 */

// Re-export shared types
export type {
  ChainId,
  ExtendedChainId,
  SelectableChainId,
  IntentStatus,
  SettlementType,
  Eip712TypedData,
  SettlementOption,
} from "@xochi/client";

// The lifecycle's own shapes (quote/execute/status wire types, the intent state)
// live in @xochi/client with the state machine that consumes them, so the
// widget and @xochi/sdk decode one wire contract. Re-exported here because this
// module is the app's type surface, like the shared block above.
export type {
  IntentDestination,
  QuoteResponse,
  IntentWebSocketMessage,
  PaymentMethod,
  RaceWebSocketMessage,
} from "@xochi/client";
export { isRaceWebSocketMessage } from "@xochi/client";
import type { IntentDestination, PaymentMethod } from "@xochi/client";

export { isChainId, isSelectableChainId, canTransitionTo, getStatusLabel } from "@xochi/client";

import type { ExtendedChainId } from "@xochi/client";

/** Default destination: public L1 settlement */
export const DEFAULT_DESTINATION: IntentDestination = {
  type: "chain",
  shielded: false,
};

/** Stealth destination: L1 stealth address */
export const STEALTH_DESTINATION: IntentDestination = {
  type: "stealth",
  shielded: false, // L1, not Aztec shielded
};

export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: ExtendedChainId;
  logoUri?: string;
}

// FeeBreakdown is defined in @xochi/client so the worker, the derive helper,
// and the UI share one definition. Re-exported here for the import path the
// fee-model spec references (docs/planning/economics.md Part 1).
export type { FeeBreakdown } from "@xochi/client";

export interface PaymentMethodInfo {
  method: PaymentMethod;
  label: string;
  description: string;
  gasless: boolean;
}

export const PAYMENT_METHODS: Record<PaymentMethod, PaymentMethodInfo> = {
  erc3009: {
    method: "erc3009",
    label: "Direct Auth",
    description: "Sign once, transfer directly",
    gasless: true,
  },
  permit2: {
    method: "permit2",
    label: "Permit2",
    description: "Universal gasless permit",
    gasless: true,
  },
  pimlico: {
    method: "pimlico",
    label: "Sponsored",
    description: "Gas paid by protocol",
    gasless: true,
  },
  x402: {
    method: "x402",
    label: "Pay-per-call",
    description: "Micropayment for execution",
    gasless: false,
  },
  mpp: {
    method: "mpp",
    label: "Agent Relay",
    description: "Routed via payment agent",
    gasless: true,
  },
  approval: {
    method: "approval",
    label: "Approval",
    description: "On-chain approval (gas required)",
    gasless: false,
  },
  deposit: {
    method: "deposit",
    label: "Deposit",
    description: "Send the tokens manually",
    // The user pays their own origin-chain network fee to make the transfer.
    // Nothing about this route is sponsored, and the connected wallet signs
    // nothing at all.
    gasless: false,
  },
};

/** True when `value` is a known payment method (a key of PAYMENT_METHODS). */
export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && value in PAYMENT_METHODS;
}

/**
 * Resolve the payment method to display for a quote.
 *
 * Prefers the server-supplied method (Riddler's `payment_method`, mapped to
 * `quote.paymentMethod`) because only the solver knows the true settlement path:
 * `x402` (paid, NOT gasless), `mpp` (agent relay), and `approval` (on-chain, NOT
 * gasless) carry no `pull_authorization`, so the permit-type guess below cannot
 * reach them and would mislabel the method AND its gasless promise. The permit +
 * gasless inference is the fallback for older/edge quotes that omit the field.
 * The returned method keys into PAYMENT_METHODS for the label + honest gasless
 * flag, so both are always taken from the resolved method (never `quote.gasless`
 * directly). Shared by QuoteDetails and TransactionPreview so they cannot drift.
 *
 * A DEPOSIT ROUTE OVERRIDES THE SERVER VALUE, which is the one case where the
 * solver's own field is wrong rather than merely unknowable locally. A live
 * Tron-origin quote returns `payment_method: "permit2"` alongside
 * `gasless: false` and a `deposit_address`. Preferring that answer rendered
 * "Permit2 (gasless)" on a route that has no permit, no pull, and no wallet
 * signature of any kind: the user reads a promise to sign something and is then
 * handed an address to send TRC-20 to, at their own network cost. The label also
 * contradicted the same response's `gasless: false`, because PAYMENT_METHODS
 * carries the honest flag per method and `permit2` is gasless.
 *
 * `depositAddress` is the signal, and it is required rather than optional so a
 * new call site cannot silently inherit the mislabel. Its presence alone is
 * sound HERE even though `config.ts` defines a deposit route as the origin
 * chain's VM and this field AGREEING: useIntent enforces that agreement at
 * quote-ingest and discards the quote when they disagree, so a quote that
 * reaches a display component has already passed it.
 */
export function resolvePaymentMethod(
  serverMethod: PaymentMethod | undefined,
  permitType: PermitType | undefined,
  gasless: boolean,
  depositAddress: string | undefined,
): PaymentMethod {
  if (depositAddress) return "deposit";
  if (isPaymentMethod(serverMethod)) return serverMethod;
  if (permitType === "erc3009") return "erc3009";
  if (permitType === "permit2") return "permit2";
  if (permitType === "eip2612") return "permit2"; // similar UX
  if (gasless) return "pimlico"; // gasless without permit = sponsored
  return "approval";
}

/**
 * Whether the origin pull needs an on-chain approval transaction first, read
 * off the wallet's real ERC-20 allowance to the canonical Permit2 (usePermit).
 *
 * - `none`: the pull needs no allowance (ERC-3009, or no EVM pull at all).
 * - `covered`: a Permit2 pull whose allowance already covers the amount.
 * - `required`: a Permit2 pull whose allowance is short, so the first swap
 *   sends a gasful `approve(Permit2)`.
 * - `unknown`: a Permit2 pull whose allowance is not known (loading, failed,
 *   no wallet, or a served domain naming a non-canonical Permit2, which
 *   `ensureApproval` refuses). Never read as either answer.
 */
export type OriginApproval = "none" | "covered" | "required" | "unknown";

/**
 * Whether the payment costs the wallet no gas at all: a gasless method whose
 * pull needs no approval transaction first. Drives the "no gas" claim and its
 * colour, so the two cannot disagree.
 */
export function paysNoGas(method: PaymentMethod, approval: OriginApproval): boolean {
  return PAYMENT_METHODS[method].gasless && (approval === "none" || approval === "covered");
}

// ============================================================
// Permit Types (EIP-2612, ERC-3009, Permit2)
// ============================================================

export type PermitType = "eip2612" | "erc3009" | "permit2" | "none";
