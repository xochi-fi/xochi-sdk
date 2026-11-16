/**
 * OnrampSteps
 *
 * Everything after the wallet approval of a Peer onramp: payment, capture,
 * fulfillment and status. Shared by the live purchase (BuyOnramp) and by a
 * purchase resumed after a reload or a return from Peer (ResumeOnramp), so both
 * paths offer exactly the same actions for the same snapshot.
 *
 * An `in_doubt` leg offers only "Check existing purchase status"; payment and
 * fulfillment actions render only while the leg is `action_required`. Focus
 * moves to the current step's heading whenever the step changes and when the
 * user returns to this tab from the Peer extension or app.
 */

import { useEffect, useRef, useState } from "react";
import type { RampClient, RampSnapshot } from "@xochi/client";
import type { PeerOnrampRuntime } from "./onramp.js";

export interface OnrampStepsProps {
  runtime: PeerOnrampRuntime;
  client: RampClient;
  snapshot: RampSnapshot;
  onSnapshot: (next: RampSnapshot) => void;
  /** Lowercase wallet the operation is bound to. */
  wallet: string;
  /** Currently connected wallet; any other wallet cannot continue the operation. */
  connected?: string;
  /** Whether the wallet approval happened (false only for a failed pre-submission approve). */
  submitted: boolean;
  /** When Peer first reported the payout held (ISO); drives the release estimate. */
  heldSince?: string;
  /** Set when this view was rebuilt from local state after a reload or a lost runtime. */
  resumed?: boolean;
}

const HOLD_MS = 14 * 24 * 60 * 60 * 1000;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function stepTitle(snapshot: RampSnapshot, phase: string | undefined): string {
  const peer = snapshot.peer;
  if (peer.payout_state === "held") return "Payout held by Peer";
  if (peer.state === "completed") return "Purchase complete";
  if (peer.state === "in_doubt") return "Purchase status uncertain";
  if (peer.state === "failed") return "Purchase did not complete";
  if (peer.state === "action_required" && phase === "payment") return "Step 2: pay and capture";
  if (peer.state === "action_required" && phase === "finalize") return "Step 3: fulfill on Base";
  if (peer.state === "action_required" && phase === "capture") return "Step 2: capturing payment";
  return "Purchase in progress";
}

export function OnrampSteps({
  runtime,
  client,
  snapshot,
  onSnapshot,
  wallet,
  connected,
  submitted,
  heldSince,
  resumed,
}: OnrampStepsProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const id = snapshot.operation_id;
  const phase = runtime.phase(id);
  const rail = runtime.rail(id);
  const peer = snapshot.peer;
  const otherWallet = connected !== undefined && connected.toLowerCase() !== wallet;
  const title = stepTitle(snapshot, phase);

  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  useEffect(() => {
    // Returning from the Peer extension or app: restore focus to this step.
    const back = () => {
      if (document.visibilityState === "visible") heading.current?.focus();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNote("");
    try {
      await task();
    } catch {
      setNote("Peer could not validate this operation. Check the existing purchase status.");
    } finally {
      setBusy(false);
    }
  }
  const context = () => ({
    expected_revision: snapshot.revision,
    idempotency_key: crypto.randomUUID(),
  });
  const checkStatus = () =>
    void run(async () => {
      if (rail) await runtime.checkReadiness(rail);
      onSnapshot(await client.recover(id, "peer", "check_status", context()));
    });

  const recipient = runtime.paymentRecipient(id);
  const expiresAt = runtime.expiresAt(id);
  const release = heldSince ? new Date(Date.parse(heldSince) + HOLD_MS) : undefined;
  const canAct = !otherWallet && !busy;

  let status: string;
  if (peer.payout_state === "held")
    status = `Peer is holding this payout, for up to 14 days. ${
      release ? `Estimated release around ${release.toISOString().slice(0, 10)} (UTC); ` : ""
    }this is an estimate, not a guarantee. Base USDC is not yet confirmed in your wallet, and routing cannot start while it is held.`;
  else if (peer.state === "completed") status = "Confirmed Base USDC received.";
  else if (peer.state === "in_doubt")
    status =
      "Submission status is uncertain. Do not start another transfer and do not pay again. Check the existing purchase status to reconcile it.";
  else if (peer.state === "failed")
    status =
      peer.failure_code === "quote_expired" && !submitted
        ? "The quote expired before submission. No transfer was submitted."
        : peer.failure_code === "quote_expired"
          ? "The Peer intent expired before it was fulfilled. Fiat sent for an expired intent is not refundable by the protocol."
          : peer.recoverable
            ? "This purchase failed but can be recovered. Check its status or recover it; do not start another transfer."
            : submitted
              ? "This purchase did not complete."
              : "Purchase did not start. No transfer was submitted. Review a fresh quote after completing any required setup.";
  else status = `Peer purchase: ${peer.state.replaceAll("_", " ")}.`;

  return (
    <section className="onramp-steps" aria-label="Peer purchase progress">
      <h4 ref={heading} tabIndex={-1} className="onramp-steps__title">
        {title}
      </h4>
      {otherWallet && (
        <p role="alert">
          This purchase is bound to wallet {short(wallet)}. Reconnect that wallet to continue; a
          different wallet cannot continue it.
        </p>
      )}
      {peer.state === "action_required" && phase === "payment" && (
        <>
          {resumed && (
            <p>
              Resumed your existing purchase. If you already paid for it, do not pay again: open the
              Peer extension to capture that existing payment.
            </p>
          )}
          {recipient ? (
            <p>Pay only the reviewed amount to the selected Peer payment recipient: {recipient}.</p>
          ) : (
            <p>
              Peer did not return the payment instructions for this intent. Do not pay again; check
              its status, or open it in Peer.
            </p>
          )}
          {expiresAt !== undefined && (
            <p>
              Intent expires: {new Date(expiresAt).toISOString()}. Fiat for an expired or
              unverifiable intent is not refundable.
            </p>
          )}
          {recipient && (
            <button
              type="button"
              disabled={!canAct}
              onClick={() => {
                // authenticate must execute synchronously in this user gesture.
                if (!runtime.openFromGesture(id)) {
                  setNote("Check Peer readiness and intent expiry before opening the extension.");
                  return;
                }
                void run(async () => onSnapshot(await client.interact(id, {}, context())));
              }}
            >
              Open Peer extension to capture my payment
            </button>
          )}
        </>
      )}
      {peer.state === "action_required" && phase === "finalize" && (
        <button
          type="button"
          disabled={!canAct}
          onClick={() => void run(async () => onSnapshot(await client.interact(id, {}, context())))}
        >
          Approve wallet: verify payment and fulfill Peer intent
        </button>
      )}
      {(snapshot.allowed_actions.includes("check_status") ||
        (peer.state === "failed" && peer.recoverable)) && (
        <button type="button" disabled={!canAct} onClick={checkStatus}>
          Check existing purchase status
        </button>
      )}
      {snapshot.allowed_actions.includes("recover_peer") && (
        <button
          type="button"
          disabled={!canAct}
          onClick={() =>
            void run(async () =>
              onSnapshot(await client.recover(id, "peer", "recover_peer", context())),
            )
          }
        >
          Recover this purchase
        </button>
      )}
      <p role="status">{status}</p>
      {note && <p role="status">{note}</p>}
    </section>
  );
}
