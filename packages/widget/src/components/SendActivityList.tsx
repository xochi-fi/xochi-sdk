/**
 * SendActivityList
 *
 * Public sends from the Send tab, in Activity beside the swap log. Each row is
 * what the review screen showed plus the public transaction hash, linked to the
 * chain's explorer. Renders nothing for a wallet that has sent nothing.
 */

import { getExplorerTxUrl, type SelectableChainId } from "@xochi/client";
import type { SendActivityItem } from "../lib/localSends.js";
import { chainName } from "../pages/send/addressSend.js";
import { formatTimeAgo, formatTokenAmount, truncateAddress } from "../utils/format.js";

const STATUS: Record<SendActivityItem["status"], string> = {
  pending: "Submitted",
  completed: "Sent",
  failed: "Failed",
};

export function SendActivityList({ sends }: { sends: readonly SendActivityItem[] }) {
  if (sends.length === 0) return null;
  return (
    <section className="send-activity" aria-label="Sends">
      <h3 className="send-activity__title">Sends</h3>
      <ul className="send-activity__list">
        {sends.map((send) => {
          const { data } = send;
          const explorer = getExplorerTxUrl(data.chainId as SelectableChainId, data.txHash);
          return (
            <li key={send.id} className="send-activity__row">
              <span className="send-activity__amount">
                {formatTokenAmount(BigInt(data.amount), data.decimals, data.decimals)} {data.symbol}
              </span>
              <span className="send-activity__meta">
                to {truncateAddress(data.recipient)} on {chainName(data.chainId)} ·{" "}
                {STATUS[send.status]} · {formatTimeAgo(send.timestamp)}
              </span>
              {explorer && (
                <a href={explorer} target="_blank" rel="noopener noreferrer">
                  {`Transaction ${truncateAddress(data.txHash)}`}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
