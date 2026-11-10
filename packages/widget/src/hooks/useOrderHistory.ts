/**
 * useOrderHistory Hook
 *
 * Fetches and manages order (intent) history with functional patterns.
 * Uses Result types and pure transformations.
 */

import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useAccount, useConfig } from "wagmi";
import { getAccount, watchAccount } from "wagmi/actions";
import type { IntentStatus, ChainId, SettlementType } from "../types/intent.js";
import { isOk } from "../types/result.js";
import { apiGet, buildUrl } from "../lib/api.js";
import { intentAPI } from "../lib/intentAPI.js";
import { isSweepablePreDispatch } from "../lib/localActivity.js";
import { CHAIN_NAMES, isSettlementType, isTerminalIntentStatus } from "@xochi/client";
import {
  hasWalletSession,
  getWalletToken,
  getWalletSessionGeneration,
  subscribeWalletSession,
} from "../lib/walletSession.js";
import { swapExplorerLinks } from "../lib/explorerLinks.js";
import { PAGINATION } from "@xochi/client";
import {
  useIntentStatusPoll,
  type StatusPollContext,
  type StatusPollVerdict,
} from "./useIntentStatusPoll.js";

// ============================================================
// Types
// ============================================================

export interface OrderHistoryItem {
  id: string;
  status: IntentStatus;
  fromChainId: ChainId;
  toChainId: ChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string | null;
  tier: string;
  feeRate: number;
  txHash: string | null;
  /** Destination-leg fill hash on to_chain (cross-chain completions only). */
  receivingTxHash: string | null;
  /** Public fill receipt (Riddler #632) + its chain; drives the receipt CTA. */
  settlementTxHash: string | null;
  settlementChainId: ChainId | null;
  /** As the history read serves it; a `failed` row's retry needs `not_executed`. */
  substatus: string | null;
  /** The owner's history serves it; null when absent or not a mode this build models. */
  settlementType: SettlementType | null;
  recipientTag?: string;
  createdAt: string;
  timestamp: number;
  explorerUrl: string | null;
  fromChainName: string;
  toChainName: string;
  isCrossChain: boolean;
}

export interface UseOrderHistoryReturn {
  orders: OrderHistoryItem[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  hasMore: boolean;
  loadMore: () => void;
  /**
   * True when a wallet is connected but there is no wallet-bound session yet, so
   * server history can't be loaded. The UI shows a "Sign in to view" affordance
   * rather than prompting a signature automatically.
   */
  needsSignIn: boolean;
}

// ============================================================
// Pure Data Transformations
// ============================================================

const getChainName = (chainId: ChainId): string => CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

// A completed cross-chain order's meaningful link is the fill on the DESTINATION
// chain (Blockscout for Robinhood, Arbiscan for Arbitrum, ...), not the source
// deposit. Fall back to the deposit leg when there is no fill hash yet (order
// still in flight, or a same-chain swap with a single leg). Uses the shared
// explorer registry so chain coverage never drifts from a local copy.
const pickExplorerUrl = (
  fromChainId: ChainId,
  toChainId: ChainId,
  txHash: string | null,
  receivingTxHash: string | null,
  settlementTxHash: string | null,
  settlementChainId: ChainId | null,
  isRefunded = false,
): string | null => {
  const { source, destination } = swapExplorerLinks({
    fromChainId,
    toChainId,
    txHash,
    receivingTxHash,
    settlementTxHash,
    settlementChainId,
    isRefunded,
  });
  return destination ?? source;
};

// Transform API response to OrderHistoryItem.
//
// The worker's GET /api/intent/history returns snake_case fields (from_token,
// from_chain_id, created_at, ...). This mapper previously read camelCase, so
// every field was undefined and the feed crashed downstream on the missing
// token address. It was latent because history only loads once a wallet session
// exists (previously gated off for wallet-only users).
export const toOrderHistoryItem = (record: Record<string, unknown>): OrderHistoryItem => {
  const fromChainId = record.from_chain_id as ChainId;
  const toChainId = record.to_chain_id as ChainId;
  const txHash = (record.tx_hash as string | null) ?? null;
  const receivingTxHash = (record.receiving_tx_hash as string | null) ?? null;
  const settlementTxHash = (record.settlement_tx_hash as string | null) ?? null;
  const settlementChainId = (record.settlement_chain_id as ChainId | null) ?? null;
  const createdAt = record.created_at as string;

  return {
    id: record.id as string,
    status: record.status as IntentStatus,
    fromChainId,
    toChainId,
    fromToken: record.from_token as string,
    toToken: record.to_token as string,
    fromAmount: record.from_amount as string,
    toAmount: (record.to_amount as string | null) ?? null,
    tier: record.tier as string,
    feeRate: record.fee_rate as number,
    txHash,
    receivingTxHash,
    settlementTxHash,
    settlementChainId,
    substatus: (record.substatus as string | undefined) ?? null,
    settlementType: isSettlementType(record.settlement_type) ? record.settlement_type : null,
    ...(typeof record.recipient_tag === "string" && { recipientTag: record.recipient_tag }),
    createdAt,
    timestamp: new Date(createdAt).getTime(),
    explorerUrl: pickExplorerUrl(
      fromChainId,
      toChainId,
      txHash,
      receivingTxHash,
      settlementTxHash,
      settlementChainId,
      (record.status as string) === "refunded",
    ),
    fromChainName: getChainName(fromChainId),
    toChainName: getChainName(toChainId),
    isCrossChain: fromChainId !== toChainId,
  };
};

// ============================================================
// API Fetch (Side Effect Boundary)
// ============================================================

const PAGE_SIZE = PAGINATION.defaultPageSize;

interface IntentHistoryResponse {
  intents: Record<string, unknown>[];
}

const fetchOrders = async (
  address: string,
  offset: number,
): Promise<{ ok: boolean; data?: OrderHistoryItem[]; error?: string }> => {
  const url = buildUrl("/api/intent/history", {
    wallet: address,
    limit: PAGE_SIZE,
    offset,
  });
  const result = await apiGet<IntentHistoryResponse>(url);

  if (isOk(result)) {
    const orders = (result.data.intents || []).map(toOrderHistoryItem);
    return { ok: true, data: orders };
  }

  console.error("[useOrderHistory]", result.error);
  return { ok: false, error: result.error };
};

// ============================================================
// Hook Implementation
// ============================================================

interface HistoryAuthority {
  wallet: string | undefined;
  token: string | null;
  sessionGeneration: number;
  generation: number;
  revoked: boolean;
}

type State = {
  authority: HistoryAuthority | null;
  orders: OrderHistoryItem[];
  isLoading: boolean;
  error: string | null;
  offset: number;
  hasMore: boolean;
};

const initialState: State = {
  authority: null,
  orders: [],
  isLoading: false,
  error: null,
  offset: 0,
  hasMore: true,
};

interface OrderStatusPatch {
  status: IntentStatus;
  txHash: string | null;
  receivingTxHash: string | null;
  settlementTxHash: string | null;
  settlementChainId: ChainId | null;
  substatus: string | null;
}

type Action =
  | { type: "FETCH_START" }
  | { type: "FETCH_SUCCESS"; orders: OrderHistoryItem[]; reset: boolean }
  | { type: "FETCH_ERROR"; error: string }
  | { type: "PATCH_STATUSES"; updates: Map<string, OrderStatusPatch> };

// Apply one poll result to a row, returning the SAME row when it changes
// nothing. A null field means "no answer yet", never "clear it", so it falls
// back to what the row already holds.
//
// Identity is the change signal, and it has two readers that must agree: the
// reducer skips rebuilding the list, and the poll reports `"progress"` (which
// refills the give-up budget) only for rows this actually moves. Deciding
// "changed" from the presence of a poll result instead would call every tick
// progress, since a stuck row is re-reported verbatim forever, and restore the
// unbounded poll the ceiling exists to remove.
const applyOrderPatch = (o: OrderHistoryItem, u: OrderStatusPatch): OrderHistoryItem => {
  const txHash = u.txHash ?? o.txHash;
  const receivingTxHash = u.receivingTxHash ?? o.receivingTxHash;
  const settlementTxHash = u.settlementTxHash ?? o.settlementTxHash;
  const settlementChainId = u.settlementChainId ?? o.settlementChainId;
  const substatus = u.substatus ?? o.substatus;
  if (
    u.status === o.status &&
    txHash === o.txHash &&
    receivingTxHash === o.receivingTxHash &&
    settlementTxHash === o.settlementTxHash &&
    settlementChainId === o.settlementChainId &&
    substatus === o.substatus
  ) {
    return o;
  }
  return {
    ...o,
    status: u.status,
    txHash,
    receivingTxHash,
    settlementTxHash,
    settlementChainId,
    substatus,
    explorerUrl: pickExplorerUrl(
      o.fromChainId,
      o.toChainId,
      txHash,
      receivingTxHash,
      settlementTxHash,
      settlementChainId,
      u.status === "refunded",
    ),
  };
};

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, isLoading: true, error: null };
    case "FETCH_SUCCESS":
      return {
        ...state,
        isLoading: false,
        orders: action.reset ? action.orders : [...state.orders, ...action.orders],
        offset: action.reset ? PAGE_SIZE : state.offset + PAGE_SIZE,
        hasMore: action.orders.length === PAGE_SIZE,
      };
    case "FETCH_ERROR":
      return { ...state, isLoading: false, error: action.error };
    case "PATCH_STATUSES": {
      // Advance non-terminal server rows from a public per-intent status poll,
      // in place (server history itself only fetches once). Only rebuild when a
      // row actually changed so the feed doesn't re-render on every idle tick.
      let changed = false;
      const orders = state.orders.map((o) => {
        const u = action.updates.get(o.id);
        if (!u) return o;
        const next = applyOrderPatch(o, u);
        if (next !== o) changed = true;
        return next;
      });
      return changed ? { ...state, orders } : state;
    }
    default:
      return state;
  }
};

export function useOrderHistory(): UseOrderHistoryReturn {
  const { address } = useAccount();
  const config = useConfig();
  const sessionGeneration = useSyncExternalStore(
    subscribeWalletSession,
    getWalletSessionGeneration,
    getWalletSessionGeneration,
  );
  const wallet = address?.toLowerCase();
  const token = wallet && hasWalletSession(wallet) ? getWalletToken() : null;
  const authorityRef = useRef<HistoryAuthority | null>(null);
  if (
    !authorityRef.current ||
    authorityRef.current.revoked ||
    authorityRef.current.wallet !== wallet ||
    authorityRef.current.token !== token ||
    authorityRef.current.sessionGeneration !== sessionGeneration
  ) {
    authorityRef.current = {
      wallet,
      token,
      sessionGeneration,
      generation: (authorityRef.current?.generation ?? 0) + 1,
      revoked: false,
    };
  }
  const authority = authorityRef.current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = watchAccount(config, {
      onChange: (account) => {
        const current = authorityRef.current;
        if (current && current.wallet !== account.address?.toLowerCase()) current.revoked = true;
      },
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [config]);
  const isCurrentAuthority = useCallback(
    () =>
      mountedRef.current &&
      authorityRef.current === authority &&
      !authority.revoked &&
      !!authority.wallet &&
      !!authority.token &&
      getAccount(config).address?.toLowerCase() === authority.wallet &&
      getWalletSessionGeneration() === authority.sessionGeneration &&
      hasWalletSession(authority.wallet) &&
      getWalletToken() === authority.token,
    [authority, config],
  );
  const [state, dispatch] = useState(initialState);
  // Scope visibility during render, before effects can reset an old wallet's feed.
  const visibleState = state.authority === authority && token ? state : initialState;
  // Latest scoped orders for the status poller; same-owner progress does not re-arm it.
  const ordersRef = useRef(visibleState.orders);
  ordersRef.current = visibleState.orders;
  // Bumped only by the public `refresh`, and part of the status-poll key, so a
  // user can re-arm a poll the give-up ceiling has stopped.
  const [pollEpoch, setPollEpoch] = useState(0);

  const dispatchScoped = useCallback(
    (action: Action) => {
      if (!isCurrentAuthority()) return;
      dispatch((previous) => {
        if (!isCurrentAuthority()) return previous;
        const scoped = previous.authority === authority ? previous : { ...initialState, authority };
        return reducer(scoped, action);
      });
    },
    [authority, isCurrentAuthority],
  );

  const doFetch = useCallback(
    async (reset: boolean) => {
      // Server history is wallet-scoped and ownership-gated. It needs a
      // wallet-bound session (sign-in-with-wallet); without one, show an empty
      // server feed rather than a 403. The swap flow itself is wallet-first and
      // needs no session, and local activity still renders. The UI surfaces a
      // "Sign in to view" affordance via `needsSignIn`.
      if (!authority.wallet || !isCurrentAuthority()) return;

      const currentOffset = reset ? 0 : visibleState.offset;

      dispatchScoped({ type: "FETCH_START" });

      const result = await fetchOrders(authority.wallet, currentOffset);
      if (!isCurrentAuthority()) return;

      if (result.ok && result.data) {
        dispatchScoped({ type: "FETCH_SUCCESS", orders: result.data, reset });
      } else {
        dispatchScoped({ type: "FETCH_ERROR", error: result.error || "Unknown error" });
      }
    },
    [authority, visibleState.offset, dispatchScoped, isCurrentAuthority],
  );

  // A new wallet or wallet-session generation owns a fresh first page.
  useEffect(() => {
    void doFetch(true);
  }, [authority]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server history fetches once; re-poll its non-terminal rows via the public
  // per-intent status endpoint (no Member token) so a Member/agent order that
  // isn't in local storage still advances instead of freezing until manual
  // refresh. The poll reads the latest orders from a ref, so a list change does
  // not re-arm it on every tick.
  //
  // Cadence, the give-up ceiling, the foreground snap-forward and cancellation
  // are `useIntentStatusPoll`'s -- the same poller useIntent and useLocalActivity
  // run. This was an inline `setInterval` with NEITHER a ceiling nor a
  // visibility handler, so a stuck order was polled for the life of the tab, and
  // returning to a backgrounded tab showed a stale feed until the next
  // un-throttled tick (#339, which the other two paths already handled).
  const pendingIds = useMemo(
    () =>
      visibleState.orders
        .filter((o) => !isTerminalIntentStatus(o.status))
        .map((o) => o.id)
        .sort()
        .join(","),
    [visibleState.orders],
  );

  const pollPendingOrders = useCallback(
    async ({ signal }: StatusPollContext): Promise<StatusPollVerdict> => {
      if (!isCurrentAuthority()) return;
      const pending = ordersRef.current.filter((o) => !isTerminalIntentStatus(o.status));
      if (pending.length === 0) return;
      const results = await Promise.all(
        pending.map(async (o) => {
          const s = await intentAPI.getIntentStatus(o.id);
          if (!s) return null; // transient -- retry next tick
          if ("notFound" in s) {
            // Definitive 404: terminalize a swept pre-dispatch order as `expired`
            // so it stops polling. Leave a dispatched order that 404s alone (may be
            // the #170 id overload, could have completed) -- never false-fail it.
            return isSweepablePreDispatch(o.status)
              ? ([
                  o.id,
                  {
                    status: "expired",
                    txHash: null,
                    receivingTxHash: null,
                    settlementTxHash: null,
                    settlementChainId: null,
                    substatus: null,
                  },
                ] as const)
              : null;
          }
          return [
            o.id,
            {
              status: s.status,
              txHash: s.txHash,
              receivingTxHash: s.receivingTxHash,
              settlementTxHash: s.settlementTxHash,
              settlementChainId: (s.settlementChainId ?? null) as ChainId | null,
              substatus: s.substatus,
            },
          ] as const;
        }),
      );
      if (signal.aborted || !isCurrentAuthority()) return;
      // Only rows this actually MOVES are updates. A stuck row is re-reported
      // verbatim every tick, so counting "we got an answer" as an update would
      // report progress forever and the give-up ceiling would never fire.
      const current = new Map(ordersRef.current.map((o) => [o.id, o]));
      const updates = new Map(
        results
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .filter(([id, patch]) => {
            const row = current.get(id);
            return !row || applyOrderPatch(row, patch) !== row;
          }),
      );
      if (updates.size === 0) return;
      dispatchScoped({ type: "PATCH_STATUSES", updates });
      // Observable progress refills the give-up budget, so a feed whose rows
      // keep advancing is never frozen mid-swap by the ceiling.
      return "progress";
    },
    [dispatchScoped, isCurrentAuthority],
  );

  useIntentStatusPoll({
    active: !!token && pendingIds.length > 0,
    // The pending SET plus the refresh epoch. The set alone does NOT track
    // progress -- a row advancing executing -> bridging leaves the same set --
    // so it is `"progress"` above that restores the budget; this key only
    // re-arms for new work and for a user-initiated refresh. Re-arming also
    // re-polls immediately, which buys the next hop sooner.
    key: `${authority.generation}|${pendingIds}|${pollEpoch}`,
    label: "useOrderHistory",
    onPoll: pollPendingOrders,
  });

  // A user pressing Refresh re-arms an exhausted poll: it bumps the epoch in
  // the key above. Only this path bumps it -- doing it from the automatic poll
  // would re-arm on every tick and restore the unbounded poll.
  const refresh = useCallback(() => {
    if (!isCurrentAuthority()) return Promise.resolve();
    setPollEpoch((n) => n + 1);
    return doFetch(true);
  }, [doFetch, isCurrentAuthority]);
  const loadMore = useCallback(() => {
    if (!visibleState.isLoading && visibleState.hasMore) {
      void doFetch(false);
    }
  }, [doFetch, visibleState.isLoading, visibleState.hasMore]);

  return {
    orders: visibleState.orders,
    isLoading: visibleState.isLoading,
    error: visibleState.error,
    refresh,
    hasMore: visibleState.hasMore,
    loadMore,
    needsSignIn: !!address && !token,
  };
}
