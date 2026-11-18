import type { ReactNode } from "react";
import type { RampLegState, XochiRampPreview } from "@xochi/client";
import { chainName } from "../../pages/send/addressSend.js";
import { routeMoney } from "../route/RampRouteSteps.js";
export function OfframpRouteReview({
  status,
  preview,
  receipt,
  busy,
  authorized,
  onAction,
  note,
  children,
}: {
  status: RampLegState;
  preview?: XochiRampPreview;
  receipt: string;
  busy?: boolean;
  authorized: boolean;
  onAction(action: "quote" | "execute" | "check" | "balance"): void;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <section className="send-review" aria-label="Two-leg cash-out review">
      <h4>1. Route into Base USDC</h4>
      <p>
        Xochi routes your asset to your wallet on Base. Then review a fresh Peer estimate and
        approve the cash-out separately. These transactions are not atomic; Peer fills are
        approximate and asynchronous.
      </p>
      {children}
      {preview && (
        <dl className="send-review__facts">
          <dt>Route pays</dt>
          <dd>
            {routeMoney(preview.pay)}
            {preview.pay.asset.kind === "crypto" &&
              ` on ${chainName(Number(preview.pay.asset.chain_id.slice(7)))}`}
          </dd>
          <dt>Route receives after fees</dt>
          <dd>{routeMoney(preview.receive)} on Base</dd>
          <dt>Recipient</dt>
          <dd className="send-review__mono">{preview.recipient}</dd>
          <dt>Quote expires</dt>
          <dd>{preview.expiresAt}</dd>
        </dl>
      )}
      {status === "failed" && (
        <p role="alert">
          The Xochi route failed or was returned. Peer has not started. Retry obtains a fresh route
          quote.
        </p>
      )}
      {["not_started", "action_required", "failed"].includes(status) && (
        <button
          className="send-secondary"
          disabled={busy || !authorized}
          onClick={() => onAction("quote")}
        >
          Review fresh Xochi quote
        </button>
      )}
      {status === "action_required" && (
        <button
          className="submit-btn send-cta"
          disabled={busy || !authorized || !preview || Date.parse(preview.expiresAt) <= Date.now()}
          onClick={() => onAction("execute")}
        >
          Approve wallet: route into Base USDC
        </button>
      )}
      {["processing", "in_doubt"].includes(status) && (
        <>
          <p role="status">
            Xochi route {status.replaceAll("_", " ")}. Do not repeat the transfer. Peer has not
            started.
          </p>
          <button disabled={busy} onClick={() => onAction("check")}>
            Check Xochi route status
          </button>
        </>
      )}
      {status === "completed" && (
        <>
          <p>Route receipt: {receipt}</p>
          <button disabled={busy} onClick={() => onAction("balance")}>
            Check spendable Base USDC
          </button>
        </>
      )}
      <h4>2. Peer cash-out</h4>
      <p>
        Blocked until the route completes and a fresh balance read confirms spendable Base USDC in
        your wallet. No Peer deposit has been started.
      </p>
      {note && <p role="status">{note}</p>}
    </section>
  );
}
