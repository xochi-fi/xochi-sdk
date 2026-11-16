/**
 * ResumeOnramp
 *
 * Shown by Trade/Buy when a sanitized local summary names a Peer onramp that no
 * live runtime owns: after a reload, or after the purchase view unmounted. It
 * resumes that operation by its widget-minted `operation_id` and never creates
 * another intent or payment action:
 *
 *  - unsubmitted: the reviewed quote is gone, so it says no transfer was
 *    submitted and offers only explicit abandonment;
 *  - bound to another wallet: it names the original wallet; only an unsubmitted
 *    flow may be abandoned from here;
 *  - submitted: it rebinds the provider runtime with read-only lookups, runs one
 *    status reconciliation, and continues in the shared OnrampSteps view.
 */

import { useEffect, useState } from "react";
import type { RampOperationStore, RampSnapshot } from "@xochi/client";
import type { PublicClient, WalletClient } from "viem";
import type { PeerOnrampRuntime } from "../peer/onramp.js";
import { OnrampSteps } from "../peer/OnrampSteps.js";
import { OnrampRoute } from "../route/OnrampRoute.js";
import { browserRampStore, usePeerOnrampRuntime, useRampClient } from "../peer/runtime.js";
import {
  abandonRampSummary,
  summaryFromSnapshot,
  upsertRampSummary,
  type RampOperationSummary,
} from "./summaries.js";
import { formatUnits } from "viem";

export interface ResumeOnrampProps {
  summary: RampOperationSummary;
  /** Connected wallet; undefined while disconnected. */
  connected?: string;
  wallet?: WalletClient;
  publicClient?: PublicClient;
  /** Trusted runtime injection for deterministic tests; never an embed parameter. */
  runtime?: PeerOnrampRuntime;
  /** S4 store injection for deterministic tests; defaults to browser-local storage. */
  store?: RampOperationStore;
  now?: () => number;
  /** Leave a settled resumed purchase and return to choosing a rail. */
  onDone?: () => void;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (value: RampOperationSummary["pay"]) =>
  `${formatUnits(BigInt(value.atomic), value.asset.decimals)} ${value.asset.kind === "fiat" ? value.asset.currency : value.asset.symbol}`;

export function ResumeOnramp({
  summary,
  connected,
  wallet,
  publicClient,
  runtime: supplied,
  store,
  now = Date.now,
  onDone,
}: ResumeOnrampProps) {
  const bound = connected?.toLowerCase() === summary.wallet;
  const { runtime } = usePeerOnrampRuntime({
    supplied,
    wallet: bound ? wallet : undefined,
    publicClient,
  });
  const [ownedStore] = useState(() => store ?? browserRampStore());
  const client = useRampClient(bound && summary.submitted ? runtime : undefined, ownedStore);
  const [snapshot, setSnapshot] = useState<RampSnapshot>();
  const [failed, setFailed] = useState(false);
  const id = summary.operation_id;

  useEffect(() => {
    if (!client || !runtime) return;
    let live = true;
    void (async () => {
      try {
        await runtime.resume(id, {
          wallet: summary.wallet,
          rail: summary.rail.id,
          pay: summary.pay,
          receive: summary.receive,
          quoteExpiresAt: summary.quote_expires_at,
          approvedAfter: Date.parse(summary.approved_at ?? summary.created_at),
        });
        // Fresh extension readiness for this rail, as before any capture.
        await runtime.checkReadiness(summary.rail.id);
        let current = await client.get(id);
        if (!current.terminal && current.allowed_actions.includes("check_status"))
          current = await client.recover(id, "peer", "check_status", {
            expected_revision: current.revision,
            idempotency_key: crypto.randomUUID(),
          });
        if (!live) return;
        setSnapshot(current);
        upsertRampSummary(summaryFromSnapshot(summary, current));
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
    // Resume once per operation and runtime; summary updates must not re-run it.
  }, [client, runtime, id]);
  useEffect(() => () => runtime?.dispose(), [runtime]);

  const facts = (
    <p>
      Buy {money(summary.receive)} for {money(summary.pay)} with Peer / {summary.rail.label}.
    </p>
  );
  const abandon = (
    <button type="button" onClick={() => abandonRampSummary(id)}>
      Abandon this unsubmitted purchase
    </button>
  );

  if (!bound)
    return (
      <section className="onramp-resume" aria-label="Purchase waiting for another wallet">
        <h3 className="send-review__title">Purchase waiting for another wallet</h3>
        {facts}
        <p role="alert">
          This purchase is bound to wallet {short(summary.wallet)}. Reconnect that wallet to
          continue it; {connected ? "the connected wallet" : "another wallet"} cannot.
        </p>
        {summary.submitted ? (
          summary.state === "in_doubt" && (
            <p>Its submission status is uncertain. Do not start another transfer for it.</p>
          )
        ) : (
          <>
            <p>No transfer was submitted for it.</p>
            {abandon}
          </>
        )}
      </section>
    );

  if (!summary.submitted) {
    const expired = Date.parse(summary.quote_expires_at) <= now();
    return (
      <section className="onramp-resume" aria-label="Unsubmitted purchase">
        <h3 className="send-review__title">
          {expired ? "Quote expired before submission" : "Quote not submitted"}
        </h3>
        {facts}
        <p role="status">
          {expired
            ? "The quote expired before submission. No transfer was submitted."
            : "This reviewed quote was not submitted. No transfer was submitted."}{" "}
          Review a new quote to buy.
        </p>
        <button type="button" onClick={() => abandonRampSummary(id)}>
          Dismiss and review a new quote
        </button>
      </section>
    );
  }

  return (
    <section className="onramp-resume" aria-label="Resumed purchase">
      <h3 className="send-review__title">Resume your Peer purchase</h3>
      {facts}
      <p>Finish or reconcile this purchase before starting another.</p>
      {!runtime || !client ? (
        <p role="status">Connect wallet {short(summary.wallet)} on Base to resume this purchase.</p>
      ) : snapshot ? (
        <OnrampSteps
          runtime={runtime}
          client={client}
          snapshot={snapshot}
          onSnapshot={(next) => {
            setSnapshot(next);
            upsertRampSummary(summaryFromSnapshot(summary, next));
          }}
          wallet={summary.wallet}
          connected={connected}
          submitted={summary.submitted}
          heldSince={summary.held_since}
          resumed
        />
      ) : failed ? (
        <p role="status">
          This purchase could not be loaded from this browser. Do not start another transfer; check
          it in Peer.
        </p>
      ) : (
        <p role="status">Resuming your existing purchase…</p>
      )}
      {snapshot?.peer.state === "completed" && snapshot.peer.payout_state !== "held" && runtime && (
        <OnrampRoute
          snapshot={snapshot}
          onSnapshot={(next) => {
            setSnapshot(next);
            upsertRampSummary(summaryFromSnapshot(summary, next));
          }}
          store={ownedStore}
          peer={runtime.provider}
          received={summary.receive}
          wallet={summary.wallet}
        />
      )}
      {snapshot?.terminal && onDone && (
        <button type="button" onClick={onDone}>
          Choose a new purchase
        </button>
      )}
    </section>
  );
}
