/**
 * The "Fees (incl. network)" figure, shared by the quote panel drawer, the
 * confirm modal and the configurator's "What users see" panel (through
 * quoteCost), so they can never show different numbers for one quote.
 *
 * Served by the worker and by nothing else (`cost_bps`, read through the
 * receipt decoder `costOf`). The network minimum is inside it, hence "incl.
 * network". Absent means UNKNOWN and says so: a fabricated zero would read as a
 * free trade.
 */

import { costOf } from "@xochi/client";
import type { QuoteResponse } from "../types/intent.js";
import { totalCostUsd, formatUsd, approxUsd } from "./receiptCost.js";
import { formatCostPct } from "./priceImpact.js";

export interface ServedFees {
  /** Served cost in bps, or null when the worker served none. */
  bps: number | null;
  /** Dollar value of the fees, or null when no honest figure exists. */
  usd: number | null;
  /** "~$2.20 (0.22%)", "0.22%" without a dollar figure, or "Unavailable". */
  label: string;
}

export function servedFees(
  quote: QuoteResponse,
  inputTokens: number | null,
  inputPriceUsd: number | undefined,
): ServedFees {
  const cost = costOf(quote);
  const bps = cost.kind === "served" ? cost.bps : null;
  const usd = totalCostUsd({
    servedTotalUsd: cost.kind === "served" ? (cost.totalUsd ?? undefined) : undefined,
    costBps: bps,
    inputTokens,
    inputPriceUsd,
  });
  const usdText = formatUsd(usd);
  const label =
    bps === null
      ? "Unavailable"
      : usdText
        ? `${approxUsd(usdText)} (${formatCostPct(bps)})`
        : formatCostPct(bps);
  return { bps, usd, label };
}
