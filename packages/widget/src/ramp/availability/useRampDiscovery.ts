/**
 * Live Peer rail discovery for one surface (Buy or Trade/Cash out).
 *
 * Reads through S2's `fetchPeerCapabilities`; the context only lets a test or
 * the screenshot harness substitute in-memory Peer reads. Each amount,
 * currency or account change aborts the previous request and discards its
 * result, so a slow response for an old amount never repaints the rails. A
 * timer re-reads the clock at the next offer expiry, so an offer past its
 * `valid_until` stops being selectable without a reload.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { RampDirection, RampIntent, RampSettlement } from "@xochi/client";
import { fetchPeerCapabilities, peerConfiguration } from "../peer/index.js";
import type { PeerDiscoveryResult } from "../peer/index.js";
import { buildRampIntent, nextExpiry } from "./model.js";
import { ONRAMP_CANARY_CAP_ATOMIC, TIMEOUTS } from "../../config.js";

export interface RampDiscoveryPort {
  discover(intent: RampIntent, user: string, signal?: AbortSignal): Promise<PeerDiscoveryResult>;
  /** Validated Base USDC settlement, or undefined when the SDK config fails validation. */
  settlement(): RampSettlement | undefined;
  now(): number;
  debounceMs: number;
  /**
   * Deployment canary cap for a purchase (Base USDC atomic), or undefined for
   * none. Absent on a port means no cap.
   */
  onrampCanaryCap?(): string | undefined;
}

function liveSettlement(): RampSettlement | undefined {
  try {
    return peerConfiguration().settlement;
  } catch {
    return undefined;
  }
}

export const LIVE_RAMP_DISCOVERY: RampDiscoveryPort = {
  discover: (intent, user, signal) => fetchPeerCapabilities(intent, { user, signal }),
  settlement: liveSettlement,
  now: () => Date.now(),
  debounceMs: TIMEOUTS.quoteDebounce,
  onrampCanaryCap: () => ONRAMP_CANARY_CAP_ATOMIC,
};

export const RampDiscoveryContext = createContext<RampDiscoveryPort>(LIVE_RAMP_DISCOVERY);

export type RampDiscoveryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; intent: RampIntent; result: PeerDiscoveryResult };

export interface RampDiscoveryInput {
  direction: RampDirection;
  /** Canonical USDC atomic amount, or undefined while none is entered. */
  amount: string | undefined;
  currency: string;
  /** The connected wallet: the onramp recipient and the offramp seller. */
  account: string | undefined;
  /** Only the visible surface reads Peer. */
  enabled: boolean;
}

/** Whether an onramp amount exceeds the deployment cap. Unset cap: never. */
export function overOnrampCap(amount: string | undefined, cap: string | undefined): boolean {
  return amount !== undefined && cap !== undefined && BigInt(amount) > BigInt(cap);
}

export function useRampDiscovery({
  direction,
  amount,
  currency,
  account,
  enabled,
}: RampDiscoveryInput) {
  const port = useContext(RampDiscoveryContext);
  const settlement = useMemo(() => port.settlement(), [port]);
  const cap = direction === "onramp" ? port.onrampCanaryCap?.() : undefined;
  const capped = overOnrampCap(amount, cap);
  const [state, setState] = useState<RampDiscoveryState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => port.now());

  useEffect(() => {
    if (
      !enabled ||
      capped ||
      amount === undefined ||
      account === undefined ||
      settlement === undefined
    ) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    const intent = buildRampIntent({ direction, amount, currency, recipient: account, settlement });
    const timer = setTimeout(() => {
      void port
        .discover(intent, account, controller.signal)
        .catch(
          (): PeerDiscoveryResult => ({
            estimates: [],
            offers: [],
            availability: {
              state: "temporarily_unavailable",
              reason_code: "capabilities_unavailable",
            },
          }),
        )
        .then((result) => {
          if (controller.signal.aborted) return;
          setNow(port.now());
          setState({ status: "done", intent, result });
        });
    }, port.debounceMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [port, settlement, direction, amount, currency, account, enabled, capped, nonce]);

  const offers = state.status === "done" ? state.result.offers : undefined;
  const noOfferUntil = state.status === "done" ? state.result.noOfferUntil : undefined;
  useEffect(() => {
    if (!offers) return;
    const at =
      nextExpiry(offers, now) ??
      (noOfferUntil !== undefined && noOfferUntil > now ? noOfferUntil : undefined);
    if (at === undefined) return;
    const timer = setTimeout(() => setNow(port.now()), Math.max(0, at - now) + 1);
    return () => clearTimeout(timer);
  }, [port, offers, noOfferUntil, now]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, now, settlement, refresh, cap: capped ? cap : undefined };
}
