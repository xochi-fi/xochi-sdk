/**
 * Live cash-out rails for Trade/Cash out, read through S5's offramp provider.
 *
 * Unlike W1's buyer-side discovery, this goes through the maker adapter, whose
 * `capabilities` overlays the user's seller readiness (oracle pause, identity
 * attestation, Seller Autopilot) on S2's live offers. Each input change drops
 * the previous read's result; a timer re-reads the clock at the next expiry so
 * a stale offer stops being selectable in place.
 */

import { useCallback, useEffect, useState } from "react";
import type { RampIntent, RampOffer, RampSettlement } from "@xochi/client";
import type { PeerDiscoveryResult, PeerOfferEstimate } from "../peer/index.js";
import { buildRampIntent, nextExpiry } from "../availability/model.js";
import type { OfframpPort, OfframpRuntime } from "./port.js";

export type OfframpRailsState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      intent: RampIntent;
      offers: readonly RampOffer[];
      estimates: readonly PeerOfferEstimate[];
      availability: PeerDiscoveryResult["availability"];
    };

const UNREACHABLE: PeerDiscoveryResult["availability"] = {
  state: "temporarily_unavailable",
  reason_code: "capabilities_unavailable",
};

export function useOfframpRails(input: {
  port: OfframpPort;
  runtime: OfframpRuntime | undefined;
  settlement: RampSettlement | undefined;
  account: string | undefined;
  amount: string | undefined;
  currency: string;
  enabled: boolean;
}) {
  const { port, runtime, settlement, account, amount, currency, enabled } = input;
  const [state, setState] = useState<OfframpRailsState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => port.now());

  useEffect(() => {
    if (!enabled || !runtime || !settlement || !account || amount === undefined) {
      setState({ status: "idle" });
      return;
    }
    let stale = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    const intent = buildRampIntent({
      direction: "offramp",
      amount,
      currency,
      recipient: account,
      settlement,
    });
    const timer = setTimeout(() => {
      void (async () => {
        let next: OfframpRailsState;
        try {
          const raw = (await runtime.provider.capabilities(
            intent,
            controller.signal,
          )) as PeerDiscoveryResult;
          const offers = runtime.provider.normalizeCapabilities(raw, intent);
          // Estimates only for offers still available after the maker readiness overlay.
          const live = new Set(
            offers.filter((o) => o.availability.state === "available").map((o) => o.offer_id),
          );
          next = {
            status: "done",
            intent,
            offers,
            estimates: (raw.estimates ?? []).filter((e) => live.has(e.offerId)),
            availability: raw.availability ?? UNREACHABLE,
          };
        } catch {
          next = { status: "done", intent, offers: [], estimates: [], availability: UNREACHABLE };
        }
        if (stale) return;
        setNow(port.now());
        setState(next);
      })();
    }, port.debounceMs);
    return () => {
      stale = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [port, runtime, settlement, account, amount, currency, enabled, nonce]);

  const offers = state.status === "done" ? state.offers : undefined;
  useEffect(() => {
    if (!offers) return;
    const at = nextExpiry(offers, now);
    if (at === undefined) return;
    const timer = setTimeout(() => setNow(port.now()), Math.max(0, at - now) + 1);
    return () => clearTimeout(timer);
  }, [port, offers, now]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, now, refresh };
}
