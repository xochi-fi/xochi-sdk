/**
 * Quote request validation.
 *
 * Composable validation functions using functional patterns. Each validator
 * returns a Result type that can be combined. Pure: the deadline check takes
 * the clock as an argument, so the machine validates against the same `now`
 * that stamped the request.
 */

import type { SelectableChainId } from "../shared/index.js";
import {
  isChainId,
  isTronChainId,
  isSettlementType,
  ETH_ADDRESS_REGEX,
  ZERO_ADDRESS,
  ETH_ADDRESS_LENGTH,
  MAX_DEADLINE_OFFSET_SEC,
  MAX_SLIPPAGE_PERCENT,
  MAX_SLIPPAGE_BPS,
  isValidTronAddress,
} from "../shared/index.js";
import type { QuoteRequest } from "./wire.js";

// ============================================================
// Result Type and Combinators
// ============================================================

type ValidationResult = { ok: true } | { ok: false; error: string };

const err = (error: string): ValidationResult => ({ ok: false, error });
const okVoid: ValidationResult = { ok: true };

type Validator<T> = (value: T) => ValidationResult;

/** Chain validators: short-circuit on first error */
const chain =
  <T>(...validators: Validator<T>[]): Validator<T> =>
  (value: T) => {
    for (const v of validators) {
      const result = v(value);
      if (!result.ok) return result;
    }
    return okVoid;
  };

const notEmpty: Validator<string> = (s) => (s && s.trim() !== "" ? okVoid : err("Required"));

const matchesRegex =
  (regex: RegExp, message: string): Validator<string> =>
  (s) =>
    regex.test(s) ? okVoid : err(message);

const notEqual =
  <T>(forbidden: T, message: string): Validator<T> =>
  (v) =>
    v !== forbidden ? okVoid : err(message);

// ============================================================
// Address Validators
// ============================================================

const startsWithHex: Validator<string> = (s) =>
  s.startsWith("0x") ? okVoid : err("Must start with 0x");

const hasCorrectLength: Validator<string> = (s) =>
  s.length === ETH_ADDRESS_LENGTH ? okVoid : err(`Must be ${ETH_ADDRESS_LENGTH} characters`);

const hasValidHexChars: Validator<string> = matchesRegex(
  ETH_ADDRESS_REGEX,
  "Contains invalid characters",
);

const notZeroAddress: Validator<string> = notEqual(ZERO_ADDRESS, "Zero address is not allowed");

const validateAddress: Validator<string> = chain(
  notEmpty,
  startsWithHex,
  hasCorrectLength,
  hasValidHexChars,
  notZeroAddress,
);

const validateTokenAddress: Validator<string> = chain(
  validateAddress,
  notEqual(ZERO_ADDRESS, "Use wrapped token address (WETH)"),
);

const errorOf = (result: ValidationResult): string => (result.ok ? "" : result.error);

// ============================================================
// Swap Parameter Validation
// ============================================================

export interface SwapValidationResult {
  isValid: boolean;
  errors: string[];
}

// Individual field validators as simple functions
const validateWallet = (wallet: string | undefined): string[] =>
  !wallet
    ? ["Wallet is required"]
    : !validateAddress(wallet).ok
      ? [`Wallet: ${errorOf(validateAddress(wallet))}`]
      : [];

// Origin may be a non-EVM chain (Tron deposit route) as well as EVM.
const validateFromChain = (chainId: SelectableChainId | undefined): string[] =>
  chainId === undefined
    ? ["Source chain is required"]
    : !isChainId(chainId) && !isTronChainId(chainId)
      ? ["Invalid source chain"]
      : [];

// Destination may be a non-EVM chain (Tron); the origin stays EVM.
const validateToChain = (chainId: SelectableChainId | undefined): string[] =>
  chainId === undefined
    ? ["Destination chain is required"]
    : !isChainId(chainId) && !isTronChainId(chainId)
      ? ["Invalid destination chain"]
      : [];

// The source token can be a Tron TRC-20 (base58) on a Tron-origin deposit route.
const validateFromToken = (token: string | undefined): string[] => {
  if (!token) return ["Source token is required"];
  if (validateTokenAddress(token).ok || isValidTronAddress(token)) return [];
  return [`Source token: ${errorOf(validateTokenAddress(token))}`];
};

// The destination token can be a Tron TRC-20 (base58) on a Tron destination, so
// accept either an EVM token address or a valid Tron address.
const validateToToken = (token: string | undefined): string[] => {
  if (!token) return ["Destination token is required"];
  if (validateTokenAddress(token).ok || isValidTronAddress(token)) return [];
  return [`Destination token: ${errorOf(validateTokenAddress(token))}`];
};

const validateFromAmount = (amount: string | undefined): string[] => {
  if (!amount) return ["Amount is required"];
  try {
    const bigAmount = BigInt(amount);
    return bigAmount > 0n ? [] : ["Amount must be greater than 0"];
  } catch {
    return ["Invalid amount format"];
  }
};

const validateDeadline = (deadline: number | undefined, nowMs: number): string[] => {
  if (deadline === undefined) return ["Deadline is required"];
  const now = Math.floor(nowMs / 1000);
  if (deadline <= now) return ["Deadline must be in the future"];
  if (deadline > now + MAX_DEADLINE_OFFSET_SEC) return ["Deadline cannot exceed 1 hour"];
  return [];
};

const validateSlippageBps = (bps: number | undefined): string[] =>
  bps === undefined
    ? ["Slippage tolerance is required"]
    : bps < 1
      ? ["Slippage must be at least 0.01%"]
      : bps > MAX_SLIPPAGE_BPS
        ? [`Slippage cannot exceed ${MAX_SLIPPAGE_PERCENT}%`]
        : [];

const validateSettlement = (pref: string | undefined): string[] =>
  !pref
    ? ["Settlement preference is required"]
    : !isSettlementType(pref)
      ? ["Invalid settlement preference"]
      : [];

/**
 * The Worker's bound on `ref` and `promo` (its `QuoteRequestSchema`: a string
 * of at most 64). It checks nothing else: a code within it always quotes, with
 * the Worker's verdict on it.
 */
const MAX_QUOTE_CODE_LENGTH = 64;

const validateCode = (code: string | undefined, name: string): string[] =>
  code === undefined || code.length <= MAX_QUOTE_CODE_LENGTH
    ? []
    : [`Invalid ${name} code: at most ${MAX_QUOTE_CODE_LENGTH} characters`];

const validateSameToken = (p: Partial<QuoteRequest>): string[] =>
  p.fromToken &&
  p.toToken &&
  p.fromChainId === p.toChainId &&
  p.fromToken.toLowerCase() === p.toToken.toLowerCase()
    ? ["Cannot swap token to itself"]
    : [];

/** Every reason `params` is not a sendable quote request, judged at `nowMs`. */
export const validateSwapParams = (
  params: Partial<QuoteRequest>,
  nowMs: number,
): SwapValidationResult => {
  const errors = [
    ...(params.preview ? [] : validateWallet(params.wallet)),
    ...validateFromChain(params.fromChainId),
    ...validateToChain(params.toChainId),
    ...validateFromToken(params.fromToken),
    ...validateToToken(params.toToken),
    ...validateFromAmount(params.fromAmount),
    ...validateDeadline(params.deadline, nowMs),
    ...validateSlippageBps(params.slippageBps),
    ...validateSettlement(params.settlementPreference),
    ...validateSameToken(params),
    ...validateCode(params.ref, "referral"),
    ...validateCode(params.promo, "promo"),
  ];
  return { isValid: errors.length === 0, errors };
};
