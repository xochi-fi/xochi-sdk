/**
 * useLocalActivity Hook
 *
 * Surfaces the connected wallet's local-first swap log (see lib/localActivity)
 * and keeps non-terminal records fresh by polling the public per-intent status
 * endpoint -- no Member token required. This is what makes the activity feed
 * populate for wallet-only users right after they trade.
 *
 * While any record is in flight it polls on an interval, so a swap keeps
 * advancing in the feed even after the user closes the flow modal on the
 * "safe to close" screen. A record crossing into `completed` fires onComplete.
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { useAccount } from "wagmi";
import { intentAPI } from "../lib/intentAPI.js";
import {
  listLocalSwaps,
  upsertLocalSwap,
  subscribeLocalActivity,
  isSameWallet,
  refreshLocalSwaps,
  reconcileLocalSwap,
} from "../lib/localActivity.js";
import { isTerminalIntentStatus } from "@xochi/client";
import { useIntentStatusPoll, type StatusPollVerdict } from "./useIntentStatusPoll.js";
import type { SwapActivityItem } from "../types/activity.js";

export interface UseLocalActivityOptions {
  /** Called once when a record crosses from in-flight into `completed`. */
  onComplete?: (item: SwapActivityItem) => void;
}

export interface UseLocalActivityReturn {
  swaps: SwapActivityItem[];
  refresh: () => Promise<void>;
}

export function useLocalActivity(options: UseLocalActivityOptions = {}): UseLocalActivityReturn {
  const { address } = useAccount();
  const [swaps, setSwaps] = useState<SwapActivityItem[]>(() => listLocalSwaps(address));

  // Keep the latest onComplete without churning callback identity.
  const onCompleteRef = useRef(options.onComplete);
  useEffect(() => {
    onCompleteRef.current = options.onComplete;
  }, [options.onComplete]);

  // Last-seen status per id, to fire onComplete only on a real transition (not
  // on first sight of an already-completed record from storage).
  const prevStatusRef = useRef<Map<string, SwapActivityItem["intentStatus"]>>(new Map());

  // The wallet the hook is bound to right now, readable from inside a poll that
  // is already in flight. Synced from a LAYOUT effect, not a passive one: layout
  // effects run synchronously during commit, so no promise continuation can
  // interleave between the render that switched wallets and this ref catching up.
  // A passive effect leaves exactly that gap, and a poll resolving inside it would
  // read the old wallet and pass the ownership check it exists to fail.
  const currentAddressRef = useRef(address);
  useLayoutEffect(() => {
    currentAddressRef.current = address;
  }, [address]);

  const apply = useCallback((items: SwapActivityItem[]) => {
    const prev = prevStatusRef.current;
    for (const it of items) {
      const before = prev.get(it.id);
      if (before && before !== "completed" && it.intentStatus === "completed") {
        onCompleteRef.current?.(it);
      }
    }
    prevStatusRef.current = new Map(items.map((it) => [it.id, it.intentStatus]));
    setSwaps(items);
  }, []);

  const reload = useCallback(() => {
    apply(listLocalSwaps(address));
  }, [address, apply]);

  // Advance non-terminal records via the public status endpoint (no auth), then
  // persist and re-read. Terminal records are left untouched.
  //
  // The poll/merge/persist loop lives in `refreshLocalSwaps` so it is directly
  // testable (#339): this is the path that recovers a swap whose tab was evicted
  // mid-flight, and it had no test of its own. It carries the destination fill
  // hash and the public fill receipt as well as txHash -- dropping the receipt
  // here used to mean it was NEVER persisted, so `hasSettlementReceipt` stayed
  // false for the life of the row and a swap whose fill had demonstrably landed
  // still escalated to "Still settling ... email hello@xochi.fi" ten minutes in.
  //
  // Reports whether any row actually MOVED, which is what the status poll spends
  // (or refills) its give-up budget on. Two things about HOW it compares are
  // load-bearing:
  //
  //   - the id -> status map, never array identity: `refreshLocalSwaps` builds a
  //     fresh array every call, so an identity check would call every tick
  //     progress and restore the unbounded poll;
  //   - snapshotted BEFORE the poll, because persisting a record notifies the
  //     local-activity subscribers synchronously, which re-reads storage through
  //     `apply` and has already advanced `prevStatusRef` by the time the await
  //     returns. Read after, and a real transition compares equal to itself.
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    const owner = address;
    const before = prevStatusRef.current;
    const refreshed = await refreshLocalSwaps(
      owner,
      (intentId) => intentAPI.getIntentStatus(intentId),
      () => isSameWallet(currentAddressRef.current, owner),
    );
    // null means the wallet changed while the poll was open, so this result
    // belongs to an account that is no longer on screen. Rendering it would put
    // one wallet's trades (and its completion toast) in another's feed.
    if (!refreshed) return false;
    const advanced = refreshed.some((s) => before.get(s.id) !== s.intentStatus);
    apply(refreshed);
    return advanced;
  }, [address, apply]);

  // Re-read on wallet change + whenever the swap panel writes a new record.
  useEffect(() => {
    reload();
    const unsubscribe = subscribeLocalActivity(reload);
    return unsubscribe;
  }, [reload]);

  // Refresh in-flight records once on mount / wallet change.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One-time self-heal for false-failures. A pre-fix client abort could stamp an
  // in-doubt execute terminal `failed` with no tx hash, and a terminal record
  // never re-polls -- so it stays wrong forever. Re-check those once against the
  // public status endpoint; `reconcileLocalSwap` decides what (if anything) each
  // one becomes. It only corrects a record the server proves actually progressed
  // (executing/bridging/settling/completed/refunded -- see isHealableServerStatus).
  // Genuine failures (server also says `failed`, or a 404 -> null) AND records the
  // server still holds pre-execution (`quoted` etc., never dispatched -- e.g. a
  // signing error) are left untouched, so a real failure is never resurrected
  // into a row that polls forever.
  //
  // This effect used to carry its own inline copy of that merge, which is how the
  // dropped-receipt bug got written twice. There is one merge now, and it is the
  // tested one.
  const healedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!address || healedRef.current === address) return;
    healedRef.current = address;
    const suspects = listLocalSwaps(address).filter(
      (s) => s.intentStatus === "failed" && !s.data.txHash,
    );
    if (suspects.length === 0) return;
    let cancelled = false;
    void (async () => {
      let changed = false;
      await Promise.all(
        suspects.map(async (s) => {
          const next = reconcileLocalSwap(s, await intentAPI.getIntentStatus(s.id));
          if (!next) return;
          changed = true;
          upsertLocalSwap(address, next);
        }),
      );
      if (changed && !cancelled) reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [address, reload]);

  // While anything is in flight, keep polling so the feed advances on its own.
  // Cadence, the give-up ceiling, the foreground snap-forward and cancellation
  // are `useIntentStatusPoll`'s -- the same poller useIntent and useOrderHistory
  // run. This effect used to be an inline `setInterval` at a cadence "matching
  // useIntent's STATUS_POLL_MS" by comment, WITHOUT its ceiling, so a stuck swap
  // that useIntent stopped chasing after ten minutes was still polled here for
  // as long as the tab lived.
  const pendingIds = useMemo(
    () =>
      swaps
        .filter((s) => !isTerminalIntentStatus(s.intentStatus))
        .map((s) => s.id)
        .sort()
        .join(","),
    [swaps],
  );
  // Bumped only by the public `refresh` below, and part of the poll key, so a
  // user can re-arm a poll the give-up ceiling has stopped.
  const [pollEpoch, setPollEpoch] = useState(0);
  useIntentStatusPoll({
    active: pendingIds.length > 0,
    // The pending SET plus the refresh epoch. The set does NOT track progress --
    // a record advancing executing -> bridging leaves the same set -- so it is
    // the `"progress"` verdict below that restores the give-up budget; this key
    // only re-arms for new records and for a user-initiated refresh. Re-arming
    // costs nothing extra here because `immediate` is off.
    key: `${pendingIds}|${pollEpoch}`,
    label: "useLocalActivity",
    immediate: false, // the mount / wallet-change effect above owns the first refresh
    // A row that moved is progress and refills the budget; a feed reporting the
    // same in-flight rows for ten minutes has stopped being worth asking. The
    // verdict is returned explicitly because a declared
    // `Promise<undefined | "progress" | "stop">` is a union, and TypeScript
    // requires a return statement for anything but bare `undefined`/`void`/`any`.
    onPoll: async (): Promise<StatusPollVerdict> => {
      const advanced = await refresh();
      return advanced ? "progress" : undefined;
    },
  });

  // Public refresh polls in-flight statuses (and re-reads), and re-arms a poll
  // the ceiling stopped. Returns the promise so callers can await it (e.g. to
  // drive a spinner); a plain onClick can still ignore the result. The epoch is
  // bumped ONLY here -- bumping it from the poll above would re-arm on every
  // tick and restore the unbounded poll.
  const publicRefresh = useCallback(async (): Promise<void> => {
    setPollEpoch((n) => n + 1);
    await refresh();
  }, [refresh]);

  return { swaps, refresh: publicRefresh };
}
