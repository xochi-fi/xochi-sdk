/**
 * Explorer links for a swap's two legs.
 *
 * A cross-chain swap settles on two chains: the deposit (source) leg sits on
 * `from_chain`, the fill (destination) leg on `to_chain`. Each hash must link to
 * the explorer of the chain it is actually on. `getExplorerTxUrl` builds the URL
 * for a given chain; this helper picks the right chain per leg so the two never
 * cross (the fill hash must not point at the source explorer, and vice versa).
 */

import { getExplorerTxUrl, isSelectableChainId } from "@xochi/client";
import type { SelectableChainId } from "../types/intent.js";

/**
 * Legacy fallback: infer the chain the primary settlement hash (`tx_hash`) lives
 * on, for records that predate Riddler #632's explicit `settlementChainId`.
 *
 * Riddler reported a cross-chain settlement as the DESTINATION fill and put that
 * hash in `tx_hash` (leaving `receiving_tx_hash` null), so by default `tx_hash`
 * is on `toChainId`, not the origin -- linking it to `fromChainId` produced the
 * wrong-chain explorer URL (a Base link for an Ethereum fill). Two cases move it
 * back to the origin: a refund (funds return to where they came from), and the
 * case where Riddler ALSO returns an explicit `receivingTxHash` -- then that fill
 * hash carries the destination and `tx_hash` is the origin deposit. Generic so
 * callers can pass `ChainId` or `SelectableChainId`. Prefer `settlementChainId`
 * (explicit, no inference) whenever it is available.
 */
export function settlementTxChainId<T>(
  fromChainId: T,
  toChainId: T,
  receivingTxHash: string | null | undefined,
  isRefunded = false,
): T {
  return isRefunded || receivingTxHash ? fromChainId : toChainId;
}

export interface SwapExplorerLinkInput {
  /**
   * Selectable, not EVM-only. `getExplorerTxUrl` has always accepted a Tron id
   * and the settlement branch below already narrows with `isSelectableChainId`;
   * the leg types were the only thing that could not express a Tron leg, which
   * is what kept Tron swaps out of the activity feed entirely.
   */
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  /** Primary settlement hash. Its chain is resolved by `settlementTxChainId`. */
  txHash: string | null;
  /** Fill/destination leg hash, on `toChainId` (cross-chain only). */
  receivingTxHash?: string | null;
  /**
   * Public destination fill receipt (Riddler #632). When present it is the
   * authoritative destination link on an explicit chain (`settlementChainId`), so
   * no source/dest inference is needed -- this is the common public cross-chain
   * fill the legacy heuristic missed (it required `receivingTxHash`, which Riddler
   * leaves null for public fills).
   */
  settlementTxHash?: string | null;
  /** Explicit chain the settlement receipt lives on (Riddler #632). */
  settlementChainId?: SelectableChainId | null;
  /** True for a refunded order: the settlement tx is on `fromChainId`. */
  isRefunded?: boolean;
}

export interface SwapExplorerLinks {
  /** Deposit-leg link on the source chain (null when no deposit hash). */
  source: string | null;
  /**
   * Fill-leg link on the destination chain. Present only for a cross-chain swap
   * that has a recorded fill hash; a same-chain swap has no second leg, so this
   * stays null and the caller renders no extra link.
   */
  destination: string | null;
}

export function swapExplorerLinks(input: SwapExplorerLinkInput): SwapExplorerLinks {
  // Riddler #632 authoritative path: the fill receipt is on an explicit chain, so
  // link it directly -- no inference. Skipped for refunds (a refund is not a
  // settlement; its tx is on the origin chain, handled by the legacy branch) and
  // for a chain the UI can't render (Riddler adds chains on its own cadence) --
  // an unknown id falls through to inference instead of a dead `href=""`.
  if (input.settlementTxHash && isSelectableChainId(input.settlementChainId) && !input.isRefunded) {
    const destination = getExplorerTxUrl(input.settlementChainId, input.settlementTxHash);
    // Origin deposit leg, only when it is a distinct hash from the receipt.
    const source =
      input.txHash && input.txHash !== input.settlementTxHash
        ? getExplorerTxUrl(input.fromChainId, input.txHash)
        : null;
    return { source, destination };
  }
  // Legacy fallback: pre-#632 records (no receipt) and refunds. Infer the
  // settlement chain from `receivingTxHash` presence.
  const settleChain = settlementTxChainId(
    input.fromChainId,
    input.toChainId,
    input.receivingTxHash,
    input.isRefunded,
  );
  const source = input.txHash ? getExplorerTxUrl(settleChain, input.txHash) : null;
  const destination =
    input.receivingTxHash && input.toChainId !== input.fromChainId
      ? getExplorerTxUrl(input.toChainId, input.receivingTxHash)
      : null;
  return { source, destination };
}
