/**
 * RampActivityList
 *
 * Peer onramp purchases in Activity, beside the swap log and public sends.
 * Each row is a sanitized local summary (ramp/recovery/summaries): what the
 * review screen showed and a bounded state. No provider id, payment handle or
 * transaction link is stored for it, so none is shown. Renders nothing for a
 * wallet without purchases.
 */

import type { RampOperationSummary } from "../ramp/recovery/summaries.js";
import { heldReleaseEstimate } from "../ramp/recovery/summaries.js";
import { formatTimeAgo, formatTokenAmount } from "../utils/format.js";

function label(row: RampOperationSummary): string {
  if (row.abandoned) return "Abandoned, no transfer submitted";
  if (row.payout_state === "held") {
    const release = heldReleaseEstimate(row);
    return release
      ? `Payout held, estimated release around ${release.toISOString().slice(0, 10)} (not guaranteed)`
      : "Payout held";
  }
  switch (row.state) {
    case "completed":
      return "Received";
    case "in_doubt":
      return "Status uncertain, check before any new transfer";
    case "failed":
      return row.submitted ? "Did not complete" : "Did not start, no transfer submitted";
    case "quoted":
      return Date.parse(row.quote_expires_at) <= Date.now()
        ? "Quote expired, no transfer submitted"
        : "Quote not submitted";
    case "action_required":
      return "Waiting for you";
    default:
      return "In progress";
  }
}

export function RampActivityList({
  ramps,
  wallet,
}: {
  ramps: readonly RampOperationSummary[];
  wallet: string | undefined;
}) {
  const rows = wallet ? ramps.filter((row) => row.wallet === wallet.toLowerCase()) : [];
  if (rows.length === 0) return null;
  return (
    <section className="send-activity" aria-label="Purchases">
      <h3 className="send-activity__title">Purchases</h3>
      <ul className="send-activity__list">
        {rows.map((row) => (
          <li key={row.operation_id} className="send-activity__row">
            <span className="send-activity__amount">
              Buy{" "}
              {formatTokenAmount(
                BigInt(row.receive.atomic),
                row.receive.asset.decimals,
                row.receive.asset.decimals,
              )}{" "}
              {row.receive.asset.kind === "crypto" ? row.receive.asset.symbol : ""}
            </span>
            <span className="send-activity__meta">
              via Peer / {row.rail.label} · {label(row)} ·{" "}
              {formatTimeAgo(Date.parse(row.created_at))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
