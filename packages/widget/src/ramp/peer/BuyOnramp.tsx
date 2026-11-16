import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBrowserRampOperationStore,
  createMemoryRampOperationStore,
  createRampClient,
  type RampIntent,
  type RampOffer,
  type RampPreview,
  type RampSnapshot,
} from "@xochi/client";
import { createPeerExtensionSdk } from "@zkp2p/sdk";
import { formatUnits } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { createRampEmitter } from "../../lib/rampLifecycle.js";
import { createPeerBuyerDriver } from "./buyerDriver.js";
import { createPeerOnrampProvider, type PeerOnrampRuntime, type PeerSetupCode } from "./onramp.js";

const setupCopy: Record<PeerSetupCode, string> = {
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
  onSubmit,
  onReset,
  makeEmitter = createRampEmitter,
}: BuyOnrampProps) {
  const pinned = useRef<PeerOnrampRuntime | undefined>(undefined);
  const runtime = useMemo(() => {
    if (pinned.current) return pinned.current;
    if (supplied) return supplied;
    if (!wallet?.account || !publicClient) return;
    try {
      return createPeerOnrampProvider({
        user: wallet.account.address,
        extension: createPeerExtensionSdk(),
        driver: createPeerBuyerDriver({ wallet, publicClient }),
      });
    } catch {
      return;
    }
  }, [supplied, wallet, publicClient]);
  const client = useMemo(() => {
    if (!runtime) return;
    let store = createMemoryRampOperationStore();
    try {
      if (navigator.locks && window.localStorage)
        store = createBrowserRampOperationStore({
          storage: window.localStorage,
          locks: navigator.locks,
        });
    } catch {
      /* In-memory summaries are safe when browser storage is disabled. */
    }
    return createRampClient({ peer: runtime.provider, store, commandTimeoutMs: 180_000 });
  }, [runtime]);
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
  useEffect(() => {
    generation.current++;
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
  useEffect(() => () => runtime?.dispose(), [runtime]);
  useEffect(() => {
    if (!preview || submitted) return;
    const timer = setTimeout(
      () => {
        setClock(Date.now());
        setAccepted(false);
        setNote("Quote expired. Review a new quote before approving.");
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
        setSetup(runtime?.setupRequired());
        setAccepted(false);
        setNote(
          "Peer could not validate this operation. Check status after a wallet submission; otherwise review a new quote.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function publish(next: RampSnapshot) {
    setSnapshot(next);
    emitter.current?.status(next.peer.state);
    if (next.peer.state === "in_doubt") emitter.current?.recoveryRequired("peer", "peer_in_doubt");
    if (next.terminal) emitter.current?.terminal(next.peer.state);
  }
  const context = () => ({
    expected_revision: snapshot!.revision,
    idempotency_key: crypto.randomUUID(),
  });
  const expired =
    preview !== undefined && Date.parse(preview.expires_at) <= Math.max(clock, Date.now());
  const phase = snapshot && runtime ? runtime.phase(snapshot.operation_id) : "review";
  return (
    <section aria-label="Peer purchase review">
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
                        pinned.current = runtime;
                        onSubmit?.();
                        emitter.current = makeEmitter("onramp");
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
          {snapshot && (
            <>
              {phase === "payment" && (
                <>
                  <p>
                    Pay only the reviewed amount to the selected Peer payment recipient:{" "}
                    {runtime.paymentRecipient(snapshot.operation_id)}.
                  </p>
                  <p>
                    Intent expires:{" "}
                    {new Date(runtime.expiresAt(snapshot.operation_id)!).toISOString()}. Fiat for an
                    expired or unverifiable intent is not refundable.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // authenticate must execute synchronously in this user gesture.
                      if (!runtime.openFromGesture(snapshot.operation_id)) {
                        setNote(
                          "Check Peer readiness and intent expiry before opening the extension.",
                        );
                        return;
                      }
                      void run(async () =>
                        publish(await client.interact(snapshot.operation_id, {}, context())),
                      );
                    }}
                  >
                    Open Peer extension to capture my payment
                  </button>
                </>
              )}
              {phase === "finalize" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      publish(await client.interact(snapshot.operation_id, {}, context())),
                    )
                  }
                >
                  Approve wallet: verify payment and fulfill Peer intent
                </button>
              )}
              {(snapshot.peer.state === "processing" ||
                snapshot.peer.state === "in_doubt" ||
                phase === "payment") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await runtime.checkReadiness(offer.rail.id);
                      publish(
                        await client.recover(
                          snapshot.operation_id,
                          "peer",
                          "check_status",
                          context(),
                        ),
                      );
                    })
                  }
                >
                  Check existing purchase status
                </button>
              )}
              <p role="status">
                {snapshot.peer.payout_state === "held"
                  ? "Payout held by Peer for up to 14 days. Base USDC is not yet confirmed in your wallet."
                  : snapshot.peer.state === "completed"
                    ? "Confirmed Base USDC received."
                    : snapshot.peer.state === "in_doubt"
                      ? "Submission status is uncertain. Check the existing purchase; do not pay or submit again."
                      : snapshot.peer.state === "failed"
                        ? "Purchase did not start. Review a fresh quote after completing any required setup."
                        : `Peer purchase: ${snapshot.peer.state.replaceAll("_", " ")}.`}
              </p>
            </>
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
