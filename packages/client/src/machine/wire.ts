/**
 * Wire shapes and decoders.
 *
 * The worker speaks the canonical snake_case contract (`QuoteResponseSchema` in
 * `@xochi/shared`, `public/openapi.yaml`); everything past this module is
 * camelCase. Decoding happens HERE, once, so the trade widget and `@xochi/sdk`
 * read a quote, an execute result and an intent status through the same code
 * rather than through two mappers that drift.
 */

import type {
  ChainId,
  SelectableChainId,
  SettlementType,
  DestinationType,
  FeeBreakdown,
  FeeDenomination,
  Eip712TypedData,
  SettlementOption,
  QuoteResponseWire,
  ExecuteResponseWire,
  IntentStatus,
} from "../shared/index.js";
import {
  ExecuteResponseSchema,
  QuoteResponseSchema,
  isSettlementType,
  isIntentStatus,
} from "../shared/index.js";

// ============================================================
// Frontend-specific Types
// ============================================================

/** Full destination specification */
export interface IntentDestination {
  type: DestinationType;
  chainId?: ChainId;
  shielded: boolean;
  /**
   * Recipient address on the destination chain, for a non-EVM settlement (Tron).
   * The user types it; EVM routes settle to the connected wallet and omit it.
   */
  recipientAddress?: string;
}

// ============================================================
// Quote Request/Response Types
// ============================================================

export interface QuoteRequest {
  wallet?: string;
  /** Ask for pricing only. Preview quotes cannot be signed or executed. */
  preview?: boolean;
  /** Idempotency key for one explicit Tron deposit-route allocation. */
  allocationKey?: string;
  // Origin can be non-EVM (Tron deposit route); destination too.
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  deadline: number;
  slippageBps: number;
  trustScore?: number;
  settlementPreference: SettlementType;
  /** Recipient on the destination chain (non-EVM routes); omit for EVM. */
  recipientAddress?: string;
  /**
   * Refund destination on the ORIGIN chain, for a deposit-route origin (Tron).
   * Omit for EVM origins, where a refund goes back to the connected wallet.
   * See xochi#358: without it a refund pays the on-chain deposit sender, which
   * strands funds when the deposit came from an exchange.
   */
  refundAddress?: string;
  destination?: IntentDestination;
  /** Stealth meta-address for stealth settlements */
  stealthMetaAddress?: {
    spendingPubKey: string;
    viewingPubKey: string;
    chainId: ChainId;
  };
}

/** Stealth settlement claim info (factory + salt for counterfactual SimpleAccount) */
export interface ClaimInfo {
  factoryAddress: string;
  salt: number;
}

export interface QuoteResponse {
  success: boolean;
  intentId: string;
  quoteId: string;
  canSolve: boolean;
  /** True when this is a non-persisted, non-executable public price preview. */
  preview?: boolean;
  toAmount: string;
  minToAmount: string;
  xochiFee: string;
  xochiFeeRate: string;
  /**
   * All-in cost of this quote in basis points, measured server-side by the same
   * fixed-cost guard that refuses an uneconomical order. Distinct from
   * `xochiFeeRate`, which is the flat schedule rate: this one moves with route
   * and size. Absent when the guard could not run -- render nothing, not zero.
   */
  costBps?: number;
  /** Itemized layer split; absent until the worker/Riddler emit it. */
  feeBreakdown?: FeeBreakdown;
  /**
   * Which token `feeBreakdown`'s layer AMOUNTS are measured in: `"origin"` =
   * from-token base units, `"destination"` = to-token base units.
   *
   * On the wire so the renderer reads the denomination instead of inferring it
   * from which branch produced the breakdown. Formatting a fee with the wrong
   * token's decimals misstates it by the exchange rate (by 10^12 on an
   * 18-decimal origin), and every live route today is 6 decimals on both sides,
   * so the mistake is invisible until it is not.
   *
   * Absent means UNKNOWN, never a default. The worker emits it whenever it
   * forwards a served breakdown and omits it when there is no breakdown.
   */
  feeDenomination?: FeeDenomination;
  estimatedGasCost: string;
  /**
   * Subscribe capability for this intent's live status + race stream, served
   * once with the quote. TREAT AS A BEARER TOKEN: possession is the entire
   * authorization and the relay replays its recent buffer to each new
   * subscriber. Never log it and never put it in a shared URL.
   *
   * Absent means no stream (an intent quoted before the field existed), which
   * the client must read as "poll only" rather than substituting the intentId.
   * That substitution is the bug this field exists to prevent: the id is public
   * by construction.
   */
  streamTopic?: string;
  expiry: string;
  gasless: boolean;
  gaslessFee?: string;
  paymentMethod?: PaymentMethod;
  eip712Data?: Eip712TypedData;
  /**
   * Origin-pull authorization served by the solver. The user signs this in
   * addition to eip712Data; the signature is sent as pullSignature on execute.
   * Present when the route requires origin collection (erc3009 / permit2).
   */
  pullAuthorization?: Eip712TypedData;
  /**
   * Non-EVM origin (Tron): the per-intent address the user manually sends
   * TRC-20 to. Mutually exclusive with pullAuthorization. Only ever surfaced to
   * the UI after depositAttestation verifies against the pinned signer.
   */
  depositAddress?: string;
  /** Solver attestation over the deposit binding; verified fail-closed. */
  depositAttestation?: string;
  /** Deposit-acceptance deadline (unix seconds) for a deposit route. */
  depositDeadline?: number;
  /**
   * The RESOLVED settlement type the quote is served under, read from
   * `route.settlement_type`. Distinct from the value REQUESTED: the solver may
   * serve a different one, and the v2 deposit attestation signs the resolved
   * value. Undefined when the solver did not state it, which a deposit route
   * must treat as a refusal rather than assuming "public" -- guessing here would
   * silently diverge from the signed message on every quote.
   */
  settlementType?: SettlementType;
  /**
   * The served `escrow` envelope, verbatim, when the quote carried the key.
   * Not modelled: it is held only so the `@xochi/signer` checks the machine
   * runs at ingest can see it. This client does not run the escrow binding, so
   * a quote whose `escrow` is anything but absent or `null` is refused before
   * it can reach the wallet.
   */
  escrow?: unknown;
  /**
   * Echo of the requested destination recipient (non-EVM/Tron routes). The
   * client asserts a solvable quote echoes exactly the address it asked for
   * (fail-closed on mismatch); absent for EVM routes. See #113.
   */
  recipientAddress?: string;
  settlementOptions: SettlementOption[];
  claimInfo?: ClaimInfo;
  error?: string;
  /**
   * Stable machine key for a declined quote (served beside `error`). Branch on
   * this, never on the prose: the wire contract documents the vocabulary and
   * says an unrecognized value is a non-retryable decline.
   */
  errorCategory?: string;
  /**
   * Smallest order (USD) that clears this route right now; served on an
   * `amount_too_small` decline. THE number to retry with (it already covers
   * the solver floor and the fixed-cost threshold). Moves with corridor cost,
   * so never cache it.
   */
  minimumAmountUsd?: number;
  /**
   * The solver's own live floor (USD), for transparency copy only. An order at
   * exactly this figure delivers almost nothing; never offer it as the retry.
   */
  minFillableUsd?: number;
  destination?: IntentDestination;
}

// ============================================================
// Execute Request/Response Types
// ============================================================

export interface ExecuteRequest {
  intentId: string;
  quoteId: string;
  signature: string;
  nonce: number;
  pullSignature?: string;
  aztecProof?: string;
}

export interface ExecuteResponse {
  success: boolean;
  intentId: string;
  status: IntentStatus;
  txHash?: string;
  /** Destination fill hash (cross-chain); usually arrives later via status/WS. */
  receivingTxHash?: string;
  /** Public fill receipt (Riddler #632) + its chain, when a fill resolves inline. */
  settlementTxHash?: string;
  settlementChainId?: ChainId;
  bridgeTxHash?: string;
  /** In-doubt: funds may be in flight but unconfirmed. */
  reconciling?: boolean;
  error?: string;
  /** Note commitment for shielded settlements */
  noteCommitment?: string;
  /** Stealth settlement info */
  stealthAddress?: string;
  ephemeralPubKey?: string;
  viewTag?: number;
  /**
   * Per-intent read capability (xochi#563), served once and only by a server
   * that issues it. Keep it with the intent and pass it as `readToken` to
   * `getIntent` / `getIntentStatus`: without it a stealth or shielded intent's
   * status reads without its on-chain legs. A bearer secret: never log it or
   * put it in a URL.
   */
  readToken?: string;
}

// ============================================================
// Intent Status Messages
// ============================================================

export type IntentMessageType = "intent_status";

/**
 * The status update `useIntent` applies. In-app only, never a wire shape: the
 * status poll builds it from `/api/intent/:id/status`, and `mapStatusFrame`
 * builds it from the stream's `IntentStatusFrame` (`@xochi/shared`).
 */
export interface IntentWebSocketMessage {
  type: IntentMessageType;
  intentId: string;
  status: IntentStatus;
  txHash?: string;
  /** Destination fill hash (broadcast on cross-chain completion). */
  receivingTxHash?: string;
  /** Public fill receipt (Riddler #632) + its chain, broadcast on completion. */
  settlementTxHash?: string;
  settlementChainId?: ChainId;
  /** In-doubt signal (broadcast when an execute lands in reconcile). */
  reconciling?: boolean;
  /** Riddler's granular fill substatus, verbatim; see IntentState.substatus. */
  substatus?: string;
  error?: string;
  /** Machine-readable refund reason code (deposit routes) on a `refunded` status. */
  refundReason?: string;
  timestamp: string;
}

// ============================================================
// Payment Path Types
// ============================================================

/** How the token pull + gas execution is handled */
export type PaymentMethod =
  | "erc3009" // Direct transfer auth (USDC) - gasless
  | "permit2" // Universal permit - gasless
  | "pimlico" // ERC-4337 sponsored gas
  | "x402" // HTTP 402 micropayment
  | "mpp" // Machine Payment Protocol (raxol agents)
  | "approval" // On-chain approval (fallback, costs gas)
  | "deposit"; // Deposit route (Tron origin) - no pull, the user sends

// ============================================================
// Wire adapters: snake_case wire (worker/openapi) -> camelCase app types
//
// The worker emits the canonical snake_case contract (see QuoteResponseSchema
// in @xochi/shared and public/openapi.yaml). The React app stays camelCase;
// intentAPI.ts maps at the client boundary via these helpers. The `eip712`
// value is verbatim EIP-712 typed data -- its internal keys are already the
// standard camelCase and pass through unchanged.
// ============================================================

/**
 * The response contracts as the client applies them: every declared field is
 * held to its schema (a `fee_breakdown` without `gas_floor`, a non-string
 * `eip712`, a numeric `claim_info.factory_address` all fail), but an
 * undeclared top-level key is let through rather than failing the whole
 * quote, so an additive server field does not take every client down. The
 * decoders read the original object, never the parse output, so the EIP-712
 * payloads reach the wallet byte-for-byte as served.
 */
const QUOTE_RESPONSE = QuoteResponseSchema.passthrough();
const EXECUTE_RESPONSE = ExecuteResponseSchema.passthrough();

export function isQuoteResponseWire(
  value: unknown,
): value is QuoteResponseWire & { readonly escrow?: unknown } {
  return QUOTE_RESPONSE.safeParse(value).success;
}

export function isExecuteResponseWire(value: unknown): value is ExecuteResponseWire {
  return EXECUTE_RESPONSE.safeParse(value).success;
}

/**
 * Read the resolved settlement type out of the solver's opaque `route` bag.
 *
 * `route` is `z.record(z.string(), z.unknown())` in the contract: a passthrough
 * the worker does not model, so it arrives untyped. Narrow it to the closed
 * settlement vocabulary here rather than casting, and return undefined for
 * anything unrecognised. Callers that need it (the v2 deposit attestation) must
 * treat undefined as a refusal: a wrong guess produces a message that fails to
 * recover, which reads as a solver outage rather than as our bug.
 */
export function readResolvedSettlementType(
  route: Record<string, unknown> | undefined,
): SettlementType | undefined {
  const value = route?.settlement_type;
  // Reuses the shared predicate rather than re-listing the vocabulary. A second
  // copy of the closed set compiles fine and silently refuses every deposit
  // quote on whichever settlement type it forgot.
  return typeof value === "string" && isSettlementType(value) ? value : undefined;
}

export function mapQuoteResponse(
  w: QuoteResponseWire & { readonly escrow?: unknown },
): QuoteResponse {
  return {
    success: w.success,
    intentId: w.intent_id,
    quoteId: w.quote_id,
    canSolve: w.can_solve,
    preview: w.preview,
    toAmount: w.to_amount ?? "0",
    minToAmount: w.min_to_amount ?? "0",
    xochiFee: w.xochi_fee ?? "0",
    xochiFeeRate: w.xochi_fee_rate ?? "",
    costBps: w.cost_bps,
    feeBreakdown: w.fee_breakdown
      ? {
          tier: w.fee_breakdown.tier,
          assetClass: w.fee_breakdown.asset_class,
          gasFloor: {
            amount: w.fee_breakdown.gas_floor.amount,
            usd: w.fee_breakdown.gas_floor.usd,
          },
          solverFeeBps: w.fee_breakdown.solver_fee_bps,
          solverFee: w.fee_breakdown.solver_fee,
          priceImpactBps: w.fee_breakdown.price_impact_bps,
          priceImpact: w.fee_breakdown.price_impact,
          venueFeeBps: w.fee_breakdown.venue_fee_bps,
          venueFee: w.fee_breakdown.venue_fee,
          routingFeeBps: w.fee_breakdown.routing_fee_bps,
          routingFee: w.fee_breakdown.routing_fee,
          totalBps: w.fee_breakdown.total_bps,
          totalFee: w.fee_breakdown.total_fee,
          totalUsd: w.fee_breakdown.total_usd,
          surplusSharePct: w.fee_breakdown.surplus_share_pct,
        }
      : undefined,
    // Passed through, never defaulted. An absent field means the server did not
    // state the denomination, which the renderer has to be able to tell apart
    // from a server that said "origin".
    feeDenomination: w.fee_denomination,
    estimatedGasCost: w.estimated_gas_cost ?? "",
    // Passed through, never defaulted and never backfilled from intent_id.
    streamTopic: w.stream_topic,
    expiry: w.expiry,
    gasless: w.gasless ?? false,
    gaslessFee: w.gasless_fee,
    paymentMethod: w.payment_method,
    eip712Data: w.eip712,
    pullAuthorization: w.pull_authorization,
    depositAddress: w.deposit_address,
    depositAttestation: w.deposit_attestation,
    depositDeadline: w.deposit_deadline,
    settlementType: readResolvedSettlementType(w.route),
    recipientAddress: w.recipient_address,
    settlementOptions: w.settlement_options ?? [],
    claimInfo: w.claim_info
      ? { factoryAddress: w.claim_info.factory_address, salt: w.claim_info.salt }
      : undefined,
    error: w.error,
    errorCategory: w.error_category,
    minimumAmountUsd: w.minimum_amount_usd,
    minFillableUsd: w.min_fillable_usd,
    // Passed through untouched, never interpreted: the signer refuses it.
    ...("escrow" in w ? { escrow: w.escrow } : {}),
  };
}

export function mapExecuteResponse(w: ExecuteResponseWire): ExecuteResponse {
  return {
    success: w.success,
    intentId: w.intent_id,
    status: w.status as ExecuteResponse["status"],
    txHash: w.tx_hash,
    receivingTxHash: w.receiving_tx_hash,
    settlementTxHash: w.settlement_tx_hash,
    settlementChainId: w.settlement_chain_id as ChainId | undefined,
    bridgeTxHash: w.bridge_tx_hash,
    reconciling: w.reconciling,
    error: w.error,
    noteCommitment: w.note_commitment,
    stealthAddress: w.stealth_address,
    ephemeralPubKey: w.ephemeral_pub_key,
    viewTag: w.view_tag,
    readToken: w.read_token,
  };
}

// ============================================================
// Race Stream Messages
// ============================================================

export const RACE_MESSAGE_TYPES = ["race_started", "solver_bid", "race_won"] as const;

export type RaceMessageType = (typeof RACE_MESSAGE_TYPES)[number];

/**
 * Live race telemetry relayed from Riddler while an intent fills.
 *
 * DISPLAY ONLY. Intent status comes from lifecycle (`status`) frames and the status
 * poll; nothing here may advance a swap or change what the user is told they
 * received. `solver` is a pseudonymous handle, never an operator identity or an
 * address, and `elapsedMs` is the server's clock (the local one is decoration).
 */
export interface RaceWebSocketMessage {
  type: RaceMessageType;
  intentId: string;
  solver?: string;
  /** Destination amount this bid delivers (base units, string). */
  amountOut?: string;
  /** Price improvement against the accepted quote, in bps. */
  improvementBps?: number;
  /** Solvers active on this route when the race opened (race_started only). */
  solversActive?: number;
  /** Server-side ms since the race opened. */
  elapsedMs?: number;
  timestamp: string;
}

export function isRaceWebSocketMessage(value: unknown): value is RaceWebSocketMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    (RACE_MESSAGE_TYPES as readonly string[]).includes(obj.type) &&
    typeof obj.intentId === "string"
  );
}

// ============================================================
// Intent status (GET /api/intent/:id/status)
// ============================================================

/**
 * Granular origin-pull states the solver may emit that the `IntentStatus`
 * union doesn't model, bucketed into the nearest known state. Unknown/granular
 * strings otherwise reach `phaseFromStatus` (which drops them to the confirm
 * screen) and fall outside the poll's in-flight set (freezing the row mid-flight
 * -- the dead-spinner bug).
 */
export const GRANULAR_WIRE_STATUS: Readonly<Record<string, IntentStatus>> = {
  pulling: "executing",
  pulled: "executing",
  filling: "settling",
  filled: "completed",
  refunding: "settling",
  pull_failed: "failed",
  fill_failed: "failed",
  refund_failed: "failed",
};

/**
 * A raw `/status` value, decoded.
 *
 * `mapped` is a status this build models: a union member, or one of Riddler's
 * granular strings bucketed above. `unmapped` is any other string, and it is
 * deliberately NOT a guess at an outcome: it buckets to `executing` so the poll
 * runs on to a real terminal (an unrecognized string must never freeze the row),
 * and the machine shows it as "Still confirming" (reconciling) rather than as a
 * normal in-flight step. It can never decode to `completed`. This is the
 * fail-closed half of the CLAUDE.md "Status-vocabulary sync" rule.
 *
 * `absent` is a body with no status string at all: not a Riddler status, so
 * not a vocabulary signal. It keeps the in-flight bucket and nothing else.
 */
export type DecodedWireStatus =
  | { kind: "mapped"; status: IntentStatus }
  | { kind: "unmapped"; status: "executing"; raw: string }
  | { kind: "absent"; status: "executing" };

export function decodeWireStatus(raw: unknown): DecodedWireStatus {
  if (typeof raw !== "string") return { kind: "absent", status: "executing" };
  if (isIntentStatus(raw)) return { kind: "mapped", status: raw };
  const bucket = GRANULAR_WIRE_STATUS[raw];
  if (bucket) return { kind: "mapped", status: bucket };
  return { kind: "unmapped", status: "executing", raw };
}

/**
 * The normalized status of an in-flight intent, read from `GET
 * /api/intent/:id/status`.
 */
export interface IntentStatusData {
  /**
   * The intent this status is about, echoed by the worker (`intent_id` on every
   * branch of `buildStatusDeliverable`). Carried so a consumer that merges the
   * response into a stored record can check it is merging into the right one;
   * null when an older worker omits it.
   */
  intentId: string | null;
  status: IntentStatus;
  /**
   * True when the wire status was outside this build's vocabulary and `status`
   * is only the in-flight bucket (`decodeWireStatus`). Absent means mapped.
   */
  unmapped?: boolean;
  txHash: string | null;
  receivingTxHash: string | null;
  /** Public fill receipt (Riddler #632) + its chain; the receipt CTA keys off these. */
  settlementTxHash: string | null;
  settlementChainId: number | null;
  error: string | null;
  /** Machine-readable refund reason code (deposit routes); null otherwise. */
  refundReason: string | null;
  /**
   * Riddler's granular origin-pull/fill substatus, passed through verbatim
   * (pulling | pulled | filling | filled | refunding | ...). NOT a status: the
   * top-level `status` is what advances the lifecycle.
   *
   * It is read for one thing -- telling a user whose destination leg has already
   * landed (`filled`) apart from one still waiting. Riddler can hold an intent at
   * top-level `settling` with `substatus: filled` indefinitely, which is exactly
   * the state a stuck stealth swap sits in (xochi#376): the money is delivered and
   * the app was showing an undifferentiated "settling".
   */
  substatus: string | null;
  terminal: boolean;
}

/**
 * Discriminated result of a status poll:
 *  - `IntentStatusData` on a 200,
 *  - `{ notFound: true }` on a definitive 404 (a definitive absence, NOT a
 *    verdict: only a pre-dispatch row may be terminalized on it, see
 *    `isSweepablePreDispatch`),
 *  - `null` on a transient failure (retry on the next tick).
 */
export type IntentStatusResult = IntentStatusData | { notFound: true } | null;

/**
 * Statuses that are settled: no further status polling is needed. Xochi's own
 * lifecycle vocabulary (`IntentStatus`), and the fallback the status decoder
 * uses when the worker omits `terminal`.
 */
export const TERMINAL_INTENT_STATUSES: Readonly<Partial<Record<IntentStatus, true>>> = {
  completed: true,
  failed: true,
  expired: true,
  refunded: true,
};

export function isTerminalIntentStatus(status: IntentStatus): boolean {
  return TERMINAL_INTENT_STATUSES[status] === true;
}

// ============================================================
// Intent records (GET /api/intent/:id, GET /api/intent/history)
// snake_case wire; plain scalars, no signed data.
// ============================================================

export interface IntentRecord {
  id: string;
  walletAddress: string;
  status: IntentStatus;
  fromChainId: ChainId;
  toChainId: ChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  quoteId: string;
  tier: string;
  feeRate: number;
  settlementType: SettlementType;
  aztecNoteHash?: string;
  txHash?: string;
  /** Public fill receipt (Riddler #632) + its chain, persisted at completion. */
  settlementTxHash?: string;
  settlementChainId?: ChainId;
  createdAt: string;
  updatedAt: string;
  error?: string;
  destinationType?: DestinationType;
}

export interface IntentRecordWire {
  id: string;
  wallet_address?: string;
  status: string;
  from_chain_id?: ChainId;
  to_chain_id?: ChainId;
  from_token?: string;
  to_token?: string;
  from_amount?: string;
  to_amount?: string;
  quote_id?: string;
  tier?: string;
  fee_rate?: number;
  settlement_type?: SettlementType;
  aztec_note_hash?: string;
  tx_hash?: string;
  settlement_tx_hash?: string | null;
  settlement_chain_id?: ChainId | null;
  created_at?: string;
  updated_at?: string;
  error?: string;
}

export function mapIntentRecord(w: IntentRecordWire): IntentRecord {
  return {
    id: w.id,
    walletAddress: w.wallet_address ?? "",
    status: w.status as IntentRecord["status"],
    fromChainId: w.from_chain_id as ChainId,
    toChainId: w.to_chain_id as ChainId,
    fromToken: w.from_token ?? "",
    toToken: w.to_token ?? "",
    fromAmount: w.from_amount ?? "0",
    toAmount: w.to_amount ?? "0",
    quoteId: w.quote_id ?? "",
    tier: w.tier ?? "",
    feeRate: w.fee_rate ?? 0,
    settlementType: w.settlement_type ?? "public",
    aztecNoteHash: w.aztec_note_hash,
    txHash: w.tx_hash,
    settlementTxHash: w.settlement_tx_hash ?? undefined,
    settlementChainId: w.settlement_chain_id ?? undefined,
    createdAt: w.created_at ?? "",
    updatedAt: w.updated_at ?? "",
    error: w.error,
  };
}
