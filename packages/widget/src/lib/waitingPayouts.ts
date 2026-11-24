/**
 * What the server says is waiting to be claimed, in words a person can act on
 * before any key is unlocked: "4.98 DAI waiting on Base".
 *
 * Built only from data the client already holds: the wallet's claimable
 * settlement rows and its own activity (for the destination chain, which the
 * rows do not carry). Nothing here is sent anywhere.
 */

import { CHAIN_NAMES, TOKENS, getTokenInfoForChain, type ChainId } from "@xochi/client";
import { formatTokenAmount } from "../utils/format.js";

/** One claimable settlement row, reduced to what the summary reads. */
export interface ClaimableSettlement {
  intentId: string | null;
  /** Token address the payout is in. */
  token: string | null;
  /** Payout in base units. */
  amount: string | null;
}

/** A waiting payout: its formatted amount and chain when both are knowable. */
export type WaitingPayout =
  | { kind: "known"; amount: string; chainName: string }
  | { kind: "unknown" };

/** The destination chain of each intent this wallet has on record. */
export type IntentChains = ReadonlyMap<string, number>;

const BASE_UNITS = /^\d+$/;

/** The one chain whose registry lists `token`, or null when none or several do. */
function chainOfToken(token: string): number | null {
  const normalized = token.toLowerCase();
  const chains = Object.entries(TOKENS)
    .filter(([, tokens]) => tokens.some((t) => t.address.toLowerCase() === normalized))
    .map(([id]) => Number(id));
  return chains.length === 1 ? chains[0] : null;
}

export function waitingPayouts(
  claimable: readonly ClaimableSettlement[],
  intentChains: IntentChains,
): WaitingPayout[] {
  return claimable.map((row): WaitingPayout => {
    if (!row.token || !row.amount || !BASE_UNITS.test(row.amount)) return { kind: "unknown" };
    const chainId =
      (row.intentId ? intentChains.get(row.intentId) : undefined) ?? chainOfToken(row.token);
    if (chainId === null) return { kind: "unknown" };
    const info = getTokenInfoForChain(row.token, chainId);
    const chainName = CHAIN_NAMES[chainId as ChainId];
    if (!info || !chainName) return { kind: "unknown" };
    return {
      kind: "known",
      amount: `${formatTokenAmount(BigInt(row.amount), info.decimals, info.decimals)} ${info.symbol}`,
      chainName,
    };
  });
}

/**
 * "4.98 DAI waiting on Base", "4.98 DAI on Base and 10 USDC on Arbitrum
 * waiting", or a count when any amount is unknown. Null when nothing waits.
 */
export function describeWaiting(payouts: readonly WaitingPayout[]): string | null {
  if (payouts.length === 0) return null;
  const known = payouts.flatMap((p) => (p.kind === "known" ? [p] : []));
  if (known.length !== payouts.length || known.length > 3) {
    return `${payouts.length} ${payouts.length === 1 ? "payment" : "payments"} waiting`;
  }
  if (known.length === 1) return `${known[0].amount} waiting on ${known[0].chainName}`;
  const parts = known.map((p) => `${p.amount} on ${p.chainName}`);
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} waiting`;
}
