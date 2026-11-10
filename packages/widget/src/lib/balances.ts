/**
 * Public balance types + pure helpers.
 *
 * Kept separate from the wagmi hook (usePublicBalances) so the aggregation and
 * lookup logic is unit-testable without a wallet/provider.
 */

import { SUPPORTED_CHAIN_IDS, TOKENS, isChainId, type ChainId } from "@xochi/client";
import type { SolverCapabilities } from "@xochi/signer";

/** A single token balance on a single chain (raw, native units). */
export interface PublicBalance {
  chainId: number;
  /** ERC20 contract address, or "native" for the chain's gas token. */
  address: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  isNative: boolean;
  /**
   * Set when the read has not succeeded (pending or failed). `balance` is then
   * 0n and means UNKNOWN, not an empty wallet. Absent on a successful read.
   */
  unread?: true;
}

/** A token's balance summed across chains, with a nonzero per-chain breakdown. */
export interface AggregatedHolding {
  symbol: string;
  decimals: number;
  amount: number;
  perChain: { chainId: number; amount: number }[];
}

export interface PublicBalanceToken {
  chainId: ChainId;
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Wallet discovery is independent of executable routes. Keep known public
 * assets, and include newly advertised deployments with explicit precision.
 * Registry metadata wins for a known chain/address (notably Arc's 6-decimal
 * ERC-20 view of native USDC).
 */
export function publicBalanceTokens(
  capabilities?: Pick<SolverCapabilities, "tokens">,
): PublicBalanceToken[] {
  const tokens = new Map<string, PublicBalanceToken>();
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    for (const token of TOKENS[chainId]) {
      tokens.set(`${chainId}:${token.address.toLowerCase()}`, { chainId, ...token });
    }
  }
  for (const token of capabilities?.tokens ?? []) {
    if (
      token.decimals === null ||
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 255
    ) {
      continue;
    }
    for (const [id, address] of Object.entries(token.addresses)) {
      const chainId = Number(id);
      if (!isChainId(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
      const tokenKey = `${chainId}:${address.toLowerCase()}`;
      if (!tokens.has(tokenKey)) {
        tokens.set(tokenKey, {
          chainId,
          address,
          symbol: token.symbol,
          decimals: token.decimals,
        });
      }
    }
  }
  return [...tokens.values()];
}

/** Preserve a failed or pending read as unknown, not a genuine empty balance. */
export function erc20Balances(
  tokens: readonly PublicBalanceToken[],
  results:
    | readonly ({ status: "success"; result: bigint } | { status: "failure"; error?: unknown })[]
    | undefined,
): PublicBalance[] {
  return tokens.map((token, index) => {
    const result = results?.[index];
    return {
      ...token,
      balance: result?.status === "success" ? result.result : 0n,
      isNative: false,
      ...(result?.status === "success" ? {} : { unread: true as const }),
    };
  });
}

/**
 * May the panel state the connected wallet's balance for the RECEIVING leg?
 *
 * The receiving header says "you hold", so it may only be shown when the payout
 * actually lands in the connected wallet. Two cases where it does not, and both
 * have to render "--" rather than a number:
 *
 *  - a non-EVM destination pays an address the user typed. That address's
 *    balance is a real and useful fact, but it is somebody's balance, not
 *    necessarily the user's, and the recipient field already states it in those
 *    words. Putting it in the header would attribute it to the user.
 *  - no wallet is connected, so there is nothing to read.
 *
 * A predicate rather than an inline condition because the distinction it draws
 * is between "unknown" and "zero". Reporting a chain never read as empty does
 * not throw or look broken: it prints a confident 0.00 next to somebody else's
 * money.
 */
export function showsWalletDestinationBalance(
  isConnected: boolean,
  isNonEvmDestination: boolean,
  toChainId: number,
): boolean {
  return isConnected && !isNonEvmDestination && isChainId(toChainId);
}

/** Convert a raw balance to human units. */
export function toAmount(balance: bigint, decimals: number): number {
  return Number(balance) / 10 ** decimals;
}

/**
 * The balance as a fact, or null when it is not one: no entry for the token, or
 * a read that is pending or failed. Every displayed balance and offered amount
 * uses this distinction; an unread wallet is not an empty wallet.
 */
export function readBalance(
  balances: PublicBalance[],
  chainId: number,
  address: string,
): bigint | null {
  const a = address.toLowerCase();
  const entry = balances.find((b) => b.chainId === chainId && b.address.toLowerCase() === a);
  return entry === undefined || entry.unread ? null : entry.balance;
}

/**
 * Aggregate balances by symbol (e.g. total USDC across chains) with a nonzero
 * per-chain breakdown, sorted by amount descending.
 */
export function aggregateBySymbol(balances: PublicBalance[]): AggregatedHolding[] {
  const bySymbol = new Map<string, AggregatedHolding>();
  for (const b of balances) {
    if (b.unread) continue;
    const amount = toAmount(b.balance, b.decimals);
    let agg = bySymbol.get(b.symbol);
    if (!agg) {
      agg = { symbol: b.symbol, decimals: b.decimals, amount: 0, perChain: [] };
      bySymbol.set(b.symbol, agg);
    }
    agg.amount += amount;
    if (b.balance > 0n) agg.perChain.push({ chainId: b.chainId, amount });
  }
  return [...bySymbol.values()].sort((x, y) => y.amount - x.amount);
}

/** Symbol used for USD pricing: WETH is priced as ETH. */
export function pricingSymbol(symbol: string): string {
  return symbol === "WETH" ? "ETH" : symbol;
}
