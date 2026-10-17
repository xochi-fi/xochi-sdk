/**
 * Trading Constants
 *
 * Shared trading configuration for slippage, quotes, and limits.
 */

// ============================================================
// Slippage Configuration
// ============================================================

/** Default slippage in basis points (0.5%) */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Available slippage options in basis points */
export const SLIPPAGE_OPTIONS = [10, 50, 100, 200] as const;

export type SlippageOption = (typeof SLIPPAGE_OPTIONS)[number];

/** Slippage presets with labels */
export const SLIPPAGE_PRESETS = {
  low: 10, // 0.1%
  medium: 50, // 0.5%
  high: 100, // 1%
} as const;

// ============================================================
// Quote Configuration
// ============================================================

/** Quote expiry in seconds */
export const QUOTE_EXPIRY_SEC = 30;

/** Maximum retries for failed quotes */
export const MAX_QUOTE_RETRIES = 3;

// ============================================================
// Trading Limits
// ============================================================

/** Maximum decimal places for token amounts */
export const MAX_TOKEN_DECIMALS = 18;

/** Minimum trade amount in USD */
export const MIN_TRADE_USD = 1;

/** Maximum slippage percentage */
export const MAX_SLIPPAGE_PERCENT = 50;

/** Minimum slippage percentage */
export const MIN_SLIPPAGE_PERCENT = 0.01;

/**
 * Hard ceiling on how far below market a fill may be before execution is
 * refused. This is all-in value loss (fees + fixed network minimum + market
 * slippage) versus the live market rate, not the user's configurable slippage
 * tolerance. Protects users from executing trades -- typically dust orders --
 * where costs eat more than half the notional.
 */
export const MAX_PRICE_IMPACT_PERCENT = 50;

// ============================================================
// Trust Thresholds
// ============================================================

/**
 * Minimum trust score for Aztec L2 shielded settlement (the Private privacy
 * level). L1 stealth (ERC-5564) is NOT trust-gated: privacy is free by default,
 * so any wallet can settle to a one-time stealth address and simply pays its own
 * trust-tier fee. Only the Aztec-shielded Private level (50+) requires trust;
 * it is the only planned shielded level and is not yet available (shielded
 * settlement is off everywhere). Sovereign (75+) is excluded by decision D1
 * (xochi `docs/planning/shielded-execution.md`).
 */
export const SHIELDED_MIN_SCORE = 50;

/** Trust score thresholds by tier */
export const TRUST_THRESHOLDS = {
  trusted: 25,
  verified: 50,
  premium: 75,
  institutional: 100,
} as const;

// ============================================================
// Numeric Constants
// ============================================================

/** Basis points denominator (1 bps = 0.01%) */
export const BPS_DENOMINATOR = 10_000;

/** Maximum deadline offset in seconds (1 hour) */
export const MAX_DEADLINE_OFFSET_SEC = 3600;

/**
 * Server-side ceiling on a quote request's `deadline`, in seconds from now.
 *
 * Deliberately looser than MAX_DEADLINE_OFFSET_SEC, which is the CLIENT's rule
 * (src/utils/validators.ts) and the value the frontend actually sends. This is
 * the outer bound the API will accept from anyone, sized so an agent or a device
 * with a skewed clock is not rejected for asking a reasonable question.
 *
 * The reason there is a ceiling at all: `deadline` is what the user signs into
 * the intent EIP-712, so an unbounded value is an authorization with no
 * expiry -- and `decideReconcile` treats "past the signed deadline" as the point
 * where an in-doubt intent can no longer move funds.
 */
export const MAX_QUOTE_DEADLINE_FUTURE_SEC = 24 * 3600;

/**
 * How far in the PAST a quote `deadline` may be and still be accepted, in
 * seconds. Pure clock-skew tolerance: no correct client asks for a deadline that
 * has already passed, but one whose clock is behind might.
 *
 * A past-dated deadline is not inert data: the abandoned-deposit sweep reads
 * `deadline` to decide when a deposit route has died, so `deadline: 1` would
 * mean "terminalise this live route on the next cron tick". The sweep gates on
 * the server-set `created_at` too; this is the other half: the value never
 * gets stored in the first place.
 */
export const MAX_QUOTE_DEADLINE_PAST_SEC = 3600;

/**
 * Sanity bound on the SOLVER-supplied `deposit_deadline`, in seconds from the
 * quote, applied only when Xochi persists it.
 *
 * The client treats this field as untrusted: `POLL_CEILING_MAX_MS` exists
 * because a malformed or hostile `deposit_deadline` far in the future must not
 * turn the poll into a permanent background request loop. Persisting it makes
 * the server trust it more than the browser does, and it is the PRIMARY gate
 * on the abandoned-deposit sweep (`COALESCE(deposit_deadline, deadline)`), so
 * one bad value -- a misparsed `XOCHI_DEPOSIT_DEADLINE_SECONDS`, a solver bug
 * -- would make every deposit row permanently and silently unsweepable.
 *
 * Riddler's default is 1800s, so this is two orders of magnitude of headroom: it
 * rejects nothing a correctly configured solver can mint. A value outside it is
 * stored as NULL, which degrades the sweep to the quote `deadline` rather than
 * to no gate at all. The value SERVED to the client is never altered -- it is
 * covered by the deposit attestation signature, so changing it would break
 * client-side verification.
 */
export const MAX_DEPOSIT_WINDOW_SEC = 24 * 3600;

/** Maximum proof age in seconds (1 hour) -- proofs older than this are rejected server-side */
export const MAX_PROOF_AGE_SEC = 3600;

/** Grace period for rotated provider sets in seconds (24 hours) */
export const PROVIDER_SET_GRACE_PERIOD_SEC = 86400;

/** Ethereum address length including 0x prefix */
export const ETH_ADDRESS_LENGTH = 42;

/** Max slippage in basis points */
export const MAX_SLIPPAGE_BPS = MAX_SLIPPAGE_PERCENT * 100;

// ============================================================
// Attestation Diminishing Returns
// ============================================================

/** Multipliers for attestation scoring within a category */
export const ATTESTATION_MULTIPLIERS = {
  first: 1.0,
  second: 0.25,
  subsequent: 0.1,
} as const;

// ============================================================
// Query Limits
// ============================================================

/** Default query limit for paginated API responses */
export const DEFAULT_QUERY_LIMIT = 50;

/** Maximum query limit for announcement scanning */
export const MAX_ANNOUNCEMENT_LIMIT = 1000;

/** Default announcement query limit */
export const DEFAULT_ANNOUNCEMENT_LIMIT = 100;

// ============================================================
// Auth & Rate Limiting
// ============================================================

/** Rate limit window in milliseconds (15 minutes) */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Maximum rate-limited attempts per window */
export const RATE_LIMIT_MAX_ATTEMPTS = 5;

/** JWT token expiry in hours */
export const JWT_EXPIRY_HOURS = 4;

/** Tier proof expiry in milliseconds (7 days) */
export const TIER_PROOF_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Max rate limit store size before cleanup */
export const RATE_LIMIT_STORE_MAX = 10_000;

/** Base delay for failed auth in milliseconds */
export const AUTH_FAILURE_BASE_DELAY_MS = 500;

/** Max delay for failed auth in milliseconds */
export const AUTH_FAILURE_MAX_DELAY_MS = 5000;

/** Max demo code length */
export const MAX_DEMO_CODE_LENGTH = 100;

// ============================================================
// Mock Spread
// ============================================================

/** Mock spread factor (1% spread = 99/100) */
export const MOCK_SPREAD_NUMERATOR = 99n;
export const MOCK_SPREAD_DENOMINATOR = 100n;

// ============================================================
// Bundled Trading Config
// ============================================================

/** All trading constants in one object */
export const TRADING = {
  defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
  slippageOptions: SLIPPAGE_OPTIONS,
  quoteExpirySec: QUOTE_EXPIRY_SEC,
  maxQuoteRetries: MAX_QUOTE_RETRIES,
  maxTokenDecimals: MAX_TOKEN_DECIMALS,
  minTradeUsd: MIN_TRADE_USD,
  maxSlippagePercent: MAX_SLIPPAGE_PERCENT,
  minSlippagePercent: MIN_SLIPPAGE_PERCENT,
  maxPriceImpactPercent: MAX_PRICE_IMPACT_PERCENT,
  shieldedMinScore: SHIELDED_MIN_SCORE,
} as const;
