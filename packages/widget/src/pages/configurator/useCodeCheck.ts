/**
 * The Integration section's live check of the promo code
 * (xochi-fi/xochi-widget#48): a non-persisted preview quote for the configured
 * route, carrying the codes the frame would send, read for what the Worker
 * says about the promo code.
 *
 * Only the Worker's answer is shown, and only from a quote it priced. A preview
 * that no solver priced (`can_solve: false`: no bid, or a route the solver
 * declines) judged no code at all, so it is reported as no bid, never as a code
 * that was turned down. On a priced quote, codes the Worker applies come back
 * named; a code it looks at and does not apply comes back with one fixed note
 * for every reason (unknown, expired, used up, not valid under this key); and a
 * Worker with codes turned off answers with neither, which is shown as that.
 */

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { ApiError, type QuoteRequest } from "@xochi/client";
import { anonymousIntentAPI } from "../../lib/intentAPI.js";
import type { QuoteResponse } from "../../types/intent.js";
import { DEFAULT_SLIPPAGE_BPS } from "../trade/config.js";
import type { EmbedDefaults } from "../trade/embedParams.js";

/** How long the check's quote request stays valid: the panel's own quote horizon. */
const CHECK_DEADLINE_SECS = 3600;

/** What the Worker said about the promo code on a quote it priced. */
export type CodeOutcome = Pick<QuoteResponse, "promo" | "promoNote">;

export type CodeCheck =
  /** No promo code is set: nothing to check. */
  | { kind: "none" }
  /** Waiting for a pause in typing, or for the preview quote. */
  | { kind: "checking" }
  | { kind: "checked"; outcome: CodeOutcome }
  /** No solver priced the preview, so no code was judged; why, in words. */
  | { kind: "no_bid"; reason: string }
  /** The preview quote itself failed; why, in words. */
  | { kind: "failed"; reason: string };

/**
 * The amount a check quotes when none is configured: an ordinary order, so the
 * route prices (codes are judged the same at any amount). 0.05 of ETH or WETH,
 * 100 of anything else, which is right for the dollar and euro coins; a token
 * worth far less can get no bid, and the check then says to set an amount.
 */
export function probeAmount(config: Pick<EmbedDefaults, "amount" | "fromToken">): string {
  if (config.amount !== "") return config.amount;
  return /^W?ETH$/.test(config.fromToken.symbol) ? "0.05" : "100";
}

/** The preview quote that checks `config`'s promo code; null when it sets none. */
export function codeCheckRequest(config: EmbedDefaults, nowMs: number): QuoteRequest | null {
  if (config.promo === null) return null;
  return {
    preview: true,
    fromChainId: config.fromChainId,
    toChainId: config.toChainId,
    fromToken: config.fromToken.address,
    toToken: config.toToken.address,
    fromAmount: parseUnits(probeAmount(config), config.fromToken.decimals).toString(),
    deadline: Math.floor(nowMs / 1000) + CHECK_DEADLINE_SECS,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    trustScore: 0,
    // A preview is public: private settlement needs a wallet's keys.
    settlementPreference: "public",
    ref: config.ref ?? undefined,
    promo: config.promo ?? undefined,
  };
}

/** A quote reply as a check result. */
export function readCodeCheck(quote: QuoteResponse): CodeCheck {
  if (!quote.success || !quote.canSolve) {
    return {
      kind: "no_bid",
      reason: quote.error ?? "no solver priced this route at this amount",
    };
  }
  const { promo, promoNote } = quote;
  return { kind: "checked", outcome: { promo, promoNote } };
}

/** A failed preview quote, in words. */
export function checkFailure(err: unknown): CodeCheck {
  return {
    kind: "failed",
    reason:
      err instanceof ApiError
        ? `the preview quote failed (HTTP ${err.code})`
        : "the quote service couldn't be reached",
  };
}

/** Check `config`'s codes after `delayMs` of quiet; re-checked on any change. */
export function useCodeCheck(config: EmbedDefaults, delayMs: number): CodeCheck {
  const probe = codeCheckRequest(config, 0);
  const key = probe === null ? null : JSON.stringify(probe);
  const [result, setResult] = useState<{ key: string; check: CodeCheck } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const timer = setTimeout(() => {
      const request = codeCheckRequest(config, Date.now());
      if (request === null) return;
      // Without a session, like the configurator's other preview quote: the
      // check is about the codes, not whoever has the configurator open.
      anonymousIntentAPI.getQuote(request).then(
        (quote) => {
          if (live) setResult({ key, check: readCodeCheck(quote) });
        },
        (err: unknown) => {
          console.warn("[configurator] code check failed:", err);
          if (live) setResult({ key, check: checkFailure(err) });
        },
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` is the request less its deadline: everything the check depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delayMs]);

  if (key === null) return { kind: "none" };
  return result?.key === key ? result.check : { kind: "checking" };
}
