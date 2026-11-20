import { useEffect, useState, type ReactNode } from "react";
import {
  rampOutcome,
  CHAIN_NAMES,
  type RampAction,
  type RampMoney,
  type RampSnapshot,
  type XochiRampPreview,
} from "@xochi/client";
import { formatUnits } from "viem";

export const routeMoney = (money: RampMoney) =>
  `${formatUnits(BigInt(money.atomic), money.asset.decimals)} ${money.asset.kind === "crypto" ? money.asset.symbol : money.asset.currency}`;

/** Public presentation only: provider and wallet signing material never enters this view. */
export function RampRouteSteps({
  snapshot,
  preview,
  wallet,
  received,
  busy,
  disabled,
  quoteDisabled,
  completedNote,
  onAction,
  children,
}: {
  snapshot: RampSnapshot;
  preview?: XochiRampPreview;
  wallet: string;
  received: RampMoney;
  busy?: boolean;
  disabled?: boolean;
  quoteDisabled?: boolean;
  completedNote?: string;
  onAction(action: RampAction): void;
  children?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [preview]);
  if (snapshot.peer.state !== "completed" || snapshot.peer.payout_state === "held") return null;
  const route = snapshot.xochi;
  const state = route?.state ?? "not_started";
  const outcome = rampOutcome(snapshot);
  const active = ["processing", "in_doubt"].includes(state);
  const can = (action: RampAction) =>
    !disabled && !busy && (!route || snapshot.allowed_actions.includes(action));
  const expired = preview && Date.parse(preview.expiresAt) <= Math.max(now, Date.now());
  return (
    <section className="ramp-route" aria-label="Optional Xochi route">
      <h3>Peer purchase complete</h3>
      <p>
        Peer delivered {routeMoney(received)} on Base to{" "}
        <span className="ramp-route__address">{wallet}</span>.
      </p>
      <p>
        Routing is a separate, optional Xochi transaction with its own quote and wallet approval. It
        cannot undo the completed purchase.
      </p>
      {state === "skipped" ? (
        <p role="status">
          Route skipped. Your Base USDC stays in {wallet} on Base. Peer remains completed.
        </p>
      ) : state === "completed" ? (
        <>
          <p role="status">
            Xochi route completed. Overall outcome: {outcome.state.replaceAll("_", " ")}.
          </p>
          {completedNote && <p>{completedNote}</p>}
          <p>
            Route receipt:{" "}
            <span className="ramp-route__address">
              {route?.transaction_hash ?? preview?.quoteId ?? snapshot.operation_id}
            </span>
          </p>
        </>
      ) : (
        <>
          {state === "failed" && (
            <p role="alert">
              The Xochi route did not complete. Peer remains completed:{" "}
              {outcome.state.replaceAll("_", " ")}. Your Base USDC is in {wallet} on Base. Retry
              requests a fresh Xochi quote only.
            </p>
          )}
          {active && (
            <p role="status">
              Peer remains completed. Xochi route: {state.replaceAll("_", " ")}. Funds may have
              moved from Base; check this route and Xochi Activity before trying another transfer.
            </p>
          )}
          {!active && children}
          {preview && state === "action_required" && (
            <dl>
              <dt>Route pays</dt>
              <dd>{routeMoney(preview.pay)} on Base</dd>
              <dt>Route receives after fees</dt>
              <dd>
                <span>{routeMoney(preview.receive)}</span>
                {preview.receive.asset.kind === "crypto" &&
                  ` on ${CHAIN_NAMES[Number(preview.receive.asset.chain_id.slice(7)) as keyof typeof CHAIN_NAMES] ?? preview.receive.asset.chain_id}`}
              </dd>
              <dt>Payout</dt>
              <dd>Receive exactly the quoted amount, or a full refund.</dd>
              <dt>Settlement</dt>
              <dd>{preview.settlement}</dd>
              <dt>Recipient</dt>
              <dd className="ramp-route__address">{preview.recipient}</dd>
              <dt>Quote expires</dt>
              <dd>{preview.expiresAt}</dd>
            </dl>
          )}
          {expired && state === "action_required" && (
            <p role="status">
              Route quote expired. Review a fresh quote before approving; Peer remains completed.
            </p>
          )}
          {["not_started", "quoted", "approval_required", "action_required"].includes(state) && (
            <button
              type="button"
              disabled={!can("approve_route") || quoteDisabled}
              onClick={() => onAction("approve_route")}
            >
              Review fresh Xochi quote
            </button>
          )}
          {state === "action_required" && (
            <button
              type="button"
              disabled={!can("execute_route") || quoteDisabled || !preview || !!expired}
              onClick={() => onAction("execute_route")}
            >
              Route to Base
            </button>
          )}
          {state === "failed" && route?.recoverable && (
            <button
              type="button"
              disabled={!can("recover_route") || quoteDisabled}
              onClick={() => onAction("recover_route")}
            >
              Retry Xochi route with a fresh quote
            </button>
          )}
          {active && (
            <button
              type="button"
              disabled={!can("check_status")}
              onClick={() => onAction("check_status")}
            >
              Check Xochi route status
            </button>
          )}
          {!active && (
            <button
              type="button"
              disabled={!can("skip_route")}
              onClick={() => onAction("skip_route")}
            >
              Skip route and keep Base USDC
            </button>
          )}
        </>
      )}
    </section>
  );
}
