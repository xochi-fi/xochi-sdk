/**
 * Zod Schemas
 *
 * The Worker's quote and execute RESPONSE wire contract (`/api/intent/quote`,
 * `/api/intent/execute`), with the primitives it closes over. Types are derived
 * from schemas via z.infer -- single source of truth.
 */

import { z } from "zod";
import { ETH_ADDRESS_REGEX } from "./validators.js";
import { NOT_EXECUTED_SUBSTATUS } from "./intents.js";

// ============================================================
// Primitives
// ============================================================

/** Ethereum address: 0x-prefixed, 42 hex chars. Single source: validators.ts. */
export const ethAddress = z.string().regex(ETH_ADDRESS_REGEX);

/**
 * Tron base58check address: leading `T`, 34 chars, base58 alphabet (no
 * 0/O/I/l). Structural check mirroring `TRON_ADDRESS_REGEX` in validators.ts;
 * kept inline here so the schema module stays free of the viem import chain.
 */
export const tronAddress = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "Must be a Tron base58 address");

/**
 * Recipient address for a non-EVM destination: the user's own address on the
 * destination chain (EVM routes settle to the signing wallet, so it is
 * optional). EVM hex20 or Tron base58.
 */
export const recipientAddress = z.union([ethAddress, tronAddress]);

/** Settlement type */
export const settlementType = z
  .enum(["public", "shielded", "stealth"])
  .describe(
    "Where the payout lands. `public` settles to the wallet address. `stealth` settles to a one-time address on Ethereum L1 (ERC-5564). `shielded` (Aztec L2 notes) is planned and not yet live: it is gated by SHIELDED_SETTLEMENT_LIVE, served as unavailable in `settlement_options`, and refused as a `settlement_preference` while that is off. Read `settlement_options` for live availability rather than assuming this enum's members are all fillable.",
  );

/**
 * Pull+gas payment method the quote's eip712 authorizes.
 *
 * `deposit` is the odd one out and is not a pull at all: on a non-EVM origin
 * (Tron) the user sends the tokens themselves to a served `deposit_address`,
 * at their own network cost, with no wallet signature anywhere in the flow.
 * It is in this enum because it is what belongs in this FIELD, which answers
 * "how does the origin leg get funded".
 *
 * Without it the wire lies: a Tron-origin quote reports `payment_method:
 * "permit2"` next to `gasless: false` and a `deposit_address`, describing a
 * Permit2 pull on a chain that has no Permit2. The browser papers over it
 * (`resolvePaymentMethod` overrides to `deposit` whenever a deposit address is
 * present), so a human never sees the wrong label; every non-browser consumer
 * does: the MCP server, the OpenAPI contract, and any agent branching on this
 * field to decide whether to prepare a signature.
 */
export const paymentMethod = z.enum([
  "erc3009",
  "permit2",
  "pimlico",
  "x402",
  "mpp",
  "approval",
  "deposit",
]);

// ============================================================
// Referral and promo outcomes (quote response siblings of fee_breakdown)
// ============================================================

/**
 * A referral code as stored (xochi#583): 3-32 of `A-Z 0-9 _ -`, starting with a
 * letter or digit. Stored and compared uppercase, so a link's `?ref=summer` and
 * `SUMMER` are the same code. Migration 0019 enforces the same shape.
 */
export const REFERRAL_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/**
 * The note served when a `ref` was sent and is not applied. ONE text for every
 * reason (unknown, expired, revoked, scoped to another key, a key that does not
 * accept referrals, self-referral): a per-reason note would let a caller
 * enumerate which codes exist.
 */
export const REFERRAL_NOT_APPLIED_NOTE = "Referral code not applied.";

/**
 * The neutral referral line (xochi#603): served on a quote whose `ref` was
 * applied when the request is not signed in as the quoting wallet. One fixed
 * text, identical whether or not the wallet has a referral binding.
 */
export const REFERRAL_NEUTRAL_NOTE = "A referrer may earn part of the routing fee on this trade.";

export const QuoteReferralSchema = z
  .union([
    z
      .object({
        code: z
          .string()
          .regex(REFERRAL_CODE_REGEX)
          .describe("The code this trade credits, normalized uppercase."),
        name: z
          .string()
          .describe("Affiliate display name, rendered as `Referral: {name}` on the routing line."),
      })
      .strict()
      .describe(
        "Served only when the request carries a wallet-bound session (SIWE JWT or Mandate) for the quoting wallet: the code the trade will credit if executed now. The wallet's open referral binding wins over `ref`; otherwise it is the applied `ref`.",
      ),
    z
      .object({
        neutral: z.literal(true),
        note: z.literal(REFERRAL_NEUTRAL_NOTE),
      })
      .strict()
      .describe(
        "Served when `ref` was applied but the request is not signed in as the quoting wallet: a referrer may be credited, and who is not said. Identical whether or not the wallet has a referral binding.",
      ),
  ])
  .describe(
    "Who earns the routing fee layer (`fee_breakdown.routing_fee`) in place of the publishable key's routing recipient. Attribution only: no amount, rate or total differs from the same quote without `ref`.",
  );

/**
 * A promo code as stored (xochi#584): 3-32 of `A-Z 0-9 _ -`, starting with a
 * letter or digit. Stored and compared uppercase, so `launch10` and `LAUNCH10`
 * are the same code. Migration 0020 enforces the same shape.
 */
export const PROMO_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/**
 * The inline error served when a `promo` was sent and cannot be used. ONE text
 * for every reason (unknown, malformed, expired, revoked, used up, used up by
 * this wallet, not accepted under this publishable key, lookup ceiling, the
 * feature off): a per-reason message would let a caller enumerate which codes
 * exist.
 */
export const PROMO_NOT_APPLIED_NOTE = "This code can't be applied.";

/**
 * The note served when a valid code was sent but the caller's trust tier
 * already discounts at least as much (discount = max(tier, capped promo), never
 * both; an Institutional wallet always lands here). The code is
 * not consumed.
 */
export const PROMO_TIER_BETTER_NOTE =
  "Your trust tier already gives you a fee at least as low as this code.";

export const QuotePromoSchema = z
  .object({
    code: z.string().regex(PROMO_CODE_REGEX).describe("The applied code, normalized uppercase."),
    discount_bps: z
      .number()
      .int()
      .positive()
      .describe(
        "Discount this code bought, in bps off the Standard venue + routing layers for the route's asset class. Already reflected in every amount of this quote and itemized as `fee_breakdown.discount`.",
      ),
  })
  .strict()
  .describe(
    "Present when the `promo` sent on the quote was applied: it beat the caller's trust-tier discount and priced this quote. One use of the code is counted when this quote is executed, not now; if the code is used up or withdrawn by then, execute refuses with `promo_unavailable` and the caller re-quotes.",
  );

// ============================================================
// Response Schemas (worker -> client/agent wire contract)
// ============================================================

/**
 * EIP-712 typed data the user signs. Internal keys follow the EIP-712
 * standard (camelCase: domain.chainId, domain.verifyingContract, primaryType)
 * and are part of the signed payload -- they are intentionally NOT snake_cased.
 * Passed through verbatim from the solver. Mirrors the `Eip712TypedData`
 * schema in public/openapi.yaml.
 */
export const Eip712TypedDataSchema = z.object({
  // Two domain shapes coexist: legacy Xochi-owned structs and token-pull
  // domains carry `verifyingContract`; the Riddler XochiIntent v3 domain carries
  // `salt` (keccak256(version)) and NO verifyingContract. Both fields are
  // optional so either shape validates and both survive the parse verbatim -- a
  // stripped `salt` or an injected `verifyingContract` would change the domain
  // separator and strand the signature.
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: z.number().int(),
    verifyingContract: ethAddress.optional(),
    salt: z.string().optional(),
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const SettlementOptionSchema = z.object({
  type: settlementType,
  available: z.boolean(),
  reason: z.string().optional(),
});

export const ClaimInfoSchema = z.object({
  factory_address: ethAddress,
  salt: z.number().int(),
});

/**
 * A fee layer AMOUNT in token base units: digits only, no sign, no decimal
 * point, no exponent, no `0x`.
 *
 * A plain `z.string()` would admit `""`, `"0.5"`, `"1.2e3"` and `"-5"`. Every
 * consumer immediately does `BigInt()` on these to reconcile the layers against
 * `total_fee`, and `BigInt` throws on three of those four and silently returns
 * `0n` on the empty string -- so the loose type turns an upstream formatting
 * change into a 500 on every quote for the route (nothing wraps the
 * reconciliation in a try/catch). The producer (Riddler `fee_policy.ex`,
 * `calculate_layered_fee`) emits `Integer.to_string` of a non-negative integer
 * for all five, so this narrowing describes what is actually served rather
 * than restricting it.
 *
 * Deliberately NOT applied to `gas_floor.usd` or `total_usd`: those are dollar
 * figures and are legitimately decimal ("0.022663").
 */
const feeLayerBaseUnits = z
  .string()
  .regex(/^\d+$/)
  .describe(
    "Fee layer amount in token base units (integer, no decimal point). " +
      "Denominated in the token named by the response's `fee_denomination`.",
  );

/**
 * Itemized fee breakdown (economics.md Part 1). snake_case wire shape the worker
 * emits and the frontend renders against. Layers are three additive bps lines on
 * a never-discounted cost floor (solver + gas), plus venue and routing.
 *
 * The layer AMOUNTS carry no denomination of their own. The token they are
 * measured in is named by `fee_denomination` on the enclosing quote response.
 */
export const FeeBreakdownSchema = z.object({
  // The SOLVER's view of the caller's tier, under which IT computed the layer
  // amounts below. NOT the authority on the caller's tier: Xochi resolves that
  // from D1 (`user_tiers`) and the client-supplied `trust_score` is never
  // trusted. The two can legitimately disagree for a quote or two after an
  // upgrade, because the solver's copy of the score lags D1's. Render the
  // caller's tier from the Xochi-side value; read this one only as the label
  // that explains these particular numbers.
  tier: z
    .enum(["standard", "trusted", "verified", "premium", "institutional"])
    .describe(
      "The SOLVER's view of the tier, and the schedule it priced these layer " +
        "amounts under. Not the authority on the caller's tier -- Xochi resolves " +
        "that from its own records, and the solver's copy of the trust score can " +
        "lag a fresh upgrade by a quote or two. Use it to explain these numbers, " +
        "never to display the user's tier.",
    ),
  asset_class: z.enum(["stable", "volatile"]),
  gas_floor: z.object({ amount: z.string(), usd: z.string() }),
  solver_fee_bps: z.number(),
  solver_fee: feeLayerBaseUnits,
  price_impact_bps: z.number(),
  price_impact: feeLayerBaseUnits,
  venue_fee_bps: z.number(),
  venue_fee: feeLayerBaseUnits,
  routing_fee_bps: z.number(),
  routing_fee: feeLayerBaseUnits,
  total_bps: z.number(),
  total_fee: feeLayerBaseUnits,
  total_usd: z.string(),
  surplus_share_pct: z.number(),
  // Present when a promo code was in play on the quote (xochi#584): which
  // discount priced it and how much it took off the Standard venue + routing
  // layers. Emitted by the solver, which priced it; the worker reads `source`
  // to decide whether the code was applied rather than assuming it was.
  discount: z
    .object({
      source: z
        .enum(["tier", "promo"])
        .describe(
          "Which discount priced this quote: the trust tier's or the promo code's. They never stack: discount = max(tier, min(promo, Institutional discount)).",
        ),
      bps: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Basis points taken off the Standard venue + routing layers for this asset class. Never off the solver spread or the gas floor.",
        ),
      amount: feeLayerBaseUnits,
    })
    .strict()
    .optional()
    .describe(
      "The applied discount as a labelled line INSIDE `total_fee`: `venue_fee` and `routing_fee` are already net of it, so it is never subtracted again. Render it as e.g. `Promo LAUNCH10 -0.05%`. Absent when no promo code was sent.",
    ),
});

/**
 * Which token the `fee_breakdown` layer amounts are measured in. See the
 * `fee_denomination` field on {@link QuoteResponseSchema}.
 */
export const FeeDenominationSchema = z.enum(["origin", "destination"]);

/** Which token a served `fee_breakdown`'s layer amounts are denominated in. */
export type FeeDenomination = z.infer<typeof FeeDenominationSchema>;

/**
 * The WIRE shape of a fee breakdown (snake_case), distinct from the camelCase
 * `FeeBreakdown` domain type in `types.ts`. Named apart on purpose: the two
 * describe the same fifteen values in two different casings, and a worker that
 * forwards the wire form must not be handed the domain type by mistake.
 * `mapQuoteResponse` is the one place that converts between them.
 */
export type FeeBreakdownWire = z.infer<typeof FeeBreakdownSchema>;

/**
 * Canonical quote response: the Xochi worker's `/api/intent/quote` output and
 * the pinned agent contract. snake_case envelope; the `eip712` value is
 * verbatim EIP-712 typed data. When `can_solve` is true, `to_amount`,
 * `payment_method`, and `eip712` are present. Mirrors `QuoteResponse` in
 * public/openapi.yaml -- keep all three in lockstep.
 */
export const QuoteResponseSchema = z
  .object({
    success: z.boolean(),
    intent_id: z.string(),
    quote_id: z.string(),
    can_solve: z.boolean(),
    /** Non-executable price exploration: never persisted and carries no signing material. */
    preview: z.boolean().optional(),
    to_amount: z.string().optional(),
    min_to_amount: z.string().optional(),
    xochi_fee: z.string().optional(),
    xochi_fee_rate: z.string().optional(),
    cost_bps: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "All-in cost of this quote in basis points, from the same fixed-cost " +
          "guard that refuses an uneconomical order, so the displayed price and " +
          "the refusal threshold cannot disagree. Unlike xochi_fee_rate (a flat " +
          "schedule rate) this moves with route and size: cost is " +
          "max(gas floor of the destination chain, the fee rate), so it rises " +
          "as the order shrinks. BOUNDED BY THE GUARD: an order whose cost " +
          "exceeds the ceiling is declined with error_category " +
          "'amount_too_small' and carries no cost_bps at all, so every served " +
          "value sits at or below the ceiling (150 bps at MAX_COST_RATIO 0.015). " +
          "Do not model a range above it. Omitted when the origin token has no " +
          "dollar value on the worker and the guard could not run -- absent " +
          "means unknown, never zero. Unrounded: below half a basis point the " +
          "distinction between a free fill and a merely cheap one still matters, " +
          "and rounding server-side destroys it.",
      ),
    // Itemized layer split; optional until the worker/Riddler emit it.
    fee_breakdown: FeeBreakdownSchema.optional(),
    // Which token `fee_breakdown`'s amounts are measured in. Carried on the wire
    // rather than inferred from the MERE PRESENCE of fee_breakdown, which would
    // rest on an undocumented convention in another repo (Riddler's
    // fee_policy.ex computes every layer off `input_amount`): the xochi#410
    // failure class, a cross-repo fact with no runtime evidence in this one.
    fee_denomination: FeeDenominationSchema.optional().describe(
      "Which token the `fee_breakdown` layer AMOUNTS are denominated in. " +
        "'origin' means `from_token` base units, 'destination' means `to_token` " +
        "base units. Formatting a fee with the wrong token's decimals and symbol " +
        "misstates it by the exchange rate, and on a USDC->USDC route (6 decimals " +
        "both sides) the mistake is invisible -- which is why this is stated on " +
        "the wire instead of inferred from the presence of `fee_breakdown`. " +
        "PROVENANCE: the solver does not emit this field yet, so today Xochi " +
        "asserts it from the solver's documented convention (every layer computed " +
        "off the input amount, hence 'origin') rather than reporting a value the " +
        "solver stated. It is forwarded verbatim once the solver does send one. " +
        "Treat it as Xochi's best statement of the denomination, not as the fee " +
        "computer's own declaration. ABSENT MEANS UNKNOWN, never a default: when " +
        "there is no `fee_breakdown` the field is omitted entirely.",
    ),
    // Referral attribution for the routing layer (xochi#583). Xochi-owned and
    // a sibling of `fee_breakdown` rather than inside it: the breakdown is the
    // solver's itemization and may be absent, while the routing line exists on
    // every quote (the client derives one without a breakdown).
    referral: QuoteReferralSchema.optional(),
    referral_note: z
      .literal(REFERRAL_NOT_APPLIED_NOTE)
      .optional()
      .describe(
        "Present when a `ref` was sent and not applied. Deliberately one fixed text for every reason (unknown, expired, revoked, not valid for this key, a key that does not accept referrals, self-referral), so the response does not reveal whether a code exists. The quote is otherwise identical to one sent without `ref`.",
      ),
    // Promo code outcome (xochi#584). Xochi-owned siblings of `fee_breakdown`:
    // the breakdown itemizes the discount (`fee_breakdown.discount`), these say
    // whether the code the caller sent is the thing that priced it.
    promo: QuotePromoSchema.optional(),
    promo_note: z
      .enum([PROMO_NOT_APPLIED_NOTE, PROMO_TIER_BETTER_NOTE])
      .optional()
      .describe(
        "Inline message for a `promo` that did not price this quote. The quote is still served, priced as if no code had been sent. `" +
          PROMO_NOT_APPLIED_NOTE +
          "` is deliberately one fixed text for every reason (unknown, expired, revoked, used up, this wallet's limit reached, not accepted under this publishable key), so the response does not reveal whether a code exists. `" +
          PROMO_TIER_BETTER_NOTE +
          "` means the code is valid but the trust-tier discount is at least as large; it is not consumed.",
      ),
    estimated_gas_cost: z.string().optional(),
    stream_topic: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,64}$/)
      .optional()
      .describe(
        "Subscribe capability for this intent's live status and fill-race " +
          "stream, at `GET /api/stream/<stream_topic>` (WebSocket upgrade). " +
          "TREAT IT AS A BEARER TOKEN: possession is the whole authorization, " +
          "there is no second check, and the relay replays its recent event " +
          "buffer to every new subscriber. It is served exactly once, in this " +
          "response, and is never returned by a read endpoint. Keep it out of " +
          "logs and out of URLs you share. It is deliberately NOT the " +
          "`intent_id` beside it: that value is public by construction (it " +
          "appears in status paths and in server logs), so a stream keyed on it " +
          "would be readable by anyone who has ever seen one. Absent on an " +
          "intent quoted before this field existed, which means no stream is " +
          "available; fall back to polling `GET /api/intent/:id/status`, which " +
          "is the durable path in every case.",
      ),
    expiry: z.string(),
    gasless: z.boolean().optional(),
    gasless_fee: z.string().optional(),
    payment_method: paymentMethod.optional(),
    route: z.record(z.string(), z.unknown()).optional(),
    eip712: Eip712TypedDataSchema.optional(),
    // Origin-pull authorization: a second EIP-712 the user signs so the solver
    // can collect origin funds before settling. ReceiveWithAuthorization (USDC
    // domain) for erc3009, PermitWitnessTransferFrom for permit2. Absent for
    // non-pulling methods and the mock path.
    pull_authorization: Eip712TypedDataSchema.optional(),
    // Non-EVM origin (Tron): the per-intent address the user manually sends TRC-20
    // to. Mutually exclusive with pull_authorization (a deposit route has no
    // typed-data pull). Base58check -- never lowercased.
    deposit_address: z.string().optional(),
    // Solver attestation binding the deposit_address to this intent. The client
    // verifies the signature against a pinned signer BEFORE displaying the address
    // (fail-closed); an absent/invalid attestation makes the route unavailable.
    deposit_attestation: z.string().optional(),
    // Deposit-acceptance deadline (unix seconds) for a deposit route -- decoupled
    // from the shorter quote `expiry` so a manual TRC-20 transfer has time to land.
    // Drives the deposit countdown.
    deposit_deadline: z.number().int().optional(),
    // Echo of the requested destination recipient (non-EVM/Tron routes). These
    // routes carry no wallet signature, so recipient integrity rides on this
    // authenticated channel: the client asserts the solvable quote echoes exactly
    // the address it asked for and fail-closes otherwise (#113). Base58 is
    // case-sensitive -- passed through verbatim, never lowercased.
    recipient_address: recipientAddress.optional(),
    settlement_options: z.array(SettlementOptionSchema).optional(),
    claim_info: ClaimInfoSchema.optional(),
    // Execute replay-dedup nonce the GET alias injects (absent from the POST
    // envelope) so a third-party ACP agent need not do the pull-nonce bit math
    // itself. Derived from the pull-authorization nonce (see deriveReplayNonce).
    // Optional: the POST omits it, and the GET omits it too on a pull-less route.
    nonce: z.number().int().min(0).optional(),
    error: z.string().optional(),
    // Present on the unsolvable-200 branch: `error_category` is a stable machine
    // key for the reject class, `detail` the solver's raw reason. Absent on
    // solvable quotes.
    //
    // Enumerated so the generated spec documents the vocabulary agents branch on,
    // and so adding a category without declaring it fails the contract tests.
    // Four are worker-side fail-closed guards; the rest come from
    // `classifyDecline` (decline.ts), whose returns are a closed set of literals
    // with `unknown` as the catch-all.
    // Documented, deliberately NOT enumerated. The worker owns four of these,
    // but the rest come from `classifyDecline` (decline.ts) over solver reasons,
    // and the contract test below asserts an unlisted value still parses -- this
    // side of the vocabulary is intentionally open, so a new upstream reason must
    // not start failing every client that validates.
    error_category: z
      .string()
      .optional()
      .describe(
        "Stable machine key for a declined quote. Branch on this rather than on `error`, whose prose may change. Known values: gas_floor_unpriced (transient, retry), origin_pull_amount_mismatch, served_payout_mismatch, settlement_type_unavailable, stealth_factory_untrusted, refund_address_invalid, amount_too_large, amount_too_small, no_liquidity, route_unsupported, invalid_request (the request shape was rejected, not the route -- see `detail` for the offending field), auth, unknown. Treat an unrecognized value as a non-retryable decline.",
      ),
    detail: z.string().optional(),
    // Present when `error_category` is `amount_too_small` because the route's
    // FIXED settlement cost consumed too much of the order: the smallest order
    // (USD) that clears the threshold at the current cost. Lets a caller retry
    // with a workable amount instead of bisecting for one. Not a protocol
    // constant -- it moves with the corridor's cost, so read it per quote.
    minimum_amount_usd: z
      .number()
      .positive()
      .optional()
      .describe(
        "Smallest order in USD you should send on this route. THIS is the number to retry with; it already accounts for both the solver's floor and the fixed-cost threshold, so it is >= `min_fillable_usd`. Present on an `amount_too_small` decline. Varies with the corridor's current cost, so do not cache it.",
      ),
    // The solver's own live bounds, passed through on a bounds decline. Both
    // are served, so an undeclared one makes the strict schema reject a
    // legitimate decline and leaves it out of the generated spec (#754).
    min_fillable_usd: z
      .number()
      .positive()
      .optional()
      .describe(
        "The solver's live per-corridor floor: the smallest order it will fill at all, which is its own cost to fill. Reported for transparency. Do NOT retry with this figure -- an order at exactly the solver's cost delivers almost nothing. Use `minimum_amount_usd`.",
      ),
    max_order_usd: z
      .number()
      .positive()
      .optional()
      .describe(
        "The solver's live per-trade ceiling in USD. Present on an `amount_too_large` decline.",
      ),
  })
  .strict();

/**
 * Length of an intent read capability (`read_token` on the execute response,
 * xochi#563): 32 random bytes as unpadded base64url.
 */
export const READ_TOKEN_LENGTH = 43;

/** Shape of an intent read capability: exactly `READ_TOKEN_LENGTH` base64url characters. */
export const READ_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${READ_TOKEN_LENGTH}}$`);

/**
 * The request header that carries a `read_token` on `GET /api/intent/:id` and
 * `GET /api/intent/:id/status`. A header and never a query parameter: the token
 * must not land in URLs, logs or referrers.
 */
export const READ_TOKEN_HEADER = "X-Xochi-Read-Token";

/** Mirrors `ExecuteResponse` in public/openapi.yaml. */
export const ExecuteResponseSchema = z
  .object({
    success: z.boolean(),
    intent_id: z.string(),
    status: z.string(),
    tx_hash: z.string().optional(),
    // Per-leg hashes for cross-chain: the origin/deposit leg is `tx_hash`, the
    // destination fill is `receiving_tx_hash` (arrives later via status/WS).
    bridge_tx_hash: z.string().optional(),
    receiving_tx_hash: z.string().optional(),
    // Public destination fill receipt (Riddler #632) + its chain, when a same-chain
    // or fast fill resolves inline; usually arrives later via the status poll.
    settlement_tx_hash: z.string().optional(),
    settlement_chain_id: z.number().int().optional(),
    // In-doubt: the solver may have moved funds but did not confirm. The intent
    // stays non-terminal; surface this so the client shows "still confirming"
    // rather than a success or a failure.
    reconciling: z.boolean().optional(),
    note_commitment: z.string().optional(),
    stealth_address: z.string().optional(),
    ephemeral_pub_key: z.string().optional(),
    view_tag: z.number().int().optional(),
    error: z.string().optional(),
    substatus: z
      .literal(NOT_EXECUTED_SUBSTATUS)
      .optional()
      .describe(
        "`not_executed` on a 502 `failed` the worker wrote knowing nothing moved (the resend budget's finish, or no solver configured): safe to re-quote. Absent on a solver-reported failure.",
      ),
    // Per-intent read capability (xochi#563): 32 random bytes, base64url, no
    // padding. Served once, by the execute that admits the intent; present it as
    // `X-Xochi-Read-Token` on `GET /api/intent/:id[/status]` to read the on-chain
    // legs of a non-public intent. Older servers omit it. The one declared field
    // that never fails the body: a malformed token is dropped, because this body
    // reports an execute that may already have moved funds, and failing it would
    // turn a settled swap into an in-doubt one over a privacy-only field.
    read_token: z
      .string()
      .regex(READ_TOKEN_PATTERN)
      .optional()
      .catch(undefined)
      .describe(
        "Per-intent read capability, served once. Send it as the `X-Xochi-Read-Token` " +
          "header on `GET /api/intent/:id` and `GET /api/intent/:id/status` to see the " +
          "on-chain legs of a stealth or shielded intent. Never put it in a URL.",
      ),
  })
  .strict();

/**
 * Automatic resends of one execute after its not-accepted answer. Mirrors
 * `MAX_EXECUTE_RESENDS` in xochi's `@xochi/shared` `schemas.ts`, the budget
 * the Worker enforces too: the refusal that follows this many un-claims
 * finishes the intent `failed` instead.
 */
export const MAX_EXECUTE_RESENDS = 3;

/**
 * A resend must reach the Worker at least this many seconds before the
 * earliest deadline the signed request carries. Mirrors
 * `EXECUTE_RESEND_MARGIN_SECS` in xochi's `@xochi/shared` `schemas.ts`, the
 * margin the Worker applies before it un-claims.
 */
export const EXECUTE_RESEND_MARGIN_SECS = 5;

// Response wire types (snake_case). The canonical agent contract.
export type Eip712TypedDataWire = z.infer<typeof Eip712TypedDataSchema>;
export type SettlementOptionWire = z.infer<typeof SettlementOptionSchema>;
export type ClaimInfoWire = z.infer<typeof ClaimInfoSchema>;
export type QuoteResponseWire = z.infer<typeof QuoteResponseSchema>;
export type ExecuteResponseWire = z.infer<typeof ExecuteResponseSchema>;
