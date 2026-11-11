/**
 * The live preview quote behind the "What users see" panel
 * (xochi-fi/xochi-widget#40). See previewQuote.ts for what is asked for.
 *
 * Asked through the frame's transport with no credential (`anonymousIntentAPI`:
 * the same quote cache and in-flight deduplication, but never a bearer token,
 * so a wallet or passkey session the integrator has stored does not ride
 * along on a visitor's preview), and only after the request has been unchanged for
 * the frame's own quote debounce, so typing an amount never sends a request
 * per keystroke. Everything is keyed on the request itself (`plan.key`): an
 * option that does not change the request (the settlement mode, a theme) asks
 * nothing, and a reply for a request the panel has since left is dropped.
 *
 * While shown, the price is asked for again every PREVIEW_REFRESH_MS, in
 * place (no loading flash), so "live" stays true on an open page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, QUOTE_DEBOUNCE_MS, type StructuredError } from "@xochi/client";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { usePrices } from "../../hooks/usePrices.js";
import { anonymousIntentAPI } from "../../lib/intentAPI.js";
import type { QuoteResponse } from "../../types/intent.js";
import type { EmbedDefaults } from "../trade/embedParams.js";
import type { CapabilityState, RoutePrivacyMode } from "@xochi/client";
import { previewPlan, previewQuoteRequest, type PricedAmount } from "./previewQuote.js";

/** How often an open panel refreshes its price. */
export const PREVIEW_REFRESH_MS = 60_000;

export type PreviewFee =
  | { kind: "no_amount" }
  | { kind: "needs_recipient"; chainName: string }
  | { kind: "unconfirmed"; reason: "stale" | "fallback" | "failed" | "route" | "private" }
  | { kind: "out_of_bounds"; amount: PricedAmount; notice: string }
  | { kind: "loading"; amount: PricedAmount }
  /** Solvable: the price the frame shows a visitor. */
  | { kind: "ready"; amount: PricedAmount; quote: QuoteResponse }
  /** The solver declined the route at this amount; `quote` carries its reason. */
  | { kind: "declined"; amount: PricedAmount; quote: QuoteResponse }
  /** No answer: the request failed (with the API's code and retry time) or could not be built. */
  | { kind: "failed"; amount: PricedAmount; error: StructuredError };

type Outcome = { ok: true; quote: QuoteResponse } | { ok: false; error: StructuredError };

export interface UsePreviewFeeResult {
  fee: PreviewFee;
  prices: Record<string, number>;
  /** Privacy modes authorized by the exact selected live route. */
  routePrivacyModes: readonly RoutePrivacyMode[];
  capabilityState: CapabilityState;
  /** A capability retry is currently in flight. */
  retryingRoutes: boolean;
  trustEconomicsLive: boolean;
  /** Ask again after a failure. */
  retry: () => void;
}

/** A rejected quote call as the frame's error copy reads it (code, retry time). */
function structuredError(error: unknown): StructuredError {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code, retryAfter: error.retryAfter };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * The preview fee for `config`. Nothing is requested while `enabled` is false
 * (the panel is collapsed behind its disclosure).
 */
export function usePreviewFee(config: EmbedDefaults, enabled: boolean): UsePreviewFeeResult {
  const {
    capabilities,
    state: capabilityState,
    features,
    retry: retryCapabilities,
    isFetching: retryingRoutes,
  } = useCapabilities();
  const { prices, isLive: pricesLive } = usePrices();
  const plan = useMemo(
    () => previewPlan(config, { capabilities, capabilityState, prices, pricesLive }),
    [config, capabilities, capabilityState, prices, pricesLive],
  );
  const key = plan.kind === "quote" ? plan.key : null;

  // The request effect runs on the key alone, and reads the plan it was built
  // from here, so a new object with the same request asks nothing.
  const latest = useRef({ config, plan });
  latest.current = { config, plan };

  // The key the request has rested on for the debounce; asking waits for it.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setSettledKey(key), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const [answer, setAnswer] = useState<{ key: string; attempt: number; outcome: Outcome } | null>(
    null,
  );

  // `attempt` is a Retry (shown as loading); `refresh` is the silent timer.
  // The timer runs only while the shown answer is a price: after a failure
  // only Retry asks again, and Retry is held through the server's
  // Retry-After, so no automatic request beats the backoff it asked for.
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const priced = answer !== null && answer.key === key && answer.outcome.ok;
  useEffect(() => {
    if (!enabled || !priced) return;
    const timer = setInterval(() => setRefresh((n) => n + 1), PREVIEW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, priced, key]);

  useEffect(() => {
    if (!enabled || key === null || settledKey !== key) return;
    const { config: asked, plan: current } = latest.current;
    if (current.kind !== "quote") return;
    const built = previewQuoteRequest(asked, current.amount, Date.now());
    if (!built.ok) {
      setAnswer({ key, attempt, outcome: { ok: false, error: { message: built.error } } });
      return;
    }
    let live = true;
    anonymousIntentAPI.getQuote(built.request).then(
      (quote) => {
        if (live) setAnswer({ key, attempt, outcome: { ok: true, quote } });
      },
      (error: unknown) => {
        const structured = structuredError(error);
        console.warn("[configurator] Preview quote failed:", structured.message);
        if (live) setAnswer({ key, attempt, outcome: { ok: false, error: structured } });
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, key, settledKey, attempt, refresh]);

  const retry = useCallback(() => {
    if (
      plan.kind === "unconfirmed" &&
      (plan.reason === "stale" || plan.reason === "fallback" || plan.reason === "failed")
    ) {
      retryCapabilities();
      return;
    }
    setAttempt((n) => n + 1);
  }, [plan, retryCapabilities]);

  const fee: PreviewFee = (() => {
    if (plan.kind !== "quote") return plan;
    if (answer === null || answer.key !== plan.key || answer.attempt !== attempt) {
      return { kind: "loading", amount: plan.amount };
    }
    const { outcome } = answer;
    if (!outcome.ok) return { kind: "failed", amount: plan.amount, error: outcome.error };
    return outcome.quote.success && outcome.quote.canSolve
      ? { kind: "ready", amount: plan.amount, quote: outcome.quote }
      : { kind: "declined", amount: plan.amount, quote: outcome.quote };
  })();

  return {
    fee,
    prices,
    routePrivacyModes: plan.routePrivacyModes,
    retryingRoutes,
    capabilityState,
    trustEconomicsLive: features.trustEconomicsLive,
    retry,
  };
}
