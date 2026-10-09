/**
 * Deposit-route (Tron and other non-EVM origin) binding: the shapes the machine
 * stores, and the checks it runs at quote ingest and on resume.
 *
 * The attestation itself -- the v3 message, its EIP-191 recovery against the
 * pinned signer, the request binding, the deposit window and the
 * destination-token guard -- is `@xochi/signer`'s. This module adapts it to
 * the machine: it assembles the request side, carries the caller's pinned
 * signer, keeps the per-session address-reuse tripwire as plain data on the
 * model, and maps the signer's error classes to `DepositAttestationResult`.
 *
 * There is no clock parameter anywhere here, on purpose: the signer bounds the
 * deposit window against the wall clock, and an injectable `now` on a security
 * assertion is a bypass wearing a test affordance's name.
 */

import {
  DepositAttestationError,
  DepositQuoteMismatchError,
  assertDepositQuoteMatchesRequest,
  depositAttestationFields,
  recipientIsDestinationToken,
  recordDepositAddress,
  verifyDepositAttestation,
  type DepositAttestationFields,
} from "@xochi/signer";
import type { QuoteRequest, QuoteResponse } from "./wire.js";
import { quoteRequestParams } from "./quoteChecks.js";

export { recipientIsDestinationToken, type DepositAttestationFields };

/**
 * `kind` names the rejections a caller must treat differently, and only those.
 *
 * `addressReuse` is the one the user can act on: it is the per-session tripwire
 * on `Model.seenDepositAddresses`, which cannot tell a genuine collision from
 * Riddler re-issuing an address to a re-quote, and which a reload clears.
 * Everything else is `unavailable`, where retrying is the right advice and the
 * detail belongs in the log rather than on screen.
 */
export type DepositAttestationResult =
  | { ok: true }
  | { ok: false; kind: "unavailable" | "addressReuse"; reason: string };

/**
 * A deposit binding as persisted alongside a swap record, and the signature over
 * it. `attested` is the signer's own field set, exactly as it was verified.
 *
 * The FIELDS are stored verbatim rather than re-derived on read. Re-deriving
 * would mean the values displayed and the values verified are built by two
 * different code paths, which is precisely how a screen comes to show one
 * address while a check passes over another.
 */
export interface StoredDepositAttestation {
  attested: DepositAttestationFields;
  attestation: string;
}

/**
 * 0x + 65-byte secp256k1 signature. Stricter than the signer, which also
 * recovers a 64-byte EIP-2098 compact signature; the solver only ever serves
 * the 65-byte form, so anything else is refused before recovery.
 */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export type DepositQuoteCheck =
  | { ok: true; stored: StoredDepositAttestation; seen: Readonly<Record<string, string>> }
  | Extract<DepositAttestationResult, { ok: false }>;

/**
 * Verify a served deposit route against the request that produced it.
 *
 * Runs, in order: the signature-shape gate above; `depositAttestationFields`
 * (the request half of the message is rebuilt from `request`, the server half
 * from the quote, with the requested `from_amount` because the Worker envelope
 * carries none on an exact-input route); `verifyDepositAttestation` against the
 * caller-pinned `signer`; `assertDepositQuoteMatchesRequest` (amount, displayed
 * recipient, destination-token payout, attested deposit window); and finally
 * `recordDepositAddress` against `seen`, only once the signature has verified so
 * a forged quote cannot poison the record.
 *
 * Returns the next `seen` map rather than mutating the one passed in, so the
 * model stays plain data.
 */
export function checkDepositQuote(
  request: QuoteRequest,
  quote: QuoteResponse,
  signer: string | null,
  seen: Readonly<Record<string, string>>,
): DepositQuoteCheck {
  const attestation = quote.depositAttestation;
  if (attestation && !SIGNATURE_RE.test(attestation)) {
    return { ok: false, kind: "unavailable", reason: "malformed deposit attestation signature" };
  }

  const params = quoteRequestParams(request);
  let fields: DepositAttestationFields;
  try {
    fields = depositAttestationFields(
      {
        intent_id: quote.intentId,
        quote_id: quote.quoteId,
        from_amount: request.fromAmount,
        deposit_address: quote.depositAddress,
        deposit_deadline: quote.depositDeadline,
        to_amount: quote.toAmount,
        min_to_amount: quote.minToAmount,
      },
      params,
    );
    verifyDepositAttestation(fields, attestation, signer);
    assertDepositQuoteMatchesRequest(params, fields, { recipient_address: quote.recipientAddress });
  } catch (err) {
    return depositRefusal(err);
  }

  // Only AFTER the signature verifies: recording an unverified address would let
  // a forged quote poison the record and lock the user out of a legitimate one.
  const next: Record<string, string> = { ...seen };
  try {
    recordDepositAddress(
      { get: (key) => next[key], set: (key, intentId) => void (next[key] = intentId) },
      fields.deposit_address,
      fields.intent_id,
    );
  } catch (err) {
    if (err instanceof DepositQuoteMismatchError) {
      return { ok: false, kind: "addressReuse", reason: err.message };
    }
    return depositRefusal(err);
  }
  // `verifyDepositAttestation` threw on an absent attestation, so it is a string here.
  return { ok: true, stored: { attested: fields, attestation: attestation as string }, seen: next };
}

/**
 * Map the signer's error classes onto the machine's refusal shape: every reason
 * not to send funds is `unavailable`. Anything that is not one of the signer's
 * classes still refuses (fail closed) and says so.
 */
function depositRefusal(err: unknown): Extract<DepositAttestationResult, { ok: false }> {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof DepositAttestationError) return { ok: false, kind: "unavailable", reason };
  return {
    ok: false,
    kind: "unavailable",
    reason: `deposit verification failed unexpectedly: ${reason}`,
  };
}

/**
 * Prove a deposit binding restored from storage, before any of it is shown.
 *
 * A resumed swap reads its deposit address out of host storage, which is not a
 * trust boundary. Rendering an address from there, having never checked it,
 * hands away the invariant at the one point the user is about to move funds by
 * hand. TWO independent things are checked, and both are necessary:
 *
 * 1. The BINDING to the record it was stored under. An attacker can obtain a
 *    genuine attestation for their own deposit quote and transplant it into a
 *    victim's record; every field is internally consistent and the signature
 *    verifies. What it cannot fake is whose deal it is: v3 binds `wallet` and
 *    the record is filed under its owner, and `intent_id` must match the record.
 * 2. The SIGNATURE, by `verifyDepositAttestation` against the pinned signer,
 *    plus the destination-token guard the live path runs.
 *
 * NOT checked here: the deposit window. A resumed swap legitimately comes back
 * after it closed, and the honest view then names no address to send to; the
 * caller reads `attested.deposit_deadline` and renders accordingly.
 */
export function verifyStoredDeposit(
  stored: StoredDepositAttestation | null | undefined,
  signer: string | null,
  expected: { intentId: string; owner: string },
): DepositAttestationResult {
  if (!stored?.attestation || !stored.attested) {
    return { ok: false, kind: "unavailable", reason: "stored deposit carries no attestation" };
  }
  const { attested } = stored;
  if (attested.intent_id !== expected.intentId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: `stored deposit attests intent ${attested.intent_id}, record is ${expected.intentId}`,
    };
  }
  if (!expected.owner || canonical(attested.wallet) !== canonical(expected.owner)) {
    return {
      ok: false,
      kind: "unavailable",
      reason:
        `stored deposit attests wallet ${attested.wallet}, record is filed under ` +
        `${expected.owner || "(none)"}; refusing a binding for a different account`,
    };
  }
  if (!SIGNATURE_RE.test(stored.attestation)) {
    return { ok: false, kind: "unavailable", reason: "malformed deposit attestation signature" };
  }
  if (recipientIsDestinationToken(attested.recipient, attested.to_token)) {
    return {
      ok: false,
      kind: "unavailable",
      reason: `payout recipient is the destination token contract (${attested.to_token}); funds sent there are unspendable`,
    };
  }
  try {
    verifyDepositAttestation(attested, stored.attestation, signer);
    return { ok: true };
  } catch (err) {
    return depositRefusal(err);
  }
}

/** The message's own canonicalisation: a 0x address lowercased, base58 verbatim. */
function canonical(value: string): string {
  return value.startsWith("0x") ? value.toLowerCase() : value;
}
