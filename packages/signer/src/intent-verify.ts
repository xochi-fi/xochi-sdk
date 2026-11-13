/**
 * Value checks over a server-built XochiIntent and its origin pull, against the caller's
 * request. Network-free and transport-agnostic: they read the signables Riddler builds,
 * which reach a client byte-identical whether it talks to Riddler's /xochi/* or to the
 * Xochi Worker's /api/* (which forwards `eip712` and `pull_authorization` verbatim).
 */

import { ethers } from "ethers";
import type { Eip712Signable, Hex } from "./types";
import { PERMIT2_ADDRESS } from "./permit2";
import { pick, sameAddressish, sameNumeric } from "./compare";
import {
  assertEscrowBinding,
  openAuthDigest,
  type DestOpening,
  type EscrowPullAuth,
  type OrderTerms,
  type PinnedEscrows,
} from "./escrow";
import { resolvePinnedEscrow } from "./escrow-pin";
import { assertCantonDestination } from "./canton";
import { uintSpelling, type UintLike } from "./uint";

/**
 * The request fields the checks compare against, in either spelling. Only what the caller
 * supplied is checked, except the server defaults knowable client-side (`recipient`
 * falls back to `wallet`, `settlementPreference` to `"public"`).
 */
export interface QuoteRequestParams {
  wallet?: string;
  from_chain_id?: number;
  fromChainId?: number;
  to_chain_id?: number;
  toChainId?: number;
  from_token?: string;
  fromToken?: string;
  to_token?: string;
  toToken?: string;
  settlement_preference?: string;
  settlementPreference?: string;
  swap_kind?: string;
  swapKind?: string;
  output_amount?: string | number;
  outputAmount?: string | number;
  from_amount?: string | number;
  fromAmount?: string | number;
  max_from_amount?: string | number;
  maxFromAmount?: string | number;
  recipient_address?: string;
  recipientAddress?: string;
  refund_address?: string;
  refundAddress?: string;
  stealth_spending_pub_key?: string;
  stealthSpendingPubKey?: string;
  stealth_viewing_pub_key?: string;
  stealthViewingPubKey?: string;
  [key: string]: unknown;
}

export class XochiIntentMismatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XochiIntentMismatchError";
  }
}

/**
 * Refuses any quote carrying an `escrow` envelope (SPEC.md §5.2/§6) on a path that does not
 * run the escrow binding: `assertPullMatchesIntent` and the deposit path. On an escrow
 * corridor the pull's `to`/`spender` is the escrow contract and WHO the lock pays is decided
 * by the `orderId` the pull binds (the ERC-3009 `nonce`, the Permit2 `witness.orderId`), whose
 * `OrderTerms.destCommitment` names the destination. Those checks do not recompute that
 * `orderId`, so they would pass a quote whose intent names your recipient while its pull
 * locks your funds under an attacker's destination. An escrow-bearing quote is signable only
 * through {@link assertEscrowQuoteMatchesRequest}, which runs the SPEC.md §2.3 binding against
 * an escrow the CALLER pinned per origin chain. `escrow: null` is read as absent, which is
 * what the served schema means by escrow being off.
 */
export function assertNoEscrowEnvelope(quote: Record<string, any> | null | undefined): void {
  const escrow = quote?.escrow;
  if (escrow === undefined || escrow === null) return;
  const orderId = typeof escrow === "object" ? (escrow.order_id ?? escrow.orderId) : undefined;
  throw new XochiIntentMismatchError(
    `quote carries an escrow envelope${orderId ? ` (order_id ${JSON.stringify(orderId)})` : ""}, and this ` +
      "check does not run the escrow binding (SPEC.md §2.3: recompute orderId and destCommitment, held to a " +
      "caller-pinned escrow for the origin chain). Without it the pull's orderId -- which decides who the " +
      "escrow pays -- is unchecked. Verify it with assertEscrowQuoteMatchesRequest instead. Refusing to sign.",
  );
}

/**
 * Upper bound on how far ahead an intent's `deadline` may sit, measured from the local
 * wall clock. Riddler issues quotes with `expires_at = now + @quote_ttl_seconds` (300s,
 * hardcoded), so an hour is 12x the real window; the slack buys clock tolerance, and a
 * client under ~55 minutes slow still verifies honest quotes. That tolerance is
 * one-directional: a SLOW clock fails closed, a FAST clock fails OPEN. The wall clock is
 * the only value on this path the server does not supply, and nothing here can detect
 * that it is wrong.
 *
 * This is the anchor everything else hangs from, since `assertPullMatchesIntent` measures
 * the pull's expiry FROM this deadline: unchecked, a quote naming the year 3000 gets a
 * pull valid until the year 3000 and both checks pass. There is no injection point for
 * "now", and do not add one: an optional `{ now }` is an unauthenticated bypass of this
 * bound in the public API (`{ now: 9e15 }` accepts any deadline), and it keeps the
 * `Date.now()` default production runs out of the suite entirely.
 */
export const MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS = 3600;

/**
 * Renders a second count as a coarse human span for error messages. Sub-day resolution
 * matters: clock skew is the likeliest failure this check produces, and a days-only span
 * renders all of it as "0 days".
 */
function humanSpan(seconds: bigint): string {
  const s = seconds < 0n ? -seconds : seconds;
  if (s < 120n) return `${s}s`;
  if (s < 7200n) return `${s / 60n} minutes`;
  if (s < 172800n) return `${s / 3600n} hours`;
  if (s < 63072000n) return `${s / 86400n} days`;
  return `${s / 31536000n} years`;
}

/**
 * Bounds a server-supplied intent deadline against the local wall clock. Called by both
 * `assertIntentMatchesRequest` and `assertPullMatchesIntent` so each is sound alone: both
 * are exported, so "the other one runs first" is a property of two call sites and not of
 * the function. No lower bound; a lapsed deadline is the server's to reject.
 */
function assertDeadlineWithinWallClockBound(deadline: unknown): void {
  // Not a hole: `XOCHI_TYPES` types `deadline` as `uint256` and ethers refuses to encode
  // undefined/null/[]/"" as one, so an intent skipping this branch cannot be signed at
  // all. A deadline is not optional.
  if (deadline === undefined || deadline === null) return;

  let value: bigint;
  try {
    value = BigInt(String(deadline));
  } catch {
    throw new XochiIntentMismatchError(
      `intent deadline ${JSON.stringify(deadline)} is not an integer unix timestamp -- ` +
        "cannot bound how long this signature stays live. Refusing to sign.",
    );
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const ahead = value - now;
  if (ahead > BigInt(MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS)) {
    throw new XochiIntentMismatchError(
      `intent deadline ${value} is ${humanSpan(ahead)} ahead of now (${now}), past the ` +
        `${MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS}s ceiling -- a quote lives ~5 minutes, and this ` +
        "signature would stay spendable for that whole span. Refusing to sign. " +
        "(If the quote is honest, check the local clock: a clock running slow rejects good quotes.)",
    );
  }
}

/**
 * Asserts the intent the server wants signed is the one that was requested.
 * `signXochiIntent` checks the schema; this checks the values, and it is the only layer
 * that can, because the comparison needs the request.
 *
 * Only fields the caller supplied are checked: inventing constraints rejects legitimate
 * quotes. `toAmount` on an `exact_input` swap is the quoted output after fees and
 * unpredictable client-side; on `exact_output` it is what the caller asked for, so it is
 * checked there and only there.
 *
 * Two fields are exceptions, because the server's default is knowable client-side and
 * skipping them leaves the field that decides where funds go unchecked on the common
 * path. `recipient` falls back to `wallet` (`recipient_of/1`, `Xochi.EIP712`, no
 * settlement-mode special case, since a stealth intent names the wallet too), and
 * `--recipient-address` is omitted on every same-VM route. `settlementPreference` falls
 * back to `"public"`, mirroring `xochiQuote`.
 */
export function assertIntentMatchesRequest(
  params: QuoteRequestParams,
  quote: Record<string, any>,
): void {
  const message = quote?.eip712?.message as Record<string, unknown> | undefined;
  if (!message) {
    throw new XochiIntentMismatchError("quote has no eip712.message to verify before signing");
  }

  const fail = (field: string, got: unknown, want: unknown): never => {
    throw new XochiIntentMismatchError(
      `intent ${field} is ${JSON.stringify(got)} but ${JSON.stringify(want)} was requested -- ` +
        "the server is asking for a signature over different terms. Refusing to sign.",
    );
  };

  const wallet = params.wallet;
  if (wallet && !sameAddressish(String(message.wallet ?? ""), String(wallet))) {
    fail("wallet", message.wallet, wallet);
  }

  for (const [field, snake, camel] of [
    ["fromChainId", "from_chain_id", "fromChainId"],
    ["toChainId", "to_chain_id", "toChainId"],
  ] as const) {
    const want = pick(params, snake, camel);
    if (want !== undefined && want !== null && !sameNumeric(message[field], want)) {
      fail(field, message[field], want);
    }
  }

  for (const [field, snake, camel] of [
    ["fromToken", "from_token", "fromToken"],
    ["toToken", "to_token", "toToken"],
  ] as const) {
    const want = pick(params, snake, camel);
    if (want !== undefined && want !== null) {
      if (!sameAddressish(String(message[field] ?? ""), String(want)))
        fail(field, message[field], want);
    }
  }

  // Always checked: absent an explicit recipient the server uses `wallet`, so there
  // is a known-correct expectation either way.
  const wantRecipient = pick(params, "recipient_address", "recipientAddress") ?? wallet;
  if (wantRecipient !== undefined && wantRecipient !== null) {
    if (!sameAddressish(String(message.recipient ?? ""), String(wantRecipient))) {
      fail("recipient", message.recipient, wantRecipient);
    }
  }

  const settlement = pick(params, "settlement_preference", "settlementPreference") ?? "public";
  if (message.settlementPreference !== settlement) {
    fail("settlementPreference", message.settlementPreference, settlement);
  }

  assertDeadlineWithinWallClockBound(message.deadline);

  // swap_kind decides which amount is caller-chosen; an equality against the server-derived
  // one would reject every honest quote. On `exact_output` the derived one is what LEAVES
  // the wallet, so it gets a ceiling instead.
  const swapKind = pick(params, "swap_kind", "swapKind") ?? "exact_input";
  if (swapKind === "exact_output") {
    const want = pick(params, "output_amount", "outputAmount");
    if (want !== undefined && want !== null && !sameNumeric(message.toAmount, want)) {
      fail("toAmount", message.toAmount, want);
    }
    assertFromAmountWithinMax(params, message.fromAmount, "intent");
  } else {
    const want = pick(params, "from_amount", "fromAmount");
    if (want !== undefined && want !== null && !sameNumeric(message.fromAmount, want)) {
      fail("fromAmount", message.fromAmount, want);
    }
  }
}

/**
 * Enforces the caller's `max_from_amount` ceiling on a server-derived origin amount.
 * Required, not optional: with no ceiling nothing bounds what leaves the wallet on an
 * `exact_output` quote, and defaulting to unbounded makes the safe path the one a caller has
 * to know to ask for. Fee validation does not cover it: `assertFeeBreakdownInvariants`
 * reconciles a breakdown against itself and does not bound magnitude. Shared by the pull
 * path and the deposit path: one signs the amount, the other sends it by hand.
 */
export function assertFromAmountWithinMax(
  params: QuoteRequestParams,
  fromAmount: unknown,
  label: string,
): void {
  const max = pick(params, "max_from_amount", "maxFromAmount");
  if (max === undefined || max === null) {
    throw new XochiIntentMismatchError(
      `swap_kind=exact_output requires max_from_amount: the server chooses ${label} from_amount ` +
        `(got ${JSON.stringify(fromAmount)}) and without a ceiling there is nothing to hold it to. ` +
        "Pass the most origin base units you are willing to spend.",
    );
  }

  let got: bigint;
  let ceiling: bigint;
  try {
    got = BigInt(String(fromAmount));
    ceiling = BigInt(String(max));
  } catch {
    throw new XochiIntentMismatchError(
      `cannot compare ${label} from_amount ${JSON.stringify(fromAmount)} against ` +
        `max_from_amount ${JSON.stringify(max)} -- both must be integer base units. Refusing to proceed.`,
    );
  }

  if (got > ceiling) {
    throw new XochiIntentMismatchError(
      `${label} from_amount ${got} exceeds max_from_amount ${ceiling} -- the server priced this ` +
        "exact_output swap above the ceiling you set. Refusing to proceed.",
    );
  }
}

/**
 * Local CEILING on how far a pull's expiry may exceed the intent's deadline. Riddler sets
 * `pull_deadline = expires_at + pull_deadline_buffer_seconds` so an already-broadcast
 * pull can still mine (`Xochi.Adapter.Quote`); that buffer is operator-tunable, so this
 * is a sanity ceiling and not a parity constant. Measured FROM the intent's deadline,
 * which is why `assertPullMatchesIntent` bounds that deadline against the wall clock.
 *
 * Do NOT tighten it to a number read off a live deployment: the buffer is operator-tunable
 * (Riddler#789 §B). The advertised value is applied by {@link pullExpiryBoundSeconds}.
 *
 * The two ceilings compose: worst case a signed pull is live for
 * `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS` plus this, and the advertised value shrinks
 * only the pull half: against a 300s buffer ~7200s becomes ~3900s, not ~900s. Two
 * constants that happen to share a value; do not collapse them.
 */
export const MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS = 3600;

/**
 * The bound actually enforced on a pull's expiry: the TIGHTER of the solver's advertised
 * `pull_deadline_buffer_seconds` and the local ceiling above.
 *
 * Reading a served value is sound because the operation is a MINIMUM against a local
 * constant: the server can only shrink the window it may operate in, and no advertised
 * number makes a longer-lived pull acceptable. Monotonicity is what makes the difference,
 * not provenance: a served value compared against a served value is both halves the
 * attacker's.
 *
 * The advertised value is an availability lever, not a fund-safety one: advertise `0` and
 * every pull outliving the intent deadline is refused, which the server already achieves
 * by declining to quote.
 *
 * Anything that is not a non-negative integer falls through to the local ceiling, as
 * omitting the field does. Absent must NOT fall through to zero, and means the 3600s
 * ceiling rather than UNBOUNDED, which is why this is defaulted where `max_from_amount`
 * is required. Opt-in, not auto-fetched: nothing on the signing path reads
 * `/xochi/capabilities`, advisory metadata that may inform a check and never relax one
 * (`capabilities.ts`).
 */
export function pullExpiryBoundSeconds(advertised: unknown): number {
  if (typeof advertised !== "number" || !Number.isInteger(advertised) || advertised < 0) {
    return MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS;
  }
  return Math.min(advertised, MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS);
}

/** Which of the two pull dialects a signable is, by its type list. */
export function pullKind(pull: Eip712Signable): "erc3009" | "permit2" {
  const types = (pull.types ?? {}) as Record<string, unknown>;
  if (types.ReceiveWithAuthorization) return "erc3009";
  if (types.PermitWitnessTransferFrom) return "permit2";
  throw new XochiIntentMismatchError(
    "pull_authorization is neither an ERC-3009 ReceiveWithAuthorization nor a Permit2 " +
      `PermitWitnessTransferFrom (types: ${Object.keys(types).join(", ") || "none"}) -- ` +
      "refusing to treat an unknown struct as an origin pull.",
  );
}

/**
 * Who a caller expects to receive an origin pull, per chain and method.
 *
 * **Must come from somewhere the server cannot reach**: a build-time constant, a config
 * file, a value a human read once and wrote down. An equality assertion is informative
 * only if at least one side is a value the other party cannot choose, and an attacker
 * holding the channel supplies both halves of a served-vs-served comparison (the same
 * rule behind a required `attestationSigner`, and why `capabilities.ts` ships no
 * `assert*`). `fetchPullRecipients` helps you DISCOVER what to pin; pinning what it
 * returns in the same process is trust-on-first-use, a real posture but one to choose. A
 * chain you list is pinned for BOTH methods: leaving `erc3009` or `permit2` off a chain
 * you named refuses that method ({@link pinnedFor}).
 */
export type PinnedPullRecipients = Readonly<Record<number, MethodPin>>;

/**
 * The chain a pin is keyed on, from the intent and only from the intent. Shared by the
 * recipient pin and the settlement-wallet pin so the two cannot disagree about which chain
 * they mean, and so neither can be tempted back onto `pull.domain.chainId`, the value
 * under the server's control.
 */
export function requireIntentChainId(intent: Record<string, any>, what: string): number {
  if (intent.fromChainId === undefined || intent.fromChainId === null) {
    throw new XochiIntentMismatchError(
      `${what} were pinned, but the intent states no fromChainId to key them on -- the pull's ` +
        "own domain cannot stand in for it, because that is the value under the server's control. " +
        "Refusing to sign.",
    );
  }

  const chainId = Number(intent.fromChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new XochiIntentMismatchError(
      `${what} were pinned, but the intent's fromChainId ${JSON.stringify(intent.fromChainId)} ` +
        "is not a positive integer chain id, so the pin cannot be looked up. Refusing to sign.",
    );
  }
  return chainId;
}

/**
 * One entry of a pin: per chain AND per method, because prod's topology needs both.
 * `pull_recipients` is "ERC-3009 is a different solver EOA per chain, Permit2 one universal
 * proxy", so on a chain serving both methods the two recipients are different addresses,
 * and so are their destinations. Do not collapse it to one value per chain: a pinned
 * chain that omits a method REFUSES ({@link pinnedFor}), so that shape would refuse one
 * of the two honest routes on every fully pinned chain, and a guard whose correct
 * configuration refuses honest quotes is one operators switch off.
 *
 * A method may name **several** accepted values, and the pull matches if it equals any of
 * them. That exists for one job: crossing a planned solver rollover (Riddler rotates the
 * ERC-3009 solver EOA per chain and rewrites `settlementWallet` on every proxy), where a
 * taker holding single values sees every honest quote refused the moment the cutover
 * lands, with an error that reads like an attack.
 *
 * **A set widens what you accept, so it is a window and not a configuration.** Two pinned
 * values means two addresses may receive your funds, and the old one keeps being accepted
 * for as long as you leave it there. Add the incoming value before the cutover, drop the
 * outgoing one after. A pin that has carried two values for a month is a pin someone
 * forgot, and it is strictly weaker than the one value it replaced.
 */
export type MethodPin = {
  erc3009?: string | readonly string[] | null;
  permit2?: string | readonly string[] | null;
};

/**
 * The pinned value for this pull's chain and method, or `null` when the caller pinned
 * nothing that applies. ONE resolver for both pins, so "pinned for this chain and this
 * method" means the same to the recipient check and to the destination check gated on it.
 *
 * Keyed on `intent.fromChainId` ONLY, never on the pull's own `domain.chainId`: a domain
 * fallback is steerable, since the chain check is itself gated on `fromChainId`, so an
 * intent omitting it would skip that check AND choose the lookup key. Both callers are
 * exported and callable alone, so neither may assume `assertIntentMatchesRequest`
 * rejected the missing field first.
 *
 * The two axes grade differently, because only the chain is under the caller's control. A
 * chain absent from the pin is unchecked (`null`), a subset the caller chose that the
 * server cannot move the pull onto without failing the chain check first. A chain present
 * with the method missing REFUSES: `kind` comes from the server's own `pull.types`, so a
 * lenient method axis lets the server pick which half of a pin to dodge.
 * `fetchPullRecipients` omits unadvertised methods, so a pin built from discovery covers
 * only what was advertised. Also throws for what a caller cannot have meant: an empty pin
 * object, a pin against an intent with no chain to key it on, a blank entry, an empty
 * array, or an array holding a blank or non-string entry.
 *
 * Returns the SET of accepted values, always non-empty when non-null. A single string is
 * the one-element case; see {@link MethodPin} for why a set exists and why it is a window
 * rather than a configuration.
 */
export function pinnedFor(
  intent: Record<string, any>,
  kind: "erc3009" | "permit2",
  pinned: Readonly<Record<number, MethodPin>> | undefined,
  /** Plural, for "<plural> were pinned, but ...". */
  plural: string,
  /** Singular noun of the pinned thing: "recipient", "settlement wallet". */
  noun: string,
): readonly string[] | null {
  if (!pinned) return null;

  // An expectation with no content: a config loader that found nothing, a filter that
  // matched nothing. Truthy enough to pass every "was a pin supplied" test (including
  // `xochiExecute`'s skipVerification guard) and empty enough to check nothing.
  if (Object.keys(pinned).length === 0) {
    throw new XochiIntentMismatchError(
      `${plural} were pinned as an empty object, naming no chain at all -- a blank pin is a ` +
        "misconfiguration, not an instruction to skip the check. Refusing to sign.",
    );
  }

  const chainId = requireIntentChainId(intent, plural);

  // A subset the caller chose. See the docblock.
  const forChain = pinned[chainId];
  if (!forChain) return null;

  // Past this point the chain IS pinned, so every remaining gap is either a misconfiguration
  // or the server choosing the method the caller said nothing about. Neither may read as
  // "unpinned".
  const raw = forChain[kind];
  if (raw === undefined || raw === null) {
    const other = kind === "erc3009" ? "permit2" : "erc3009";
    throw new XochiIntentMismatchError(
      `chain ${chainId} is pinned but names no ${kind} ${noun}, and this pull is ${kind}-shaped -- ` +
        `the method comes from the server's own pull.types, so accepting it unchecked would let the ` +
        `server serve ${kind} to dodge your ${other} pin. Pin both methods for a chain you pin at all, ` +
        "or drop the chain. Refusing to sign.",
    );
  }

  // Trimmed because the pin is a CALLER-side value, routinely from a config file or an env
  // var with a trailing newline. The served side is left exactly as sent: normalizing the
  // server's bytes is how a comparison starts accepting things the signer would not.
  const listed = Array.isArray(raw) ? raw : [raw];

  // An empty array is the `{}` and `""` case again: a supplied expectation with nothing in
  // it, which every "was a pin supplied" test reads as covered.
  if (listed.length === 0) {
    throw new XochiIntentMismatchError(
      `the pinned ${kind} ${noun} for chain ${chainId} is an empty list, accepting nothing -- a ` +
        "blank pin is a misconfiguration, not an instruction to skip the check. Refusing to sign.",
    );
  }

  const accepted: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string") {
      throw new XochiIntentMismatchError(
        `the pinned ${kind} ${noun} for chain ${chainId} lists ${JSON.stringify(entry)}, which is ` +
          "not an address. Refusing to sign rather than compare against a value that cannot match.",
      );
    }
    const value = entry.trim();
    if (value === "") {
      throw new XochiIntentMismatchError(
        `the pinned ${kind} ${noun} for chain ${chainId} is empty -- a blank pin is a misconfiguration, ` +
          "not an instruction to skip the check. Refusing to sign.",
      );
    }
    accepted.push(value);
  }
  return accepted;
}

/**
 * Whether a served address matches a pin. One resolver for all five comparison sites, so a
 * set can never mean "any of these" at one of them and "the first of these" at another.
 */
export function pinAccepts(accepted: readonly string[], served: string): boolean {
  return accepted.some((value) => sameAddressish(served, value));
}

/** Renders a pin for an error message: one value bare, several as a list. */
export function describePin(accepted: readonly string[]): string {
  const quoted = accepted.map((value) => JSON.stringify(value));
  return quoted.length === 1 ? quoted[0]! : `any of [${quoted.join(", ")}]`;
}

/**
 * Whether the pull's recipient was actually held to a pin on this quote. Reports what ran,
 * not what was configured: a pin covering only other chains leaves this false, because "the
 * caller passed something" is not "the field that decides where the money goes was
 * checked". Emitted after the signature has gone out: a post-mortem, not a gate.
 */
export function pullRecipientWasChecked(
  quote: Record<string, any>,
  pinned: PinnedPullRecipients | undefined,
): boolean {
  if (!pinned) return false;
  const pull = pick(quote, "pull_authorization", "pullAuthorization") as Eip712Signable | undefined;
  if (!pull?.message) return false;
  const intent = quote?.eip712?.message as Record<string, any> | undefined;
  if (!intent) return false;
  // The SAME resolver the check uses: a flag that misreports what ran is worse than no
  // flag.
  try {
    return pinnedFor(intent, pullKind(pull), pinned, "pull recipients", "recipient") !== null;
  } catch {
    // Refusals are the caller's to see from the check itself. By the time this runs the quote
    // is signed and executed, so a throw would replace a result with an error about
    // reporting.
    return false;
  }
}

export interface AssertPullOptions {
  /**
   * Caller-pinned pull recipients. When a chain and method are pinned, the pull's `to` /
   * `spender` is held to them; otherwise that field goes unchecked. Both spellings, read
   * through `pick`: a pin forwarded out of `QuoteRequestParams` can carry either.
   */
  expectedPullRecipients?: PinnedPullRecipients;
  expected_pull_recipients?: PinnedPullRecipients;
  /**
   * The solver's advertised `pull_deadline_buffer_seconds`, from a capabilities read the
   * caller already made. Tightens the pull-expiry bound to the smaller of it and
   * {@link MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS}; absent or malformed leaves the local
   * ceiling in force.
   */
  advertisedPullDeadlineBufferSeconds?: number | null;
  advertised_pull_deadline_buffer_seconds?: number | null;
  /**
   * Caller-pinned escrow per origin chain ({@link PinnedEscrows}). A pull to it is refused.
   */
  expectedEscrows?: PinnedEscrows;
  expected_escrows?: PinnedEscrows;
}

/**
 * A pull whose `to`/`spender` names the escrow pinned for its origin chain (the same
 * caller-held {@link PinnedEscrows} `assertEscrowBinding` takes, obtained outside the
 * venue channel, SPEC.md §6) is refused here: it is escrow-bearing whatever the quote says,
 * and only {@link assertEscrowQuoteMatchesRequest} runs the §2.3 binding, which needs the
 * envelope's terms. Not a recipient pin and never merged into one.
 */
function assertPullNotToPinnedEscrow(
  intent: Record<string, any>,
  kind: "erc3009" | "permit2",
  m: Record<string, any>,
  opts: AssertPullOptions,
): void {
  const pins = pick(opts as Record<string, unknown>, "expected_escrows", "expectedEscrows") as
    | PinnedEscrows
    | undefined;
  if (pins === undefined || pins === null) return;
  if (typeof pins !== "object" || Array.isArray(pins)) {
    throw new XochiIntentMismatchError(
      `expectedEscrows must map origin chain ids to escrow addresses, got ${JSON.stringify(pins)}. Refusing to sign.`,
    );
  }
  // Keyed on the canonical chain id, not the server's spelling, so a `"0x2105"` intent still
  // meets a `{8453: ESCROW}` pin. Read by `resolvePinnedEscrow`, as `assertEscrowBinding` does.
  const chainKey = requireIntentChainId(intent, "expectedEscrows");
  const pinned = resolvePinnedEscrow(
    pins,
    chainKey,
    (message) =>
      new XochiIntentMismatchError(
        `${message} -- the escrow pin cannot be compared against. Refusing to sign.`,
      ),
  );
  if (pinned === undefined) return;
  const served = kind === "erc3009" ? m.to : m.spender;
  if (served !== undefined && served !== null && sameAddressish(String(served), pinned)) {
    throw new XochiIntentMismatchError(
      `pull_authorization ${kind === "erc3009" ? "to" : "spender"} is the escrow you pinned for chain ` +
        `${chainKey} (${pinned}), so this pull is escrow-bearing even though the quote carries no usable ` +
        "escrow envelope, and there are no order terms to bind it to (SPEC.md §2.3, §6). Refusing to sign.",
    );
  }
}

/** A served pull, held to its intent on every axis but who receives it. */
interface CheckedPull {
  intent: Record<string, any>;
  kind: "erc3009" | "permit2";
  message: Record<string, any>;
  domain: Record<string, any>;
}

/**
 * Holds a served pull to the intent on chain, token, amount, the Permit2 contract and the
 * validity window: every axis but WHO receives it, which the two callers bind differently (a
 * caller pin, or the escrow binding). `null` when the quote carries no pull.
 */
function assertPullBodyMatchesIntent(
  quote: Record<string, any>,
  opts: AssertPullOptions,
): CheckedPull | null {
  const pull = pick(quote, "pull_authorization", "pullAuthorization") as Eip712Signable | undefined;
  if (!pull?.message) return null;

  const intent = quote?.eip712?.message as Record<string, any> | undefined;
  if (!intent) {
    throw new XochiIntentMismatchError(
      "quote carries a pull_authorization but no eip712.message to anchor it to -- " +
        "there is nothing to check the pull against. Refusing to sign.",
    );
  }

  const kind = pullKind(pull);
  const m = pull.message as Record<string, any>;
  const domain = (pull.domain ?? {}) as Record<string, any>;

  const fail = (what: string, got: unknown, want: unknown): never => {
    throw new XochiIntentMismatchError(
      `pull_authorization ${what} is ${JSON.stringify(got)} but the intent says ${JSON.stringify(want)} -- ` +
        "refusing to sign an authorization that does not move this intent's funds.",
    );
  };

  const intentAmount = intent.fromAmount;
  const pulled = kind === "erc3009" ? m.value : m.permitted?.amount;
  if (intentAmount !== undefined && pulled !== undefined && !sameNumeric(pulled, intentAmount)) {
    throw new XochiIntentMismatchError(
      `pull_authorization moves ${pulled} but the intent settles ${intentAmount} -- ` +
        "refusing to sign an authorization for an amount the intent does not account for.",
    );
  }

  // Chain. A pull whose domain names another chain spends another chain's funds. Compared
  // unconditionally: both sides are the server's own bytes and a real quote states both. Do
  // NOT gate this on `!= null`, which makes two ABSENCES skip rather than refuse; an intent
  // that names no chain gives the domain nothing to be held to.
  if (!sameNumeric(domain.chainId, intent.fromChainId)) {
    fail("domain.chainId", domain.chainId, intent.fromChainId);
  }

  if (intent.fromToken !== undefined) {
    if (kind === "erc3009") {
      if (!sameAddressish(String(domain.verifyingContract ?? ""), String(intent.fromToken))) {
        fail(
          "domain.verifyingContract (the token being pulled)",
          domain.verifyingContract,
          intent.fromToken,
        );
      }
    } else if (!sameAddressish(String(m.permitted?.token ?? ""), String(intent.fromToken))) {
      fail("permitted.token", m.permitted?.token, intent.fromToken);
    }
  }

  if (
    kind === "permit2" &&
    !sameAddressish(String(domain.verifyingContract ?? ""), PERMIT2_ADDRESS)
  ) {
    throw new XochiIntentMismatchError(
      `pull_authorization domain.verifyingContract is ${JSON.stringify(domain.verifyingContract)} but ` +
        `Permit2 is ${PERMIT2_ADDRESS} on every EVM chain -- refusing to sign a Permit2-shaped ` +
        "authorization aimed at some other contract.",
    );
  }

  // Validity window. ERC-3009 expires at `validBefore`, Permit2 at `deadline`. Anchor the
  // deadline before measuring from it: this duplicates `assertIntentMatchesRequest` on
  // purpose, since both are exported and the pull check alone would otherwise measure
  // expiry from an unbounded number.
  assertDeadlineWithinWallClockBound(intent.deadline);

  const expiry = kind === "erc3009" ? m.validBefore : m.deadline;
  if (expiry !== undefined && intent.deadline !== undefined) {
    // The tighter of the solver's advertised buffer and the local ceiling.
    const advertised = pick(
      opts as Record<string, unknown>,
      "advertised_pull_deadline_buffer_seconds",
      "advertisedPullDeadlineBufferSeconds",
    );
    const bound = pullExpiryBoundSeconds(advertised);
    try {
      const limit = BigInt(String(intent.deadline)) + BigInt(bound);
      if (BigInt(String(expiry)) > limit) {
        // Name where the bound came from: a short advertised buffer and a
        // genuinely over-long pull are the same refusal with different owners.
        const source =
          bound === MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS
            ? `${bound}s (this SDK's ceiling)`
            : `${bound}s (the solver's advertised pull_deadline_buffer_seconds, tighter than ` +
              `this SDK's ${MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS}s ceiling)`;
        throw new XochiIntentMismatchError(
          `pull_authorization expires at ${expiry}, more than ${source} after the intent deadline ` +
            `${intent.deadline} -- refusing to sign an authorization that outlives the quote.`,
        );
      }
    } catch (e) {
      if (e instanceof XochiIntentMismatchError) throw e;
      throw new XochiIntentMismatchError(
        `pull_authorization expiry ${JSON.stringify(expiry)} or intent deadline ` +
          `${JSON.stringify(intent.deadline)} is not an integer timestamp -- cannot bound the ` +
          "authorization's lifetime. Refusing to sign.",
      );
    }
  }

  return { intent, kind, message: m, domain };
}

/**
 * Asserts the origin-pull authorization moves the intent's funds, on the intent's chain,
 * in the intent's token, to a recipient you pinned, for no longer than the intent lives.
 *
 * Not circular even though both sides come from the server: the intent has already been
 * checked against the request, so it is a trusted anchor. The binding is only as strong
 * as the request was specific, so a caller who supplies no `from_chain_id` gets a pull
 * consistent with a chain id it never pinned.
 *
 * The pull's EIP-712 DOMAIN matters as much as its message, and both domains are fully
 * determined by the intent. ERC-3009: `{chainId: fromChainId, verifyingContract:
 * fromToken}`, the `verifyingContract` being the token contract drained; Riddler builds
 * it as `usdc_address(chain_id)` (`Erc3009.TypedData`), an ERC-3009 origin token being
 * USDC by construction. Permit2: `{chainId: fromChainId, verifyingContract:
 * PERMIT2_ADDRESS}` plus `permitted.token == fromToken`, one constant on every EVM chain
 * (`Permit2.TypedData`). Held to the intent rather than to a chain-config lookup, so this
 * works on any chain the server adds without a `getChainKeyByChainId` round-trip failing
 * closed on an unknown-but-legitimate chain id.
 *
 * WHO RECEIVES THE FUNDS is checked only against `opts.expectedPullRecipients`, a pin the
 * CALLER supplies; with no pin the field goes unchecked ({@link PinnedPullRecipients}).
 * The two methods do not bind equally hard: an ERC-3009 `to` IS the payee, while a
 * Permit2 `spender` is only AUTHORISED to pull and picks `SignatureTransferDetails.to`
 * at call time, off the signed struct (`OriginPullWitness` binds an `orderId`, not a
 * recipient). Pinning a spender bounds who may move the funds, not where they land.
 *
 * An escrow-bearing quote refuses here ({@link assertNoEscrowEnvelope}); verify it with
 * {@link assertEscrowQuoteMatchesRequest}.
 */
export function assertPullMatchesIntent(
  quote: Record<string, any>,
  opts: AssertPullOptions = {},
): void {
  // Before the no-pull return: an escrow quote is refused whatever its pull looks like.
  assertNoEscrowEnvelope(quote);
  const checked = assertPullBodyMatchesIntent(quote, opts);
  if (checked === null) return;
  const { intent, kind, message: m, domain } = checked;

  // A pull TO a caller-pinned escrow is escrow-bearing whether or not the quote carries
  // the `escrow` envelope (SPEC.md §6): the envelope is venue-supplied, and dropping it is
  // how an escrow pull would reach a check that never runs the binding.
  assertPullNotToPinnedEscrow(intent, kind, m, opts);

  // WHO RECEIVES THE FUNDS. Checked only against a CALLER-SUPPLIED pin. Absence is safe
  // to skip here, unlike an advertised value: the pin is the caller's own data, so "this
  // chain is not pinned" is the caller's decision and an attacker cannot delete an entry
  // from it.
  const pinnedRecipient = pinnedFor(
    intent,
    kind,
    pick(opts as Record<string, unknown>, "expected_pull_recipients", "expectedPullRecipients") as
      | PinnedPullRecipients
      | undefined,
    "pull recipients",
    "recipient",
  );
  if (pinnedRecipient) {
    const field = kind === "erc3009" ? "to" : "spender";
    const servedRecipient = kind === "erc3009" ? m.to : m.spender;
    if (servedRecipient === undefined || servedRecipient === null) {
      throw new XochiIntentMismatchError(
        `pull_authorization names no ${field}, but one was pinned for ` +
          `chain ${intent.fromChainId ?? domain.chainId} -- refusing to sign an authorization whose ` +
          "recipient cannot be checked.",
      );
    }
    if (!pinAccepts(pinnedRecipient, String(servedRecipient))) {
      // Worded per method: a Permit2 `spender` picks the destination at call
      // time, off the signed struct, so "leaves to" would overstate the pin.
      const what =
        kind === "erc3009"
          ? "this is the address your origin funds are paid to"
          : "this is the address authorised to pull your origin funds (it chooses the destination itself)";
      throw new XochiIntentMismatchError(
        `pull_authorization ${field} is ${JSON.stringify(servedRecipient)} but ` +
          `${describePin(pinnedRecipient)} was pinned for ${kind} on chain ` +
          `${intent.fromChainId ?? domain.chainId} -- ${what}. Refusing to sign.`,
      );
    }
  }
}

/**
 * The caller's inputs to {@link assertEscrowQuoteMatchesRequest}. Every pin is the
 * caller's own value, never read from the quote or `/xochi/capabilities`.
 */
export interface EscrowQuoteOptions {
  /** REQUIRED: the `RiddlerEscrow` per origin chain ({@link PinnedEscrows}). */
  expectedEscrows: PinnedEscrows;
  /**
   * REQUIRED: the least destination amount (base units) the caller accepts, derived from
   * the caller's own tolerance (for example the signed `toAmount` less the requested
   * slippage), never from the quote's `min_to_amount` alone: the opening's `to_amount` is
   * the release floor, and a floor the venue picked is no floor.
   */
  minOut: UintLike;
  /**
   * Optional pin of the venue's OpenAuth signer addresses. When given (non-empty), the
   * recovered `open_auth` signer must be one of them; absent, any well-formed signature
   * passes and the escrow's `isOpenAuthSigner` is the only check (a bad OpenAuth makes the
   * open revert; it cannot move funds).
   */
  expectedOpenAuthSigners?: readonly string[];
  /** As {@link AssertPullOptions}. */
  advertisedPullDeadlineBufferSeconds?: number | null;
}

/** An escrow order whose binding held: what the caller keeps as dispute evidence. */
export interface VerifiedEscrowOrder {
  /** `keccak256(abi.encode(ORDER_TYPEHASH, terms))`, recomputed locally. */
  orderId: Hex;
  /** The caller-pinned `RiddlerEscrow` the pull targets (== `terms.escrow`). */
  escrow: string;
  /** The origin-side terms the lock is opened under. */
  terms: OrderTerms;
  /** The opening of `terms.destCommitment`; keep it, it is the recovery evidence. */
  opening: DestOpening;
  /** Unix seconds: the fill boundary. Refund opens at `fillDeadline + claimWindow`. */
  fillDeadline: number;
  openAuth: { expiry: number; signature: Hex; signer: string };
}

function envelopeString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new XochiIntentMismatchError(
      `escrow envelope ${where}.${key} is ${JSON.stringify(v)}, not a non-empty string. Refusing to sign.`,
    );
  }
  return v;
}

function envelopeObject(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new XochiIntentMismatchError(
      `escrow envelope ${where} is ${JSON.stringify(v)}, not an object. Refusing to sign.`,
    );
  }
  return v as Record<string, unknown>;
}

function seconds(label: string, v: string): number {
  const n = uintSpelling(v, true);
  if (n === undefined || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new XochiIntentMismatchError(
      `escrow envelope ${label} ${JSON.stringify(v)} is not a timestamp. Refusing to sign.`,
    );
  }
  return Number(n);
}

function escrowPullAuth(
  kind: "erc3009" | "permit2",
  m: Record<string, any>,
  domain: Record<string, any>,
): EscrowPullAuth {
  if (kind === "erc3009") {
    return {
      kind,
      to: String(m.to ?? ""),
      token: String(domain.verifyingContract ?? ""),
      amount: m.value,
      nonce: String(m.nonce ?? ""),
    };
  }
  return {
    kind,
    spender: String(m.spender ?? ""),
    token: String(m.permitted?.token ?? ""),
    amount: m.permitted?.amount,
    witnessOrderId: m.witness?.orderId,
  };
}

/**
 * The escrow path (SPEC.md §2.3, §5.2; ESCROW-RFC.md §7): verifies an escrow-bearing quote
 * against the caller's request and pins, and returns the order it opens. Throws
 * {@link XochiIntentMismatchError} on anything else, and on a quote with no envelope.
 *
 * In order:
 *
 * 1. `assertIntentMatchesRequest(params, quote)`. `wallet`, `to_chain_id`, `to_token` and
 *    the recipient (`recipient_address`, else `wallet`) are REQUIRED here: the binding
 *    compares the order to them, and an absent field would bind to nothing.
 * 2. A Canton destination is SPEC.md §3.3's only shape: a Canton chain id
 *    (`CANTON_MAINNET_CHAIN_ID`), a party recipient and that network's instrument; a party
 *    or instrument on any other chain id, the gateway facade ids 31337 and 30337 included,
 *    refuses ({@link assertCantonDestination}).
 * 3. The pull is held to the intent on chain, token, amount, Permit2 contract and expiry
 *    (as {@link assertPullMatchesIntent}, except who receives it).
 * 4. `assertEscrowBinding`: recipient, token, chain and `minOut` against the request;
 *    `destCommitment` and `orderId` recomputed; `terms.escrow` == pull `to`/`spender` ==
 *    `expectedEscrows[fromChainId]`; depositor == `wallet`; nonce / witness == `orderId`.
 *    An unpinned origin chain or an absent pin refuses.
 * 5. Envelope consistency: `fill_deadline` == `order_terms.fill_deadline`, and the
 *    opening's `intent_id` is the signed intent's `intentId`.
 * 6. `open_auth`: a 65-byte signature over `OpenAuth(orderId, expiry)` on the pinned
 *    escrow's domain, recovering to one of `expectedOpenAuthSigners` when given.
 *
 * The venue's `escrow.address` is never an operand: it is the venue's own word.
 */
export function assertEscrowQuoteMatchesRequest(
  params: QuoteRequestParams,
  quote: Record<string, any>,
  opts: EscrowQuoteOptions,
): VerifiedEscrowOrder {
  const envelope = quote?.escrow;
  if (envelope === undefined || envelope === null) {
    throw new XochiIntentMismatchError(
      "quote carries no escrow envelope; verify it with assertPullMatchesIntent. Refusing to sign.",
    );
  }
  const env = envelopeObject(envelope, "escrow");

  const wallet = params.wallet;
  const toChainId = pick(params, "to_chain_id", "toChainId");
  const toToken = pick(params, "to_token", "toToken");
  const recipient = pick(params, "recipient_address", "recipientAddress") ?? wallet;
  for (const [name, value] of [
    ["wallet", wallet],
    ["to_chain_id", toChainId],
    ["to_token", toToken],
    ["recipient_address (or wallet)", recipient],
  ] as const) {
    if (value === undefined || value === null || value === "") {
      throw new XochiIntentMismatchError(
        `an escrow quote binds to the request's ${name}, and none was given. Refusing to sign.`,
      );
    }
  }

  assertIntentMatchesRequest(params, quote);
  assertCantonDestination(
    { toChainId, recipient, toToken },
    (message) => new XochiIntentMismatchError(`${message}. Refusing to sign.`),
  );

  const checked = assertPullBodyMatchesIntent(quote, {
    advertisedPullDeadlineBufferSeconds: opts.advertisedPullDeadlineBufferSeconds,
  });
  if (checked === null) {
    throw new XochiIntentMismatchError(
      "escrow quote carries no pull_authorization: the lock is opened by the pull it binds. Refusing to sign.",
    );
  }

  const termsWire = envelopeObject(env.order_terms, "order_terms");
  const openingWire = envelopeObject(env.dest_opening, "dest_opening");
  const authWire = envelopeObject(env.open_auth, "open_auth");
  const terms: OrderTerms = {
    depositor: envelopeString(termsWire, "depositor", "order_terms"),
    fromChainId: envelopeString(termsWire, "from_chain_id", "order_terms"),
    fromToken: envelopeString(termsWire, "from_token", "order_terms"),
    fromAmount: envelopeString(termsWire, "from_amount", "order_terms"),
    toChainId: envelopeString(termsWire, "to_chain_id", "order_terms"),
    fillDeadline: envelopeString(termsWire, "fill_deadline", "order_terms"),
    escrow: envelopeString(termsWire, "escrow", "order_terms"),
    destCommitment: envelopeString(termsWire, "dest_commitment", "order_terms"),
  };
  const opening: DestOpening = {
    recipient: envelopeString(openingWire, "recipient", "dest_opening"),
    toToken: envelopeString(openingWire, "to_token", "dest_opening"),
    toAmount: envelopeString(openingWire, "to_amount", "dest_opening"),
    blinding: envelopeString(openingWire, "blinding", "dest_opening"),
    intentId: envelopeString(openingWire, "intent_id", "dest_opening"),
  };
  const quotedOrderId = envelopeString(env, "order_id", "escrow");

  let orderId: Hex;
  try {
    orderId = assertEscrowBinding({
      signer: String(wallet),
      recipient: String(recipient),
      toToken: String(toToken),
      toChainId: toChainId as UintLike,
      minOut: opts.minOut,
      terms,
      opening,
      quotedOrderId,
      pullAuth: escrowPullAuth(checked.kind, checked.message, checked.domain),
      expectedEscrows: opts.expectedEscrows,
    });
  } catch (e) {
    if (e instanceof XochiIntentMismatchError) throw e;
    throw new XochiIntentMismatchError(
      `escrow binding failed: ${e instanceof Error ? e.message : String(e)}. Refusing to sign.`,
      { cause: e },
    );
  }

  // The pin is looked up by `terms.fromChainId`; the pull was held to the intent's chain.
  // Two different chains would name two different escrows' worth of trust.
  if (!sameNumeric(terms.fromChainId, checked.intent.fromChainId)) {
    throw new XochiIntentMismatchError(
      `order_terms.from_chain_id ${JSON.stringify(terms.fromChainId)} is not the intent's fromChainId ` +
        `${JSON.stringify(checked.intent.fromChainId)}. Refusing to sign.`,
    );
  }
  const fillDeadline = seconds("order_terms.fill_deadline", String(terms.fillDeadline));
  if (seconds("fill_deadline", envelopeString(env, "fill_deadline", "escrow")) !== fillDeadline) {
    throw new XochiIntentMismatchError(
      `escrow fill_deadline ${JSON.stringify(env.fill_deadline)} is not order_terms.fill_deadline ` +
        `${JSON.stringify(terms.fillDeadline)}. Refusing to sign.`,
    );
  }
  const intentId = checked.intent.intentId;
  if (typeof intentId !== "string" || opening.intentId !== intentId) {
    throw new XochiIntentMismatchError(
      `dest_opening.intent_id ${JSON.stringify(opening.intentId)} is not the signed intent's ` +
        `intentId ${JSON.stringify(intentId)}. Refusing to sign.`,
    );
  }

  const expiry = seconds("open_auth.expiry", envelopeString(authWire, "expiry", "open_auth"));
  const signature = envelopeString(authWire, "signature", "open_auth");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new XochiIntentMismatchError(
      `open_auth.signature is not 65 bytes (0x + 130 hex). Refusing to sign.`,
    );
  }
  const digest = openAuthDigest(
    { chainId: terms.fromChainId, verifyingContract: terms.escrow },
    orderId,
    expiry,
  );
  let signer: string;
  try {
    signer = ethers.recoverAddress(digest, signature);
  } catch (e) {
    throw new XochiIntentMismatchError(
      `open_auth.signature does not recover: ${e instanceof Error ? e.message : String(e)}. Refusing to sign.`,
      { cause: e },
    );
  }
  const pinnedSigners = opts.expectedOpenAuthSigners;
  if (pinnedSigners !== undefined) {
    if (!Array.isArray(pinnedSigners) || pinnedSigners.length === 0) {
      throw new XochiIntentMismatchError(
        "expectedOpenAuthSigners is empty or not a list; omit it or pin at least one signer. Refusing to sign.",
      );
    }
    if (!pinnedSigners.some((s) => typeof s === "string" && sameAddressish(s.trim(), signer))) {
      throw new XochiIntentMismatchError(
        `open_auth is signed by ${signer}, not one of the pinned OpenAuth signers ` +
          `(${pinnedSigners.join(", ")}). Refusing to sign.`,
      );
    }
  }

  return {
    orderId,
    escrow: terms.escrow,
    terms,
    opening,
    fillDeadline,
    openAuth: { expiry, signature: signature.toLowerCase() as Hex, signer },
  };
}
