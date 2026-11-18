/**
 * OfframpActivityList
 *
 * Payment-app cash-outs in Activity: the sanitized local summary only (rail,
 * currency, USDC amount, bounded status and terminal totals). No payee, deposit or transaction
 * data is stored for it, so none can be shown. Renders nothing when empty.
 */

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { railName } from "../availability/model.js";
import { formatTimeAgo } from "../../utils/format.js";
import {
  listLocalOfframps,
  subscribeLocalOfframps,
  type OfframpActivityItem,
} from "./localOfframps.js";
import { formatMixedCashOut, formatUsdc } from "./model.js";

const STATUS: Record<OfframpActivityItem["status"], string> = {
  mixed: "Partly cashed out and returned",
  open: "Open",
  in_doubt: "Checking status",
  delivered: "Paid out",
  returned: "Returned to wallet",
  not_started: "Not started, nothing deposited",
};

const PHASE: Record<NonNullable<OfframpActivityItem["phase"]>, string> = {
  awaiting_buyer: "awaiting a buyer",
  matched: "matched with a buyer",
  delivering: "partly paid out",
  delivered: "paid out",
  returned: "returned",
};

export function useLocalOfframps(): OfframpActivityItem[] {
  const { address } = useAccount();
  const [rows, setRows] = useState(() => listLocalOfframps(address));
  useEffect(() => {
    setRows(listLocalOfframps(address));
    return subscribeLocalOfframps(() => setRows(listLocalOfframps(address)));
  }, [address]);
  return rows;
}

export function OfframpActivityList({ items }: { items: readonly OfframpActivityItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="send-activity" aria-label="Cash-outs">
      <h3 className="send-activity__title">Cash-outs</h3>
      <ul className="send-activity__list">
        {items.map((item) => (
          <li key={item.id} className="send-activity__row">
            <span className="send-activity__amount">
              {item.status === "mixed" && item.totals
                ? formatMixedCashOut(item.totals.filled, item.totals.returned)
                : formatUsdc(item.data.amount)}
            </span>
            <span className="send-activity__meta">
              {`to your ${railName({ rail: { id: item.data.rail, label: item.data.rail } })} (${item.data.currency})`}
            </span>
            <span className="send-activity__status">
              {item.status === "open" && item.phase ? PHASE[item.phase] : STATUS[item.status]}
              <time dateTime={new Date(item.timestamp).toISOString()}>
                {formatTimeAgo(item.timestamp)}
              </time>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
