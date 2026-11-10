/**
 * Report client
 *
 * Fire-and-forget POST of a swap failure to the worker's /api/report endpoint.
 * Best-effort: a failure to report must never disrupt the UI, but it is logged
 * (never silently swallowed).
 */

import { API_URL } from "../config.js";
import type { SwapFailureRef } from "./swapFlowPhase.js";

export async function reportSwapFailure(ref: SwapFailureRef): Promise<void> {
  try {
    await fetch(`${API_URL}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent_id: ref.intentId ?? undefined,
        quote_id: ref.quoteId ?? undefined,
        status: ref.status,
        reason: ref.reason,
        from_chain_id: ref.fromChainId,
        to_chain_id: ref.toChainId,
        from_token: ref.fromToken,
        to_token: ref.toToken,
        from_amount: ref.fromAmount,
        wallet: ref.wallet,
        app_version: ref.appVersion,
        // navigator.userAgent is intentionally NOT sent: binding a high-entropy
        // UA string to wallet + trade in an unauthenticated payload is a privacy
        // fingerprint. The server records a bounded UA from the request header
        // instead (still untrusted, but not a client-body injection vector).
        client_ts: ref.timestamp,
      }),
    });
  } catch (err) {
    console.warn("[report] failed to send failure report:", err);
  }
}
