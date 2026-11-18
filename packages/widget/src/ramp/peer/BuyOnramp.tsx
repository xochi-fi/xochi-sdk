import { useEffect, useRef, useState } from "react";
import type {
  RampIntent,
  RampOffer,
  RampOperationStore,
  RampPreview,
  RampSnapshot,
} from "@xochi/client";
import { formatUnits } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { createRampEmitter, emitSnapshot } from "../../lib/rampLifecycle.js";
import type { PeerOnrampRuntime, PeerSetupCode } from "./onramp.js";
import { OnrampSteps } from "./OnrampSteps.js";
import { OnrampRoute } from "../route/OnrampRoute.js";
import { browserRampStore, usePeerOnrampRuntime, useRampClient } from "./runtime.js";
import {
  abandonRampSummary,
  getRampSummary,
  markRampOperationLive,
  summaryFromSnapshot,
  upsertRampSummary,
  type RampOperationSummary,
} from "../recovery/summaries.js";

export const setupCopy: Record<PeerSetupCode, string> = {
  peer_desktop_extension_or_app:
    "Use desktop Chrome or Brave with the Peer extension, or the Peer app. Mobile web cannot start a purchase.",
  peer_extension_install: "Install the Peer extension before buying.",
  peer_extension_connection: "Connect the Peer extension to this origin before buying.",
  peer_extension_update:
    "Update the Peer extension to the version required by this payment platform.",
  peer_wallet_linked_session:
    "Peer requires a session linked to this wallet. Complete setup in Peer, then return for a new quote. This widget cannot sign you in to Peer.",
};
export interface BuyOnrampProps {
  intent: RampIntent;
  offer: RampOffer;
  wallet?: WalletClient;
  publicClient?: PublicClient;
  /** Trusted runtime injection for deterministic tests; never an embed parameter. */
  runtime?: PeerOnrampRuntime;
  /** S4 store injection for deterministic tests; defaults to browser-local storage. */
  store?: RampOperationStore;
  /** Currently connected wallet; the operation stays bound to the one that approved it. */
  connected?: string;
  onSubmit?: () => void;
  onReset?: () => void;
  makeEmitter?: typeof createRampEmitter;
}
const money = (value: RampPreview["pay"]) =>
  `${formatUnits(BigInt(value.atomic), value.asset.decimals)} ${value.asset.kind === "fiat" ? value.asset.currency : value.asset.symbol}`;

export function BuyOnramp({
  intent,
  offer,
  wallet,
  publicClient,
  runtime: supplied,
  store,
  connected,
  onSubmit,
  onReset,
  makeEmitter = createRampEmitter,
}: BuyOnrampProps) {
  const { runtime, pin } = usePeerOnrampRuntime({ supplied, wallet, publicClient });
  const [ownedStore] = useState(() => store ?? browserRampStore());
  const client = useRampClient(runtime, ownedStore);
  const [preview, setPreview] = useState<RampPreview>();
  const [snapshot, setSnapshot] = useState<RampSnapshot>();
  const [setup, setSetup] = useState<PeerSetupCode>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [clock, setClock] = useState(Date.now());
  const emitter = useRef<ReturnType<typeof createRampEmitter> | undefined>(undefined);
  const generation = useRef(0);
  const bound = JSON.stringify([intent, offer.offer_id, offer.capability_revision]);
  const submitted = snapshot !== undefined && !["quoted", "failed"].includes(snapshot.peer.state);
  const summary = useRef<RampOperationSummary | undefined>(undefined);
  function remember(next: RampOperationSummary) {
    summary.current = next;
    upsertRampSummary(next);
  }
  useEffect(() => {
    generation.current++;
    // A superseded review never crossed the wallet boundary; drop it from resume.
    const previous = summary.current;
    if (previous && !previous.submitted) abandonRampSummary(previous.operation_id);
    if (previous) markRampOperationLive(previous.operation_id, false);
    summary.current = undefined;
    setPreview(undefined);
    setSnapshot(undefined);
    setAccepted(false);
    setSetup(undefined);
    setNote("");
    setBusy(false);
    emitter.current = undefined;
    return () => {
      generation.current++;
    };
  }, [bound, client]);
  useEffect(
    () => () => {
      runtime?.dispose();
      // The in-memory provider state is gone: a remaining operation becomes resumable.
      if (summary.current) markRampOperationLive(summary.current.operation_id, false);
    },
    [runtime],
  );
  useEffect(() => {
    if (!preview || submitted) return;
    const timer = setTimeout(
      () => {
        setClock(Date.now());
        setAccepted(false);
        setNote("Quote expired. No transfer was submitted. Review a new quote before approving.");
      },
      Math.max(0, Date.parse(preview.expires_at) - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [preview, submitted]);
  async function run(task: () => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setNote("");
    try {
      await task();
    } catch {
      if (current === generation.current) {
        const code = runtime?.setupRequired();
        setSetup(code);
        setAccepted(false);
        // A named setup step is the whole story; the generic note would contradict it.
        setNote(
          code
            ? ""
            : "Peer could not validate this operation. Check status after a wallet submission; otherwise review a new quote.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function publish(next: RampSnapshot) {
    setSnapshot(next);
    const row = summary.current ?? getRampSummary(next.operation_id);
    if (row) remember(summaryFromSnapshot(row, next));
    emitSnapshot(emitter.current, next);
  }
  const context = () => ({
    expected_revision: snapshot!.revision,
    idempotency_key: crypto.randomUUID(),
  });
  const expired =
    preview !== undefined && Date.parse(preview.expires_at) <= Math.max(clock, Date.now());
  return (
    <section className="onramp-review" aria-label="Peer purchase review">
      {!runtime || !client ? (
        <p role="status">Connect your wallet on Base to review and approve a Peer purchase.</p>
      ) : (
        <>
          {setup && <p role="status">Setup required: {setupCopy[setup]}</p>}
          {setup === "peer_extension_install" && (
            <button type="button" onClick={() => runtime.installFromGesture()}>
              Install Peer extension
            </button>
          )}
          {setup === "peer_extension_connection" && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await runtime.connectFromGesture();
                  setSetup(await runtime.checkReadiness(offer.rail.id));
                })
              }
            >
              Connect Peer extension
            </button>
          )}
          {!submitted && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const current = generation.current;
                  const requirement = await runtime.checkReadiness(offer.rail.id);
                  if (current !== generation.current) return;
                  setSetup(requirement);
                  if (requirement) return;
                  const quote = await client.preview(
                    intent,
                    offer.offer_id,
                    offer.capability_revision,
                  );
                  if (current !== generation.current) return;
                  const previous = summary.current;
                  if (previous && !previous.submitted) abandonRampSummary(previous.operation_id);
                  const now = new Date().toISOString();
                  markRampOperationLive(quote.operation_id);
                  remember({
                    operation_id: quote.operation_id,
                    direction: "onramp",
                    wallet: intent.recipient.toLowerCase(),
                    rail: { id: offer.rail.id, label: offer.rail.label },
                    pay: quote.pay,
                    receive: quote.receive,
                    quote_expires_at: quote.expires_at,
                    submitted: false,
                    state: "quoted",
                    terminal: false,
                    created_at: now,
                    updated_at: now,
                  });
                  setPreview(quote);
                  setSnapshot(await client.get(quote.operation_id));
                  setAccepted(false);
                  setClock(Date.now());
                })
              }
            >
              {preview ? "Review new quote" : "Review exact Peer quote"}
            </button>
          )}
          {preview && (
            <>
              <dl>
                <dt>Provider / payment app</dt>
                <dd>Peer / {offer.rail.label}</dd>
                <dt>Pay exactly</dt>
                <dd>{money(preview.pay)}</dd>
                <dt>Receive</dt>
                <dd>{money(preview.receive)} on Base</dd>
                <dt>Fees</dt>
                <dd>
                  {preview.fees.map((fee) => `${fee.code}: ${money(fee.money)}`).join("; ") ||
                    "None"}
                </dd>
                <dt>Quote expires</dt>
                <dd>{preview.expires_at}</dd>
                <dt>Recipient wallet</dt>
                <dd>{intent.recipient}</dd>
                <dt>Required interaction</dt>
                <dd>
                  Approve the Base intent in your wallet, pay from your own payment account, capture
                  Buyer TEE evidence in the Peer extension, then approve fulfillment in your wallet.
                </dd>
              </dl>
              <p>
                Fiat sent for an expired or unverifiable intent is not refundable by the protocol.
                Check the active intent before paying.
              </p>
              <p>
                Base settlement is public. The payment counterparty and Peer see required identity
                and payment data. Completion depends on Peer, its TEE and Base.
              </p>
              <p>
                Venmo and PayPal can hold payouts for 14 days without sufficient stake. Held funds
                are not confirmed Base USDC and cannot start routing.
              </p>
              {!submitted && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={expired || busy}
                      onChange={(event) => setAccepted(event.target.checked)}
                    />
                    I reviewed the exact quote and all disclosures above.
                  </label>
                  <button
                    type="button"
                    disabled={busy || expired || !accepted || !snapshot}
                    onClick={() =>
                      void run(async () => {
                        pin();
                        onSubmit?.();
                        // Persist uncertainty BEFORE the wallet boundary: a reload
                        // mid-approval resumes in doubt and never signals again.
                        const approvedAt = new Date().toISOString();
                        emitter.current = makeEmitter("onramp");
                        if (summary.current)
                          remember({
                            ...summary.current,
                            submitted: true,
                            state: "in_doubt",
                            approved_at: approvedAt,
                            ramp_ref: emitter.current.rampRef,
                            updated_at: approvedAt,
                          });
                        const next = await client.approve(
                          preview.operation_id,
                          preview.quote_id,
                          [
                            ...preview.disclosures.public_state,
                            ...preview.disclosures.identity_visible_to,
                            ...preview.disclosures.liveness_dependencies,
                          ],
                          context(),
                        );
                        publish(next);
                        // A setup refusal happens before any wallet prompt.
                        if (
                          next.peer.state === "failed" &&
                          runtime.setupRequired() &&
                          summary.current
                        )
                          remember({ ...summary.current, submitted: false });
                        setSetup(runtime.setupRequired());
                        setAccepted(false);
                      })
                    }
                  >
                    Approve wallet: signal Peer purchase on Base
                  </button>
                </>
              )}
            </>
          )}
          {snapshot && (submitted || (summary.current?.submitted && snapshot.terminal)) && (
            <OnrampSteps
              runtime={runtime}
              client={client}
              snapshot={snapshot}
              onSnapshot={publish}
              wallet={intent.recipient.toLowerCase()}
              connected={connected}
              submitted={summary.current?.submitted ?? true}
              heldSince={summary.current?.held_since}
            />
          )}
          {snapshot?.peer.state === "completed" &&
            snapshot.peer.payout_state !== "held" &&
            runtime &&
            preview && (
              <OnrampRoute
                snapshot={snapshot}
                onSnapshot={publish}
                store={ownedStore}
                peer={runtime.provider}
                received={preview.receive}
                wallet={intent.recipient}
              />
            )}
          {snapshot?.peer.state === "failed" && !summary.current?.submitted && (
            <p role="status">
              Purchase did not start. No transfer was submitted. Review a fresh quote after
              completing any required setup.
            </p>
          )}
          {snapshot?.terminal && onReset && (
            <button type="button" onClick={onReset}>
              Choose a new purchase
            </button>
          )}
          {note && <p role="status">{note}</p>}
        </>
      )}
    </section>
  );
}
