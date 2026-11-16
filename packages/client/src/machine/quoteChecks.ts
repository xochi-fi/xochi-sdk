/**
 * The `@xochi/signer` value checks the machine runs on a signable (pull-route)
 * quote at ingest, adapted to the machine's request and refusal shapes.
 *
 * `assertIntentMatchesRequest` holds the served XochiIntent to the request that
 * produced it (wallet, chains, tokens, recipient, settlement preference, amount,
 * and the intent deadline against the wall clock). `assertPullMatchesIntent`
 * then holds the origin pull to that intent (chain, token, amount, expiry, the
 * Permit2 contract) and, where the caller pinned one, its recipient.
 *
 * An escrow-bearing quote (one carrying `escrow`, SPEC.md §5.2) takes the
 * escrow path instead: `assertEscrowQuoteMatchesRequest` runs both checks above
 * and the SPEC.md §2.3 binding against the caller's escrow pin. Without a pin
 * it refuses.
 *
 * Both are additive to the machine's own gates (`validateSolverPin`,
 * `validatePayoutPin`, the recipient echo, the claim-info factory), which keep
 * running where they always ran.
 */

import {
  XochiIntentMismatchError,
  assertEscrowQuoteMatchesRequest,
  assertIntentMatchesRequest,
  assertPullMatchesIntent,
  type PinnedEscrows,
  type PinnedPullRecipients,
  type QuoteRequestParams,
  type VerifiedEscrowOrder,
} from "@xochi/signer";
import type { QuoteRequest, QuoteResponse } from "./wire.js";

/**
 * The request in the signer's snake_case parameter spelling.
 *
 * Built from the request the machine SENT (already trimmed by
 * `buildQuoteRequest`), never from the panel state, so the checks compare the
 * served terms against the bytes that asked for them. The widget only quotes
 * exact-input, so `swap_kind` is stated rather than left to the signer's default.
 *
 * On a tag request the expected recipient is the L1 address the Worker bound
 * (`quote.recipientAddress`, already held to the tag echo by `quoteRefusal`),
 * so the signer compares the intent against that address, never the wallet.
 */
export function quoteRequestParams(
  request: QuoteRequest,
  quote: QuoteResponse,
): QuoteRequestParams {
  return {
    wallet: request.wallet,
    from_chain_id: request.fromChainId,
    to_chain_id: request.toChainId,
    from_token: request.fromToken,
    to_token: request.toToken,
    from_amount: request.fromAmount,
    swap_kind: "exact_input",
    settlement_preference: request.settlementPreference,
    recipient_address: request.recipientTag ? quote.recipientAddress : request.recipientAddress,
    refund_address: request.refundAddress,
    stealth_spending_pub_key: request.stealthMetaAddress?.spendingPubKey,
    stealth_viewing_pub_key: request.stealthMetaAddress?.viewingPubKey,
  };
}

/** The caller's escrow pins (`MachineConfig.escrows` / `openAuthSigners`). */
export interface EscrowPins {
  escrows?: PinnedEscrows;
  openAuthSigners?: readonly string[];
}

export type SignableQuoteCheck =
  | { ok: true; escrow: VerifiedEscrowOrder | null }
  | { ok: false; kind: "intent_mismatch" | "pull_mismatch" | "escrow_mismatch"; reason: string };

/**
 * The least destination amount an escrow opening may commit to: the signed
 * `toAmount` the panel rendered, less the request's own slippage tolerance,
 * rounded as Riddler rounds it (`amount - floor(amount * bps / 10000)`). Never
 * the served `min_to_amount`: a floor the venue picks binds nothing.
 */
export function escrowMinOut(toAmount: unknown, slippageBps: number): bigint {
  if (typeof toAmount !== "string" && typeof toAmount !== "number") {
    throw new XochiIntentMismatchError(
      `intent toAmount ${JSON.stringify(toAmount)} is not an amount`,
    );
  }
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new XochiIntentMismatchError(`slippage ${slippageBps} bps is not a tolerance`);
  }
  const amount = BigInt(toAmount);
  return amount - (amount * BigInt(slippageBps)) / 10_000n;
}

/**
 * Run the signer checks over a quote that carries an intent to sign.
 *
 * `pullRecipients` is the CALLER's pin (per chain, per method); it is never
 * derived from `/api/capabilities`. Absent, the pull's recipient is left to the
 * machine's own solver allowlist, and the signer still binds chain, token,
 * amount and expiry. `escrowPins` likewise: an escrow quote with no pin for its
 * origin chain refuses.
 */
export function checkSignableQuote(
  request: QuoteRequest,
  quote: QuoteResponse,
  pullRecipients: PinnedPullRecipients | undefined,
  escrowPins: EscrowPins = {},
): SignableQuoteCheck {
  // The signer reads the wire spelling: `eip712`, `pull_authorization`, and the
  // raw `escrow` envelope.
  const served = {
    eip712: quote.eip712Data,
    pull_authorization: quote.pullAuthorization,
    escrow: quote.escrow,
  };
  if (served.escrow !== undefined && served.escrow !== null) {
    try {
      const escrow = assertEscrowQuoteMatchesRequest(quoteRequestParams(request, quote), served, {
        expectedEscrows: escrowPins.escrows as PinnedEscrows,
        minOut: escrowMinOut(quote.eip712Data?.message?.toAmount, request.slippageBps),
        ...(escrowPins.openAuthSigners
          ? { expectedOpenAuthSigners: escrowPins.openAuthSigners }
          : {}),
      });
      return { ok: true, escrow };
    } catch (err) {
      return { ok: false, kind: "escrow_mismatch", reason: refusalReason(err) };
    }
  }
  try {
    assertIntentMatchesRequest(quoteRequestParams(request, quote), served);
  } catch (err) {
    return { ok: false, kind: "intent_mismatch", reason: refusalReason(err) };
  }
  try {
    assertPullMatchesIntent(served, {
      expectedPullRecipients: pullRecipients,
      ...(escrowPins.escrows ? { expectedEscrows: escrowPins.escrows } : {}),
    });
  } catch (err) {
    return { ok: false, kind: "pull_mismatch", reason: refusalReason(err) };
  }
  return { ok: true, escrow: null };
}

/**
 * The signer's own message for its mismatch class. Anything else still refuses
 * (fail closed) and is labelled as unexpected so it is not read as a verdict.
 */
function refusalReason(err: unknown): string {
  if (err instanceof XochiIntentMismatchError) return err.message;
  return `verification failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
}
