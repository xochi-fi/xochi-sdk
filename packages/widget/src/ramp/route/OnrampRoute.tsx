import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { WagmiContext, useAccount, useConfig } from "wagmi";
import { formatUnits } from "viem";
import {
  createRampClient,
  createXochiRampLeg,
  isChainId,
  stealthDestinationChains,
  type RampAction,
  type RampMoney,
  type RampOperationStore,
  type RampProvider,
  type RampSnapshot,
} from "@xochi/client";
import { STEALTH_PRIVACY_LIMITS } from "../../pages/trade/settlementCopy.js";
import { useClaimInXochiApp, CLAIM_IN_XOCHI_APP } from "../../components/widgetTabsContext.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { useStealth } from "../../hooks/useStealth.js";
import { useIntent } from "../../hooks/useIntent.js";
import { findTokenBySymbol, STEALTH_SETTLEMENT_LIVE } from "../../pages/trade/config.js";
import { parseStealthMetaAddress } from "../../pages/send/stealthRecipient.js";
import { chainName } from "../../pages/send/addressSend.js";
import { useEmbedDefaults } from "../../pages/trade/useEmbedDefaults.js";
import { policyHolds } from "../../pages/trade/embedParams.js";
import { findOnrampRoute } from "./routeActivity.js";
import { RampRouteSteps } from "./RampRouteSteps.js";
import { routeMachineStatus, useXochiRampDriver } from "./useXochiRampDriver.js";

/** Mounted only for confirmed, released Peer USDC; it never sends Peer facts to the solver. */
interface OnrampRouteProps {
  snapshot: RampSnapshot;
  onSnapshot(snapshot: RampSnapshot): void;
  store: RampOperationStore;
  peer: RampProvider;
  received: RampMoney;
  wallet: string;
}
export function OnrampRoute(props: OnrampRouteProps) {
  const config = useContext(WagmiContext);
  if (!config)
    return (
      <RampRouteSteps {...props} disabled onAction={() => {}}>
        <p>Connect the receiving wallet on Base to review an optional Xochi route.</p>
      </RampRouteSteps>
    );
  return <ConnectedOnrampRoute {...props} />;
}
function ConnectedOnrampRoute({
  snapshot,
  onSnapshot,
  store,
  peer,
  received,
  wallet,
}: OnrampRouteProps) {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { capabilities, state } = useCapabilities();
  const stealth = useStealth();
  const claimInApp = useClaimInXochiApp();
  const embed = useEmbedDefaults();
  const [restored] = useState(() => findOnrampRoute(wallet, snapshot.operation_id, received));
  const [targetKey, setTargetKey] = useState(
    restored ? `${restored.data.toChainId}:${restored.data.toToken}` : "",
  );
  const [settlement, setSettlement] = useState<"public" | "stealth">(
    restored?.data.settlementType === "stealth" ? "stealth" : "public",
  );
  const [recipientKind, setRecipientKind] = useState<"own" | "other">(
    restored?.data.stealthPayee === "other" ? "other" : "own",
  );
  const [metaInput, setMetaInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const lock = useRef(false);
  const bound = address?.toLowerCase() === wallet.toLowerCase() && chainId === 8453;
  const trustedStealth = stealthDestinationChains(capabilities);
  const opened = embed.settled ?? embed.seed;
  const targets = useMemo(() => {
    if (state !== "live") return [];
    const seen = new Set<string>();
    return (capabilities.routes ?? []).flatMap((route) => {
      const { origin, destination } = route;
      if (
        origin.chainId !== 8453 ||
        origin.token !== "USDC" ||
        destination.kind !== "chain" ||
        !isChainId(destination.chainId) ||
        !config.chains.some((c) => c.id === destination.chainId)
      )
        return [];
      const token = findTokenBySymbol(destination.chainId, destination.token);
      if (
        !token ||
        !policyHolds(
          opened,
          {
            fromChainId: 8453,
            fromSymbol: "USDC",
            toChainId: destination.chainId,
            toSymbol: token.symbol,
          },
          formatUnits(BigInt(received.atomic), received.asset.decimals),
        )
      )
        return [];
      const key = `${destination.chainId}:${token.address}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, chainId: destination.chainId, token, privacyModes: route.privacyModes }];
    });
  }, [capabilities, state, config.chains, opened, received]);
  const target = targets.find((t) => t.key === targetKey) ?? targets[0];
  const checked = parseStealthMetaAddress(metaInput);
  const meta =
    recipientKind === "other" ? (checked.ok ? checked.recipient : null) : stealth.metaAddress;
  const recipient =
    settlement === "public"
      ? wallet
      : recipientKind === "other"
        ? checked.ok
          ? checked.recipient.encoded
          : ""
        : (stealth.encodedMetaAddress ?? "");
  const authorized =
    bound &&
    snapshot.peer.state === "completed" &&
    snapshot.peer.payout_state !== "held" &&
    state === "live" &&
    !!target &&
    target.privacyModes.includes(settlement) &&
    (settlement === "public" ||
      (STEALTH_SETTLEMENT_LIVE && trustedStealth.includes(target.chainId) && !!meta));
  const source = findTokenBySymbol(8453, "USDC")!;
  const asset = target
    ? {
        kind: "crypto" as const,
        chain_id: `eip155:${target.chainId}`,
        asset_id: target.token.address,
        symbol: target.token.symbol,
        decimals: target.token.decimals,
      }
    : received.asset;
  const intent = useIntent({
    fromChainId: 8453,
    toChainId: target?.chainId ?? 8453,
    fromToken: source.address,
    toToken: target?.token.address ?? source.address,
    settlementPreference: settlement,
    settlementAuthorized: authorized,
    stealthMetaAddress:
      settlement === "stealth" && meta && target
        ? {
            spendingPubKey: meta.spendingPubKey,
            viewingPubKey: meta.viewingPubKey,
            chainId: target.chainId,
          }
        : undefined,
    paused: true,
    manualQuoteRefresh: true,
    ref: embed.codes.ref ?? undefined,
    promo: embed.codes.promo ?? undefined,
  });
  const driver = useXochiRampDriver({
    intent,
    pay: received,
    receiveAsset: asset,
    recipient,
    settlement,
    authorized,
    operationId: snapshot.operation_id,
    wallet,
    payee: recipientKind,
    routeState: snapshot.xochi?.state,
  });
  const funding = useMemo(() => received, [received.atomic, JSON.stringify(received.asset)]);
  const leg = useMemo(
    () => createXochiRampLeg({ store, driver, delivered: funding }),
    [store, driver, funding],
  );
  const client = useMemo(
    () => createRampClient({ peer, xochi: leg, store, commandTimeoutMs: 180_000 }),
    [peer, leg, store],
  );
  const held = leg.preview(snapshot.operation_id);
  const preview =
    held?.receive.asset.kind === "crypto" &&
    held.receive.asset.asset_id === (asset.kind === "crypto" ? asset.asset_id : undefined) &&
    held.receive.asset.chain_id === (asset.kind === "crypto" ? asset.chain_id : undefined) &&
    held?.recipient === recipient &&
    held.settlement === settlement
      ? held
      : undefined;
  const active =
    snapshot.xochi &&
    ["processing", "in_doubt", "completed", "skipped"].includes(snapshot.xochi.state);
  async function act(action: RampAction) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNote("");
    try {
      const context = (s: RampSnapshot) => ({
        expected_revision: s.revision,
        idempotency_key: crypto.randomUUID(),
      });
      const current = snapshot.xochi
        ? snapshot
        : await client.offerRoute(snapshot.operation_id, context(snapshot));
      onSnapshot(current);
      const next = await client.recover(current.operation_id, "xochi", action, context(current));
      onSnapshot(next);
    } catch {
      setNote(
        "The Xochi route could not be validated. Peer remains completed. Check route status after any wallet approval; do not start another transfer.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (busy || !snapshot.xochi || !["processing", "in_doubt"].includes(snapshot.xochi.state))
      return;
    const status = routeMachineStatus(intent);
    if (status.state === snapshot.xochi.state || !["completed", "failed"].includes(status.state))
      return;
    void act("check_status");
  }, [busy, snapshot, intent.status, intent.receipt.phase]);
  return (
    <>
      <RampRouteSteps
        snapshot={snapshot}
        preview={preview}
        wallet={wallet}
        received={received}
        busy={busy}
        quoteDisabled={!authorized}
        completedNote={
          settlement === "stealth"
            ? recipientKind === "other"
              ? "The recipient claims this Stealth payment with their own keys. The sending wallet cannot claim it."
              : claimInApp
                ? CLAIM_IN_XOCHI_APP
                : "Find this Stealth payment in Claims with the receiving wallet."
            : undefined
        }
        onAction={(action) => void act(action)}
      >
        {!active && (
          <fieldset disabled={busy} className="ramp-route__fields">
            <legend>Optional destination</legend>
            <label>
              Receive asset and network
              <select value={target?.key ?? ""} onChange={(e) => setTargetKey(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.token.symbol} on {chainName(t.chainId)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Settlement
              <select
                value={settlement}
                onChange={(e) => {
                  setSettlement(e.target.value as "public" | "stealth");
                  setMetaInput("");
                  setRecipientKind("own");
                }}
              >
                <option value="public">Public (my wallet)</option>
                <option value="stealth">Stealth recipient</option>
              </select>
            </label>
            {settlement === "stealth" && (
              <>
                <p>{STEALTH_PRIVACY_LIMITS}</p>
                <label>
                  Stealth recipient
                  <select
                    value={recipientKind}
                    onChange={(e) => setRecipientKind(e.target.value as "own" | "other")}
                  >
                    <option value="own">My Stealth keys</option>
                    <option value="other">Another person's meta-address</option>
                  </select>
                </label>
                {recipientKind === "other" ? (
                  <label>
                    Recipient's Stealth meta-address
                    <input
                      value={metaInput}
                      onChange={(e) => setMetaInput(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {!checked.ok && <span>{checked.error}</span>}
                  </label>
                ) : (
                  !meta && (
                    <button
                      type="button"
                      disabled={stealth.isLoading || !bound}
                      onClick={() => void stealth.initializeKeys()}
                    >
                      Set up my Stealth keys
                    </button>
                  )
                )}
              </>
            )}
            {!authorized && (
              <p role="status">
                {!bound
                  ? "Reconnect the receiving wallet on Base to route."
                  : "Choose a live supported route and complete any Stealth recipient setup before requesting a quote."}
              </p>
            )}
          </fieldset>
        )}
      </RampRouteSteps>
      {intent.awaitingPull && (
        <button type="button" disabled={intent.isSigningPull} onClick={intent.signPull}>
          Authorize
        </button>
      )}
      {note && <p role="status">{note}</p>}
    </>
  );
}
