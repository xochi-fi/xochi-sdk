/**
 * The `@riddler/signer` value checks the machine runs on a signable (pull-route)
 * quote at ingest, adapted to the machine's request and refusal shapes.
 *
 * `assertIntentMatchesRequest` holds the served XochiIntent to the request that
 * produced it (wallet, chains, tokens, recipient, settlement preference, amount,
 * and the intent deadline against the wall clock). `assertPullMatchesIntent`
 * then holds the origin pull to that intent (chain, token, amount, expiry, the
 * Permit2 contract) and, where the caller pinned one, its recipient.
 *
 * Both are additive to the machine's own gates (`validateSolverPin`,
 * `validatePayoutPin`, the recipient echo, the claim-info factory), which keep
 * running where they always ran.
 */

import {
  XochiIntentMismatchError,
  assertIntentMatchesRequest,
  assertPullMatchesIntent,
  type PinnedPullRecipients,
  type QuoteRequestParams,
} from "@riddler/signer";
import type { QuoteRequest, QuoteResponse } from "./wire.js";

/**
 * The request in the signer's snake_case parameter spelling.
 *
 * Built from the request the machine SENT (already trimmed by
 * `buildQuoteRequest`), never from the panel state, so the checks compare the
 * served terms against the bytes that asked for them. The widget only quotes
 * exact-input, so `swap_kind` is stated rather than left to the signer's default.
 */
export function quoteRequestParams(request: QuoteRequest): QuoteRequestParams {
  return {
    wallet: request.wallet,
    from_chain_id: request.fromChainId,
    to_chain_id: request.toChainId,
    from_token: request.fromToken,
    to_token: request.toToken,
    from_amount: request.fromAmount,
    swap_kind: "exact_input",
    settlement_preference: request.settlementPreference,
    recipient_address: request.recipientAddress,
    refund_address: request.refundAddress,
    stealth_spending_pub_key: request.stealthMetaAddress?.spendingPubKey,
    stealth_viewing_pub_key: request.stealthMetaAddress?.viewingPubKey,
  };
}

export type SignableQuoteCheck =
  | { ok: true }
  | { ok: false; kind: "intent_mismatch" | "pull_mismatch"; reason: string };

/**
 * Run both signer checks over a quote that carries an intent to sign.
 *
 * `pullRecipients` is the CALLER's pin (per chain, per method); it is never
 * derived from `/api/capabilities`. Absent, the pull's recipient is left to the
 * machine's own solver allowlist, and the signer still binds chain, token,
 * amount and expiry.
 */
export function checkSignableQuote(
  request: QuoteRequest,
  quote: QuoteResponse,
  pullRecipients: PinnedPullRecipients | undefined,
): SignableQuoteCheck {
  // The signer reads the wire spelling: `eip712` and `pull_authorization`.
  const served = { eip712: quote.eip712Data, pull_authorization: quote.pullAuthorization };
  try {
    assertIntentMatchesRequest(quoteRequestParams(request), served);
  } catch (err) {
    return { ok: false, kind: "intent_mismatch", reason: refusalReason(err) };
  }
  try {
    assertPullMatchesIntent(served, { expectedPullRecipients: pullRecipients });
  } catch (err) {
    return { ok: false, kind: "pull_mismatch", reason: refusalReason(err) };
  }
  return { ok: true };
}

/**
 * The signer's own message for its mismatch class. Anything else still refuses
 * (fail closed) and is labelled as unexpected so it is not read as a verdict.
 */
function refusalReason(err: unknown): string {
  if (err instanceof XochiIntentMismatchError) return err.message;
  return `verification failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
}
