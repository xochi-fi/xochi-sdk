// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Plain-language decline copy. No jargon, no percentages-of-percentages: the
 * point the user needs is that the cost does not shrink with the order, so the
 * fix is a bigger order (or a different destination).
 */
export function costRatioDeclineMessage(costUsd: number, minimumUsd: number): string {
  const cost = costUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  const min = minimumUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return `Amount too small for this route. Sending to this chain costs about ${cost} no matter how much you send, so most of a small amount is used up. Send at least ${min}, or pick a different destination chain.`;
}
