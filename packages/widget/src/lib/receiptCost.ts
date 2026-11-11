/**
 * Total-cost USD companion for the quote receipt (Phase 3, register R3).
 *
 * The receipt's fees figure (fees plus network cost) is the served `cost_bps` with a dollar
 * companion: "22 bps (~$2.20)". The dollar figure prefers the breakdown's own
 * served `total_usd`; the client derivation (bps times the input's USD value)
 * is the fallback when the breakdown is absent, never the default, because the
 * served figure was computed by the party that actually charges the fee.
 *
 * Null means no companion renders. A missing figure must never become $0.00:
 * absent is unknown, and unknown must not look like free.
 *
 * The served figure is display data from the same trust class as the decline
 * figures (declineGuidance.ts guards those with plausibleUsd): a hostile or
 * corrupt quote must not put an arbitrary number beside the headline price.
 * Strict parse (Number, not parseFloat: "2.2abc" is corrupt, not 2.2) plus
 * the same nonsense-magnitude bound; a failing served figure falls through to
 * the client derivation, whose scale is bounded by the user's own input.
 */
const MAX_PLAUSIBLE_TOTAL_USD = 1_000_000;

export function totalCostUsd(input: {
  /** fee_breakdown.total_usd as served, when the breakdown is present. */
  servedTotalUsd: string | undefined;
  /** Served fees in basis points (fees plus network cost), or null when the guard could not run. */
  costBps: number | null;
  /** The pay amount in whole tokens, or null when unparseable. */
  inputTokens: number | null;
  /** USD price of the pay token from the price feed; undefined when missing. */
  inputPriceUsd: number | undefined;
}): number | null {
  const served = Number(input.servedTotalUsd ?? "");
  if (Number.isFinite(served) && served > 0 && served <= MAX_PLAUSIBLE_TOTAL_USD) return served;

  if (
    input.costBps !== null &&
    input.costBps > 0 &&
    input.inputTokens !== null &&
    input.inputTokens > 0 &&
    input.inputPriceUsd !== undefined &&
    input.inputPriceUsd > 0
  ) {
    return (input.inputTokens * input.inputPriceUsd * input.costBps) / 10_000;
  }

  return null;
}

/** Whole cents under the receipt's rounding, or null when there is no honest figure. */
function usdCents(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) return null;
  return Math.round(usd * 100);
}

const centsLabel = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The receipt's one rounding rule for dollar figures: nearest cent with
 * thousands separators ("$2,350.40"), and "<$0.01" for a real amount that would
 * round to zero. Null when there is no honest figure, so the caller renders
 * nothing rather than "$0.00". Callers prefix "~" only when the value does not
 * start with "<".
 */
export function formatUsd(usd: number | null): string | null {
  const cents = usdCents(usd);
  if (cents === null) return null;
  return cents === 0 ? "<$0.01" : centsLabel(cents);
}

/** "~$2.20", or "<$0.01" unchanged: an approximation mark never stacks on "<". */
export function approxUsd(formatted: string): string {
  return formatted.startsWith("<") ? formatted : `~${formatted}`;
}

/**
 * Splits the gap to market into the served fees and the remainder, the spread,
 * as drawer figures: "~$0.43 (2.14%)", or the percent alone when there is no
 * honest dollar figure.
 *
 * The gap compares the payout with the market-rate payout, so it is all-in: the
 * fees are taken before the payout is priced, and whatever else the user gives
 * up (the solver's pricing against the feed) is what remains. Spread is
 * therefore DERIVED as gap minus fees, never served.
 *
 * Every figure is computed from the rounded figures shown beside it (whole
 * basis points, whole cents), so Fees + Spread = Total on screen exactly.
 * Spread is null when it cannot be derived honestly: no served fee figure, or
 * fees at or above the gap (the feed and the solver disagree by more than the
 * spread, and a negative or zero "spread" would be a claim about neither).
 * Its dollar figure is dropped when either dollar input is missing or reads
 * under a cent.
 */
export function decomposeMarketGap(input: {
  /** Gap to market, percent of the market-rate payout (> 0). */
  gapPct: number;
  /** Gap to market in dollars, or null without a price for the payout token. */
  gapUsd: number | null;
  /** Served fees (fees plus network cost) in basis points, or null when absent. */
  feeBps: number | null;
  /** Dollar figure for those fees, or null. */
  feesUsd: number | null;
}): { total: string; spread: string | null } {
  const gapBps = input.gapPct * 100;
  const totalBps = Math.round(gapBps);
  const totalPct = totalBps === 0 && gapBps > 0 ? "<0.01%" : `${(totalBps / 100).toFixed(2)}%`;
  const totalUsd = formatUsd(input.gapUsd);
  const total = totalUsd ? `${approxUsd(totalUsd)} (${totalPct})` : totalPct;
  if (input.feeBps === null || !Number.isFinite(input.feeBps)) return { total, spread: null };
  const spreadBps = totalBps - Math.round(input.feeBps);
  if (spreadBps <= 0) return { total, spread: null };

  const spreadPct = `${(spreadBps / 100).toFixed(2)}%`;
  const gapCents = usdCents(input.gapUsd);
  const feeCents = usdCents(input.feesUsd);
  const spreadCents =
    gapCents !== null && feeCents !== null && gapCents > 0 && feeCents > 0
      ? gapCents - feeCents
      : 0;
  return {
    total,
    spread: spreadCents > 0 ? `~${centsLabel(spreadCents)} (${spreadPct})` : spreadPct,
  };
}

/**
 * Splits a dollar total, as formatUsd shows it, across parts weighted by their
 * base-unit amounts, so the parts always add up to the shown total to the cent.
 * The total's whole cents are allocated in proportion to the weights by the
 * largest-remainder method (ties go to the earlier part). Rounding each part on
 * its own would not reconcile: three parts of $0.036, $0.027 and $0.036 read
 * $0.04 + $0.03 + $0.04 = $0.11 under a $0.10 total.
 *
 * A part that gets no whole cent reads "<$0.01", or "$0.00" when its weight is
 * zero. Null when the total shows no whole cent or a weight is negative or they
 * sum to nothing, so the caller falls back to token amounts for every part.
 */
export function splitUsd(totalUsd: number | null, weights: readonly bigint[]): string[] | null {
  const cents = usdCents(totalUsd);
  const sum = weights.reduce((acc, w) => acc + w, 0n);
  if (cents === null || cents === 0 || sum <= 0n || weights.some((w) => w < 0n)) return null;
  const total = BigInt(cents);
  const floors = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w) => (total * w) % sum);
  const left = Number(total - floors.reduce((acc, f) => acc + f, 0n));
  const byRemainder = weights
    .map((_, i) => i)
    .sort((a, b) =>
      remainders[b] > remainders[a] ? 1 : remainders[b] < remainders[a] ? -1 : a - b,
    );
  const bumped = new Set(byRemainder.slice(0, left));
  return floors.map((f, i) => {
    const part = Number(f) + (bumped.has(i) ? 1 : 0);
    return part > 0 ? centsLabel(part) : weights[i] > 0n ? "<$0.01" : centsLabel(0);
  });
}
