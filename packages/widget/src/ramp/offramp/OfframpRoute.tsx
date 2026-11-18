import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { atomic, isChainId, type RampMoney } from "@xochi/client";
import { formatUnits, parseUnits } from "viem";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { useIntent } from "../../hooks/useIntent.js";
import { findTokenBySymbol } from "../../pages/trade/config.js";
import { policyHolds } from "../../pages/trade/embedParams.js";
import { useEmbedDefaults } from "../../pages/trade/useEmbedDefaults.js";
import { chainName } from "../../pages/send/addressSend.js";
import { useXochiRampDriver } from "../route/useXochiRampDriver.js";
import { OfframpRouteReview } from "./OfframpRouteReview.js";
import {
  createOfframpPrerequisite,
  inspectOfframpPrerequisite,
  type OfframpPrerequisite,
} from "./prerequisite.js";
import type { OfframpPort } from "./port.js";

export function OfframpRoute({
  port,
  onReady,
  onLock,
  onReceipt,
}: {
  port: OfframpPort;
  onLock(): void;
  onReceipt?(route: OfframpPrerequisite): void;
  onReady(route: OfframpPrerequisite, amount: string): void;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const { capabilities, state } = useCapabilities();
  const embed = useEmbedDefaults();
  const [checkpoint] = useState(() => (address ? inspectOfframpPrerequisite(address) : undefined));
  const restoredAsset = checkpoint?.source.asset;
  const [key, setKey] = useState(
    restoredAsset?.kind === "crypto"
      ? `${restoredAsset.chain_id.slice(7)}:${restoredAsset.asset_id}`
      : "",
  );
  const [text, setText] = useState(() =>
    checkpoint
      ? formatUnits(BigInt(checkpoint.source.atomic), checkpoint.source.asset.decimals)
      : "",
  );
  const [route, setRoute] = useState<OfframpPrerequisite>();
  const [, render] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const lock = useRef(false);
  const [id] = useState(() => checkpoint?.snapshot.operation_id ?? crypto.randomUUID());
  const sources = useMemo(
    () =>
      state !== "live"
        ? []
        : (capabilities.routes ?? [])
            .flatMap(({ origin, destination, privacyModes }) => {
              if (
                destination.kind !== "chain" ||
                destination.chainId !== 8453 ||
                destination.token !== "USDC" ||
                !isChainId(origin.chainId) ||
                !config.chains.some((c) => c.id === origin.chainId) ||
                !privacyModes.includes("public")
              )
                return [];
              const token = findTokenBySymbol(origin.chainId, origin.token);
              if (!token || (origin.chainId === 8453 && token.symbol === "USDC")) return [];
              return [
                { key: `${origin.chainId}:${token.address}`, chainId: origin.chainId, token },
              ];
            })
            .filter((s, i, all) => all.findIndex((t) => t.key === s.key) === i),
    [state, capabilities, config.chains],
  );
  const source = sources.find((s) => s.key === key) ?? sources[0];
  let amount: string | undefined;
  try {
    if (
      source &&
      /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) &&
      (text.split(".")[1]?.length ?? 0) <= source.token.decimals
    ) {
      const n = parseUnits(text, source.token.decimals);
      if (n > 0n) amount = n.toString();
    }
  } catch {
    /* Invalid input stays non-executable. */
  }
  const base = findTokenBySymbol(8453, "USDC")!;
  const pay: RampMoney = checkpoint?.source ?? {
    asset: {
      kind: "crypto",
      chain_id: `eip155:${source?.chainId ?? 8453}`,
      asset_id: source?.token.address ?? base.address,
      symbol: source?.token.symbol ?? "USDC",
      decimals: source?.token.decimals ?? 6,
    },
    atomic: atomic(amount ?? "0"),
  };
  const receive = {
    kind: "crypto" as const,
    chain_id: "eip155:8453",
    asset_id: base.address,
    symbol: "USDC",
    decimals: 6,
  };
  const authorized =
    checkpoint !== null &&
    !!address &&
    !!source &&
    !!amount &&
    (!checkpoint || source.key === key) &&
    state === "live" &&
    policyHolds(
      embed.settled ?? embed.seed,
      {
        fromChainId: source.chainId,
        fromSymbol: source.token.symbol,
        toChainId: 8453,
        toSymbol: "USDC",
      },
      text,
    );
  const intent = useIntent({
    fromChainId: source?.chainId ?? 8453,
    toChainId: 8453,
    fromToken: source?.token.address ?? base.address,
    toToken: base.address,
    settlementPreference: "public",
    settlementAuthorized: authorized,
    paused: true,
    manualQuoteRefresh: true,
    ref: embed.codes.ref ?? undefined,
    promo: embed.codes.promo ?? undefined,
  });
  const driver = useXochiRampDriver({
    intent,
    pay,
    receiveAsset: receive,
    recipient: address ?? "",
    settlement: "public",
    authorized,
    operationId: id,
    wallet: address ?? "",
    payee: "own",
    requireDurableCorrelation: true,
    routeState: (route?.snapshot() ?? checkpoint?.snapshot)?.xochi?.state,
  });
  useEffect(() => {
    if (checkpoint) void act("check");
  }, [checkpoint, intent.receipt.phase, intent.status]);
  async function act(action: "quote" | "execute" | "check" | "balance") {
    if (lock.current || !address) return;
    lock.current = true;
    setBusy(true);
    setNote("");
    try {
      const current =
        route ??
        createOfframpPrerequisite({
          source: pay,
          driver,
          wallet: address,
          spendable: async (wallet) => {
            if (!port.spendable) throw new Error("balance_unavailable");
            return port.spendable(wallet);
          },
          id,
        });
      onLock();
      setRoute(current);
      if (action !== "balance") await current.act(action);
      const quote = current.preview();
      if (current.snapshot().xochi?.state === "completed" && quote) {
        onReceipt?.(current);
        if (await current.funded(quote.receive.atomic)) onReady(current, quote.receive.atomic);
        else
          setNote(
            "Route confirmed; spendable Base USDC has not been confirmed in your wallet. Peer remains blocked. Check the balance again.",
          );
      }
      render((n) => n + 1);
    } catch {
      setNote(
        "The route could not be checked. After wallet approval, check Xochi Activity before starting another transfer.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const snapshot = route?.snapshot() ?? checkpoint?.snapshot;
  const status = snapshot?.xochi?.state ?? "not_started";
  const preview = route?.preview() ?? checkpoint?.preview;
  return (
    <OfframpRouteReview
      status={status}
      preview={preview}
      receipt={snapshot?.xochi?.transaction_hash ?? id}
      busy={busy}
      authorized={authorized}
      onAction={(action) => void act(action)}
      note={checkpoint === null ? "Route recovery storage is unavailable." : note}
    >
      <fieldset
        disabled={!!checkpoint || !!route || busy}
        className="send-form offramp-route-fields"
      >
        <label className="send-field">
          <span className="send-field__label">Source asset</span>
          <select
            className="send-field__control"
            value={source?.key ?? ""}
            onChange={(e) => setKey(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.token.symbol} on {chainName(s.chainId)}
              </option>
            ))}
          </select>
        </label>
        <label className="send-field">
          <span className="send-field__label">Source amount</span>
          <input
            className="send-field__control"
            value={text}
            inputMode="decimal"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </fieldset>
      {!source && (
        <p className="send-note" role="status">
          No live supported route into Base USDC is available.
        </p>
      )}
      {intent.awaitingPull && (
        <button
          type="button"
          className="send-secondary"
          disabled={intent.isSigningPull}
          onClick={intent.signPull}
        >
          Approve wallet: sign source authorization
        </button>
      )}
    </OfframpRouteReview>
  );
}
