/**
 * The Send tab's `address` destination: a public ERC-20 transfer from the
 * connected wallet to a wallet address on the same chain.
 *
 * Pure checks, so the panel and its tests share one definition of "this send
 * may go to review". Every amount is atomic-unit `bigint`; the typed string is
 * parsed once, with the token's own decimals, and never through a float.
 *
 * The chains offered are the wallet's EVM chains that this build has token
 * metadata for, so the recipient is always validated as an EVM address for the
 * chain the transfer executes on (checksum included, zero address refused).
 */

import { getAddress, type Address } from "viem";
import { CHAIN_NAMES, TOKENS as CLIENT_TOKENS, validateAddressForVm } from "@xochi/client";
import { parseTokenAmount } from "../../utils/format.js";
import type { Token } from "../../types/intent.js";

/** Chains that have ERC-20 metadata in this build, keyed for the Send picker. */
const SEND_TOKENS: Readonly<Record<number, readonly Token[]>> = Object.fromEntries(
  Object.entries(CLIENT_TOKENS).map(([chainId, tokens]) => [
    Number(chainId),
    tokens.map((token) => ({ ...token, chainId: Number(chainId) as Token["chainId"] })),
  ]),
);

/** The ERC-20s a send on `chainId` can move. */
export function sendTokens(chainId: number): readonly Token[] {
  return SEND_TOKENS[chainId] ?? [];
}

/** The asset a new send starts on: USDC where the chain has it, else its first token. */
export function defaultSendToken(chainId: number): Token | undefined {
  const tokens = sendTokens(chainId);
  return tokens.find((t) => t.symbol === "USDC") ?? tokens[0];
}

/** Of the wallet's configured chains, those a send can execute on, in that order. */
export function sendChainIds(configured: readonly number[]): number[] {
  return configured.filter((id) => sendTokens(id).length > 0);
}

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId as keyof typeof CHAIN_NAMES] ?? `Chain ${chainId}`;
}

export interface AddressSendDraft {
  chainId: number;
  tokenAddress: string;
  /** As typed. */
  amount: string;
  recipient: string;
}

/** What review shows and what the wallet is asked to sign: nothing else. */
export interface AddressSendOrder {
  chainId: number;
  token: Token;
  amount: bigint;
  recipient: Address;
}

export interface AddressSendErrors {
  asset?: string;
  amount?: string;
  recipient?: string;
}

export type AddressSendCheck =
  | { ok: true; order: AddressSendOrder }
  | { ok: false; errors: AddressSendErrors };

export interface AddressSendContext {
  /** The chains offered (`sendChainIds`). */
  chainIds: readonly number[];
  /** The token's balance in atomic units, or null while unknown. */
  balance: bigint | null;
}

/** The typed amount in atomic units, or why it cannot be sent. */
export function checkSendAmount(
  typed: string,
  token: Token,
  balance: bigint | null,
): { amount: bigint } | { error: string } {
  if (typed.trim() === "") return { error: "Enter an amount" } as const;
  let amount: bigint;
  try {
    amount = parseTokenAmount(typed, token.decimals);
  } catch {
    return {
      error: `Enter an amount in ${token.symbol}, up to ${token.decimals} decimals`,
    } as const;
  }
  if (amount <= 0n) return { error: "Enter an amount above zero" } as const;
  if (balance !== null && amount > balance) {
    return { error: `More than your ${token.symbol} balance` } as const;
  }
  return { amount } as const;
}

function recipientError(draft: AddressSendDraft, token: Token) {
  const trimmed = draft.recipient.trim();
  if (trimmed === "") return { error: "Enter the recipient's address" } as const;
  const check = validateAddressForVm(trimmed, "evm");
  if (!check.valid) {
    return {
      error: `${check.error ?? "Invalid address"}. Enter an address on ${chainName(draft.chainId)}.`,
    } as const;
  }
  const recipient = getAddress(trimmed);
  // Tokens sent to their own contract are unrecoverable on most ERC-20s.
  if (recipient === getAddress(token.address)) {
    return { error: `That is the ${token.symbol} contract, not a wallet` } as const;
  }
  return { recipient } as const;
}

/** Whether the draft may go to review, with one message per field that may not. */
export function checkAddressSend(
  draft: AddressSendDraft,
  context: AddressSendContext,
): AddressSendCheck {
  const token = context.chainIds.includes(draft.chainId)
    ? sendTokens(draft.chainId).find(
        (t) => t.address.toLowerCase() === draft.tokenAddress.toLowerCase(),
      )
    : undefined;
  if (!token) return { ok: false, errors: { asset: "Choose an asset to send" } };

  const amount = checkSendAmount(draft.amount, token, context.balance);
  const recipient = recipientError(draft, token);
  if ("error" in amount || "error" in recipient) {
    return {
      ok: false,
      errors: {
        ...("error" in amount && { amount: amount.error }),
        ...("error" in recipient && { recipient: recipient.error }),
      },
    };
  }
  return {
    ok: true,
    order: {
      chainId: draft.chainId,
      token,
      amount: amount.amount,
      recipient: recipient.recipient,
    },
  };
}

export function defaultSendChain(chainIds: readonly number[], preferred?: number): number {
  if (preferred !== undefined && chainIds.includes(preferred)) return preferred;
  return chainIds.includes(8453) ? 8453 : (chainIds[0] ?? 0);
}
