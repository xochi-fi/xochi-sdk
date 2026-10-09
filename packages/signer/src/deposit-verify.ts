/**
 * Deposit-address attestation: rebuild, recover, verify, and bind to the request.
 * Network-free. The Xochi Worker forwards `deposit_address` / `deposit_attestation` /
 * `deposit_deadline` verbatim but does not echo `from_amount`; a Worker client passes
 * the requested `from_amount` into the quote it hands `depositAttestationFields`.
 * The route-level rules (the `xochiDepositQuote` wrapper) live in Riddler's private e2e harness.
 */

import { verifyMessage } from "ethers";

import { assertFromAmountWithinMax, type QuoteRequestParams } from "./intent-verify";

/** Version tag that opens the signed message. Bump only in lockstep with the server. */
export const DEPOSIT_ATTESTATION_VERSION = "xochi-deposit-attestation:v3";

/**
 * The quote fields the attestation is signed over, in signing order.
 *
 * Optional fields are `| null` rather than `?:`: they are always present in the
 * message as an empty line, so a caller must decide what they are.
 */
export interface DepositAttestationFields {
  intent_id: string;
  quote_id: string;
  wallet: string;
  from_chain_id: number;
  from_token: string;
  from_amount: string;
  deposit_address: string;
  deposit_deadline: number | null;
  /**
   * Where a FAILED deposit is returned. Caller-supplied, and precedence 1 in the
   * server's `DepositRefund.refund_dest_address/2`, ahead of `wallet` and the
   * on-chain sender. Grouped with the origin fields because a refund executes on
   * the origin chain (validated against `from_chain_id`, not `to_chain_id`).
   */
  refund_address: string | null;
  to_chain_id: number;
  to_token: string;
  to_amount: string;
  min_to_amount: string;
  recipient: string;
  /** Stealth routes only, and the actual destination there. */
  stealth_spending_pub_key: string | null;
  stealth_viewing_pub_key: string | null;
  /** Resolved settlement type: "public" | "stealth" | "shielded". */
  settlement_preference: string;
}

/** Field names in signing order, used for injection-error reporting. */
const ATTESTED_FIELD_ORDER = [
  "version",
  "intent_id",
  "quote_id",
  "wallet",
  "from_chain_id",
  "from_token",
  "from_amount",
  "deposit_address",
  "deposit_deadline",
  "refund_address",
  "to_chain_id",
  "to_token",
  "to_amount",
  "min_to_amount",
  "recipient",
  "stealth_spending_pub_key",
  "stealth_viewing_pub_key",
  "settlement_preference",
] as const;

/**
 * A deposit-route quote reduced to what a caller needs to pay. Every field here
 * is attested under v2, `deadline` and `recipient` included.
 */
export interface DepositInstruction {
  /** ATTESTED. Base58 T-address for Tron origins. Send exactly `amount` of `token` here. */
  address: string;
  /** ATTESTED. Origin token contract, verbatim from the quote (base58 on Tron). */
  token: string;
  /** ATTESTED. Base units, as a decimal string. Not human-scaled. */
  amount: string;
  /** ATTESTED. Chain the deposit must be made on. */
  chainId: number;
  /** ATTESTED (v2). Unix seconds after which the deposit is no longer honoured. */
  deadline: number | null;
  /**
   * ATTESTED (v2). Destination payout, resolved as the server resolves it (the
   * requested `recipient_address`, else `wallet`). On a **stealth** route this is
   * the connected wallet and NOT where the funds land; see the module header.
   */
  recipient: string | null;
}

export interface DepositQuoteResult {
  intentId: string;
  quoteId: string;
  deposit: DepositInstruction;
  /**
   * The attestation verified against the pinned signer AND the attested fields
   * matched the request. Always true when returned; the call throws otherwise.
   * Says the deal signed is the deal asked for, never that it gets delivered.
   */
  attestationVerified: true;
  /** Signer the attestation recovered to, lowercased. */
  attestationSigner: string;
  /** The unmodified quote, for fields this helper does not surface. */
  raw: Record<string, any>;
  /**
   * Set only under `checkAdvertisedSigner`, when the cross-check disagreed with
   * the pin or could not be run at all. Advisory: the pin decided either way.
   */
  advertisedSignerWarning?: string;
}

export class DepositAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositAttestationError";
  }
}

/**
 * The attestation verified, but describes a different route than the one
 * requested: legitimately signed bytes that are not an answer to this question.
 * Subclasses `DepositAttestationError` so one `instanceof` still catches every
 * reason not to send funds.
 */
export class DepositQuoteMismatchError extends DepositAttestationError {
  constructor(message: string) {
    super(message);
    this.name = "DepositQuoteMismatchError";
  }
}

/**
 * True when the payout address IS the destination token contract. raxol#869
 * settled real funds at one unspendably while Riddler reported `completed`, and
 * no signature can catch it: the venue did send the funds where it said it
 * would. A check on the caller's own inputs, so it runs before the quote is
 * requested. Compared through the message's own canonicalisation, so `0x`
 * matches case-insensitively and base58 verbatim.
 */
export function recipientIsDestinationToken(recipient: string, toToken: string): boolean {
  if (!recipient || !toToken) return false;
  return normalizeAddress(recipient) === normalizeAddress(toToken);
}

/**
 * How much of the attested deposit window must remain for a route to be worth
 * offering. A deposit is a human action, and a narrower window hands the user a
 * deposit that arrives too late to fill and takes the refund path instead.
 */
export const DEPOSIT_MIN_WINDOW_SECONDS = 60;

/**
 * A record of which intent each deposit address was issued for. `Map<string,
 * string>` satisfies it as-is; the interface exists so a caller with a longer
 * memory than one process can supply one.
 */
export interface SeenDepositAddressStore {
  get(depositAddress: string): string | undefined;
  set(depositAddress: string, intentId: string): void;
}

/**
 * Records a deposit address against its intent, or reports a repeat under a
 * different one.
 *
 * The motivating bug (axol-io/Riddler#853, and the blue/green cutover in #872)
 * is the address generator keeping its HD cursor in process memory: a restart
 * rewinds it and re-derives an address already assigned to a LIVE intent
 * belonging to someone else (user A gets index 3, restart, user B gets index 3).
 *
 * Both attestations are genuine, so neither signature verification nor this can
 * separate them: user B has never seen intent_A. **The cross-user case is not
 * covered** and nothing client-side can cover it; the fix is a persisted,
 * monotonic cursor plus a uniqueness constraint on the issued address, which
 * Riddler owns. This is a tripwire, not a ledger. It catches one client served
 * the same address under two different intent ids.
 *
 * A re-quote gets a fresh intent id, so a server handing the same address to a
 * re-quote reads as a collision and is refused, down the same code path as a
 * genuine one. That is why the refusal names both intents. Not persisted by
 * default, since a stale entry surviving a restart could block a legitimately
 * re-issued address after a real rotation: a caller who wants that trade passes
 * a store that makes it.
 *
 * Keyed through `normalizeAddress`, the same function that decides what "the
 * same address" means in the signed message. A raw key looks right for
 * case-sensitive base58, but deposit routes are not Tron-only (a non-TVM origin
 * falls back to the solver's own `0x` address) and the server's signature
 * verifies for either casing of a `0x` address, so a raw key lets one address
 * under two spellings occupy two slots.
 */
export function recordDepositAddress(
  store: SeenDepositAddressStore,
  depositAddress: string,
  intentId: string,
): void {
  const key = normalizeAddress(depositAddress);
  const previous = store.get(key);
  // `!= null` rather than `!== undefined`: a store adapter over a backend that
  // reports a miss as `null` would otherwise refuse its first ever record.
  if (previous != null && previous !== intentId) {
    throw new DepositQuoteMismatchError(
      `deposit address ${depositAddress} was already issued for intent ${previous}, and this quote ` +
        `is intent ${intentId} -- the per-intent binding the attestation rests on did not hold for ` +
        "this client. Both attestations can be individually genuine, so this is either the server " +
        "re-issuing an address (Riddler#853) or a benign re-quote this check cannot tell apart. " +
        "Do NOT send funds until you know which.",
    );
  }
  store.set(key, intentId);
}

/**
 * Cross-checks the pinned attestation signer against the one the solver
 * advertises in `/xochi/capabilities`.
 *
 * **Not a trust anchor.** The pin stays the sole one and
 * `verifyDepositAttestation` stays fail-closed against it; reading the
 * advertised key as authoritative is the mistake `attestationSigner` was made
 * required to prevent. This only adds a signal, so an operator who rotated one
 * half of a pair sees that instead of something that reads like tampering.
 * Absent pin or absent advertised key is not a mismatch.
 */
export function attestationSignerConsistency(
  pinnedSigner: string | null | undefined,
  capabilitiesSigner: string | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!pinnedSigner || !capabilitiesSigner) return { ok: true };
  if (pinnedSigner.toLowerCase() !== capabilitiesSigner.toLowerCase()) {
    return {
      ok: false,
      reason:
        `pinned deposit-attestation signer ${pinnedSigner.toLowerCase()} != solver-advertised ` +
        `${capabilitiesSigner.toLowerCase()} -- the pin still decides, so a genuine quote signed by ` +
        "the advertised key will be refused. Usually an operator rotated one half of a pair.",
    };
  }
  return { ok: true };
}

/**
 * Mirrors the server's `normalize_address/1`: a `0x`-prefixed value is
 * lowercased, anything else left byte-for-byte alone. The prefix check is
 * case-sensitive like the server's `"0x" <> _` pattern; a `0X` value is not
 * lowercased on either side, so treating it as EVM would diverge.
 */
function normalizeAddress(address: string): string {
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

/**
 * Encodes an optional value. Absent is an EMPTY line, not omitted and not
 * `"null"`, which collides with a literal `"null"` and is not what the server
 * writes.
 */
function optional(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "number" ? String(value) : normalizeAddress(value);
}

/**
 * Rebuilds the byte-exact signed message: a fixed 18 fields, `\n`-joined. An
 * absent optional is an empty line, never a dropped one, which would shift every
 * field after it and sign a different deal. `settlement_preference` is last so a
 * public-route message does not end in `\n\n`; do not trim.
 *
 * `\n` is the delimiter and nothing escapes it, so two field sets can sign
 * identical bytes: `intent_id: "a\nB", quote_id: "C"` and `intent_id: "a",
 * quote_id: "B\nC"` produce the same message. `wallet` and `recipient` are
 * caller-supplied under v2 and the server's request validation does NOT stop a
 * trailing newline, so the guard has a live case; the server refuses the same
 * way, and escaping instead would break parity.
 */
export function buildDepositAttestationMessage(fields: DepositAttestationFields): string {
  const parts = [
    DEPOSIT_ATTESTATION_VERSION,
    fields.intent_id,
    fields.quote_id,
    normalizeAddress(fields.wallet),
    String(fields.from_chain_id),
    normalizeAddress(fields.from_token),
    String(fields.from_amount),
    normalizeAddress(fields.deposit_address),
    optional(fields.deposit_deadline),
    optional(fields.refund_address),
    String(fields.to_chain_id),
    normalizeAddress(fields.to_token),
    String(fields.to_amount),
    String(fields.min_to_amount),
    normalizeAddress(fields.recipient),
    optional(fields.stealth_spending_pub_key),
    optional(fields.stealth_viewing_pub_key),
    String(fields.settlement_preference),
  ];

  const injected = parts.findIndex((p) => typeof p === "string" && p.includes("\n"));
  if (injected !== -1) {
    throw new DepositAttestationError(
      `${ATTESTED_FIELD_ORDER[injected]} contains a newline, which is the attestation's field ` +
        "delimiter -- refusing to build a message whose field boundaries are ambiguous",
    );
  }

  return parts.join("\n");
}

/** Recovers the attesting address (lowercased) from an attestation over `fields`. */
export function recoverDepositAttestationSigner(
  fields: DepositAttestationFields,
  attestation: string,
): string {
  return verifyMessage(buildDepositAttestationMessage(fields), attestation).toLowerCase();
}

/**
 * Fail-closed check that `attestation` was produced by `expectedSigner` over
 * exactly these fields. Throws `DepositAttestationError` otherwise. Every
 * argument is required and there is no "skip if absent" branch: a quote with no
 * attestation is precisely the case an attacker can manufacture.
 */
export function verifyDepositAttestation(
  fields: DepositAttestationFields,
  attestation: string | null | undefined,
  expectedSigner: string | null | undefined,
): void {
  if (!attestation) {
    throw new DepositAttestationError(
      "quote has no deposit_attestation -- refusing to send funds to an unattested address",
    );
  }
  if (!expectedSigner) {
    throw new DepositAttestationError(
      "no deposit_attestation_signer to pin against -- fetch it from GET /xochi/capabilities first",
    );
  }
  if (!fields.deposit_address) {
    throw new DepositAttestationError("quote has no deposit_address to verify");
  }

  let recovered: string;
  try {
    recovered = recoverDepositAttestationSigner(fields, attestation);
  } catch (e) {
    throw new DepositAttestationError(
      `deposit_attestation is not a recoverable signature: ${(e as Error).message}`,
    );
  }

  if (recovered !== expectedSigner.toLowerCase()) {
    throw new DepositAttestationError(
      `deposit_attestation recovered to ${recovered}, expected ${expectedSigner.toLowerCase()} -- ` +
        "either the quote was tampered with in transit, or the server signed a different deal " +
        "than the one requested (the message is rebuilt from your own request parameters, so a " +
        "quote issued for another chain, token, wallet or recipient will not recover). " +
        "Do NOT send funds.",
    );
  }
}

/** Reads a quote field under its snake_case or camelCase spelling. */
function quoteField(quote: Record<string, any>, snakeKey: string, camelKey: string): unknown {
  return quote[snakeKey] ?? quote[camelKey];
}

/**
 * Assembles the attested field set for a quote.
 *
 * **Half of it comes from `params`, not from `quote`, and that is the point.**
 * `POST /xochi/quote` does not echo the request back (no `wallet`, no
 * `from_token`, no `to_token`, no stealth keys, chain ids only inside `route`;
 * Riddler's `QuoteResponse.to_json/1`), and rebuilding those from the request
 * collapses "is this signature valid" and "is this quote answering my question"
 * into one operation.
 *
 * Server-chosen values (the ids, the deposit address and deadline, the amounts)
 * come from the quote. `from_amount` included: on an `exact_output` quote the
 * server computes it and `assertDepositQuoteMatchesRequest` bounds it against
 * the caller's ceiling. `recipient` resolves as the server resolves it.
 */
export function depositAttestationFields(
  quote: Record<string, any>,
  params: QuoteRequestParams,
): DepositAttestationFields {
  // Message inputs, not things to compare afterwards: absent, `String(undefined)`
  // and `Number(undefined)` sign "" and "NaN" into the message, whose only
  // symptom is a recovery failure blamed on tampering.
  for (const [snake, camel] of [
    ["wallet", "wallet"],
    ["from_chain_id", "fromChainId"],
    ["from_token", "fromToken"],
    ["to_chain_id", "toChainId"],
    ["to_token", "toToken"],
  ] as const) {
    if (requestedParam(params, snake, camel) === undefined) {
      throw new DepositAttestationError(
        `${snake} is required to verify a deposit attestation: the quote response does not echo ` +
          "it, so the signed message is rebuilt from your request. Without it there is nothing to " +
          "verify against. Do NOT send funds.",
      );
    }
  }

  const deadline = quoteField(quote, "deposit_deadline", "depositDeadline");
  const wallet = String(requestedParam(params, "wallet", "wallet"));
  const recipient = requestedParam(params, "recipient_address", "recipientAddress");

  return {
    // Server-chosen: only the response has these.
    intent_id: quote.intent_id ?? quote.intentId,
    quote_id: quote.quote_id ?? quote.quoteId,
    from_amount: String(quoteField(quote, "from_amount", "fromAmount")),
    deposit_address: quoteField(quote, "deposit_address", "depositAddress") as string,
    deposit_deadline: deadline === undefined || deadline === null ? null : Number(deadline),
    to_amount: String(quoteField(quote, "to_amount", "toAmount")),
    min_to_amount: String(quoteField(quote, "min_to_amount", "minToAmount")),

    // Caller-supplied: rebuilding these from the request is what binds the
    // attestation to this caller.
    wallet,
    from_chain_id: Number(requestedParam(params, "from_chain_id", "fromChainId")),
    from_token: String(requestedParam(params, "from_token", "fromToken") ?? ""),
    to_chain_id: Number(requestedParam(params, "to_chain_id", "toChainId")),
    to_token: String(requestedParam(params, "to_token", "toToken") ?? ""),
    recipient: recipient === undefined ? wallet : String(recipient),
    // From the request, not the response: sourcing it from the quote would trust
    // the value under attack. Absent stays null, since the server's
    // `optional_address` writes an empty line and its fallback to `wallet`
    // happens at refund time, not signing time.
    refund_address:
      (requestedParam(params, "refund_address", "refundAddress") as string) ?? null,
    stealth_spending_pub_key:
      (requestedParam(params, "stealth_spending_pub_key", "stealthSpendingPubKey") as string) ?? null,
    stealth_viewing_pub_key:
      (requestedParam(params, "stealth_viewing_pub_key", "stealthViewingPubKey") as string) ?? null,
    settlement_preference: String(
      requestedParam(params, "settlement_preference", "settlementPreference") ?? "public",
    ),
  };
}

/** Reads a request param under its snake_case or camelCase spelling. */
function requestedParam(params: QuoteRequestParams, snakeKey: string, camelKey: string): unknown {
  const p = params as Record<string, unknown>;
  const snake = p[snakeKey];
  if (snake !== undefined && snake !== null) return snake;
  const camel = p[camelKey];
  return camel !== undefined && camel !== null ? camel : undefined;
}

/** Compares base-unit amounts numerically when both are integer strings, so "0100" == "100". */
function sameAmount(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) === BigInt(b);
  return a === b;
}

/**
 * Refuses a recipient, wallet or refund address that starts `0x` without being `0x` +
 * hex: the deposit attestation lowercases it (axol-io/Riddler#1254), so it cannot tell
 * it from a differently-cased party id. Run on the request by `xochiDepositQuote` before
 * the quote call and on the attested fields by `assertDepositQuoteMatchesRequest`.
 */
export function assertDepositPartiesCaseBindable(parties: {
  recipient?: unknown;
  wallet?: unknown;
  refund_address?: unknown;
}): void {
  for (const [name, value] of Object.entries(parties)) {
    if (typeof value === "string" && value.startsWith("0x") && !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new DepositQuoteMismatchError(
        `${name} ${JSON.stringify(value)} starts with 0x but is not hex, so the deposit attestation ` +
          "lowercases it and cannot tell it from a differently-cased party id (axol-io/Riddler#1254). " +
          "This client refuses such a value until the attestation binds its case. Do NOT send funds.",
      );
    }
  }
}

/**
 * Asserts the server-chosen fields describe the deal the caller asked for: the
 * `from_amount` and the recipient the quote *displays*. Chain and token are not
 * compared, because `depositAttestationFields` builds that half of the message
 * *from* the request, so the binding lives in the signature. On an `exact_output`
 * route the server picks `from_amount`, so the equality becomes the caller's
 * `max_from_amount` ceiling rather than being skipped: this path hands the user a
 * number to send by hand, so an unbounded server-chosen amount is the whole loss.
 *
 * Still call this. The signature covers the fields as assembled, this covers
 * what the assembly could not reach.
 */
export function assertDepositQuoteMatchesRequest(
  params: QuoteRequestParams,
  fields: DepositAttestationFields,
  quote: Record<string, any> = {},
): void {
  // Same refusal as the pull path's `assertNoEscrowEnvelope`, in this module's error
  // class: this SDK does not run the escrow binding (SPEC.md §2.3), so a deposit quote
  // carrying an `escrow` envelope has an unchecked orderId deciding who is paid.
  if (quote.escrow !== undefined && quote.escrow !== null) {
    throw new DepositQuoteMismatchError(
      "deposit quote carries an escrow envelope, and this SDK does not run the escrow binding " +
        "(SPEC.md §2.3: recompute orderId and destCommitment against a caller-pinned escrow) -- who " +
        "the escrow pays is unchecked. Do NOT send funds.",
    );
  }
  const swapKind = requestedParam(params, "swap_kind", "swapKind") ?? "exact_input";
  const wantAmount = requestedParam(params, "from_amount", "fromAmount");
  if (swapKind === "exact_output") {
    // Rethrown as a DepositQuoteMismatchError so one `instanceof
    // DepositAttestationError` catches every reason not to send funds.
    try {
      assertFromAmountWithinMax(params, fields.from_amount, "attested");
    } catch (e) {
      throw new DepositQuoteMismatchError(`${(e as Error).message} Do NOT send funds.`);
    }
  } else if (wantAmount !== undefined) {
    if (!sameAmount(String(wantAmount), fields.from_amount)) {
      throw new DepositQuoteMismatchError(
        `attested from_amount ${fields.from_amount} != requested ${wantAmount} -- ` +
          "sending the attested amount would fund a different intent. Do NOT send funds.",
      );
    }
  }

  // The attestation cannot bind the CASE of a value that starts `0x` without being
  // `0x` + hex: `normalizeAddress` is the DIGEST rule (Riddler's `normalize_address/1`)
  // and folds every `0x`-prefixed value, which includes a Canton party id whose
  // free-text hint starts `0x` (`0xAlice::1220...`, spec 0.8.0). So a genuine
  // attestation for `0xalice::1220...` -- another party, obtainable by anyone, since
  // quoting is not authenticated by wallet -- verifies against a request for
  // `0xAlice::1220...`, and the displayed `recipient_address` below cannot catch it:
  // it is unsigned and arrives on the same channel as the quote. Refused outright for
  // the recipient, the wallet and the refund address until axol-io/Riddler#1254 stops
  // the server folding them and bumps `deposit_attestation_version`.
  assertDepositPartiesCaseBindable({
    recipient: fields.recipient,
    wallet: fields.wallet,
    refund_address: fields.refund_address,
  });

  // v2 signs `recipient`, so a divergence between the displayed and the attested
  // one means the address shown to the user is not the one the deal was signed
  // for. Worth refusing even though the signature bound the real one. Case is
  // folded here for `0x` + hex alone, every other encoding being case-sensitive;
  // this is a display-consistency check, not a binding, since the displayed value
  // is unsigned.
  const gotRecipient = quote.recipient_address ?? quote.recipientAddress;
  if (gotRecipient !== undefined && gotRecipient !== null) {
    const shown = String(gotRecipient);
    const hex = /^0x[0-9a-f]+$/i;
    const same =
      hex.test(shown) && hex.test(fields.recipient)
        ? shown.toLowerCase() === fields.recipient.toLowerCase()
        : shown === fields.recipient;
    if (!same) {
      throw new DepositQuoteMismatchError(
        `quote recipient ${gotRecipient} != attested ${fields.recipient} -- the address shown is ` +
          "not the one this quote was signed for. Do NOT send funds.",
      );
    }
  }

  // Also here, not only in `xochiDepositQuote`: the module header points
  // integrators at this function, so a guard living only in the wrapper is one
  // the documented recipe never gets.
  if (recipientIsDestinationToken(fields.recipient, fields.to_token)) {
    throw new DepositQuoteMismatchError(
      `the payout recipient is the destination token contract (${fields.to_token}) -- funds sent ` +
        "there are unspendable, and the settlement would still be reported completed (raxol#869). " +
        "Do NOT send funds.",
    );
  }

  // A correctly-signed, request-matching quote stays verifiable forever, so an
  // attacker who obtains one early can hold it and inject it after the window
  // closes, landing the funds too late to fill. Riddler always sets a deadline on
  // an attested deposit route, so an absent one is malformed.
  //
  // No `now` injection point, for the reason `assertIntentMatchesRequest` has
  // none: an optional clock on a security assertion is a bypass wearing a test
  // affordance's name. Tests move the clock instead.
  if (fields.deposit_deadline === null || fields.deposit_deadline === undefined) {
    throw new DepositQuoteMismatchError(
      "deposit quote carries no attested deadline -- Riddler always sets one on a deposit route, so " +
        "this quote is malformed. Do NOT send funds.",
    );
  }
  const secondsLeft = fields.deposit_deadline - Math.floor(Date.now() / 1000);
  if (secondsLeft < DEPOSIT_MIN_WINDOW_SECONDS) {
    throw new DepositQuoteMismatchError(
      (secondsLeft <= 0
        ? `the attested deposit window closed ${-secondsLeft}s ago`
        : `the attested deposit window closes in ${secondsLeft}s, under the ` +
          `${DEPOSIT_MIN_WINDOW_SECONDS}s minimum`) +
        " -- a deposit that arrives after it is refunded rather than filled. Do NOT send funds.",
    );
  }
}
