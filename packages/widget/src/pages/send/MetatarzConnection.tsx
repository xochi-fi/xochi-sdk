import { useEffect, useRef, useState } from "react";
import {
  METATARZ_INSTALL,
  metatarzProvider,
  metatarzStandaloneUrl,
  readMetatarzSession,
  type MetatarzSession,
} from "./metatarz.js";

type View =
  | MetatarzSession
  | { kind: "ready" | "missing" | "isolated" | "checking" | "pending" | "rejected" | "failed" };

function connectionMessage(view: View): string {
  switch (view.kind) {
    case "ready":
      return "Select Canton TestNet in Metatarz Wallet, activate a Canton party, then connect.";
    case "missing":
      return "Metatarz Wallet’s Canton provider is unavailable here. Install or update the extension and reload.";
    case "isolated":
      return "This embed cannot connect to Metatarz Wallet. Open Send in a new tab to connect.";
    case "pending":
      return "Check Metatarz Wallet for a connection request.";
    case "checking":
      return "Checking the active Metatarz network and party.";
    case "disconnected":
      return view.reason?.startsWith("No Canton account")
        ? "Activate a Canton TestNet party in Metatarz Wallet, then reconnect."
        : "This site is disconnected. Unlock Metatarz Wallet and connect.";
    case "unreachable":
      return "Metatarz Wallet could not reach Canton. Check the selected network and retry.";
    case "wrong-network":
      return `Active network: ${view.networkId}. Select Canton TestNet in Metatarz Wallet, then refresh.`;
    case "no-primary":
      return "Unlock Metatarz Wallet and select an active Canton TestNet party, then refresh.";
    case "connected":
      return "Connected to Canton TestNet. To change the active party, select it in Metatarz Wallet.";
    case "rejected":
      return "Connection declined in Metatarz Wallet.";
    case "failed":
    case "changed":
      return "Could not verify the wallet connection. Open Metatarz Wallet and try again.";
  }
}

export function MetatarzConnection({ onBack }: { onBack: () => void }) {
  const embedded = window.parent !== window;
  const isolated = embedded && window.origin === "null";
  const [view, setView] = useState<View>(() => ({
    kind: isolated ? "isolated" : metatarzProvider() ? "ready" : "missing",
  }));
  const [provider, setProvider] = useState(() => (isolated ? undefined : metatarzProvider()));
  const revision = useRef(0);
  const approving = useRef(false);

  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );

  async function refresh(wallet: NonNullable<typeof provider>, connect = false) {
    const request = ++revision.current;
    setView({ kind: connect ? "pending" : "checking" });
    try {
      const next = await readMetatarzSession(wallet, connect);
      if (request === revision.current) setView(next);
    } catch (error) {
      if (request !== revision.current) return;
      const code = (error as { code?: unknown } | null)?.code;
      setView({ kind: code === 4001 ? "rejected" : code === 4100 ? "disconnected" : "failed" });
    }
  }

  useEffect(() => {
    function changed() {
      if (provider && !approving.current) void refresh(provider);
    }
    provider?.on("statusChanged", changed);
    provider?.on("accountsChanged", changed);
    return () => {
      provider?.removeListener("statusChanged", changed);
      provider?.removeListener("accountsChanged", changed);
    };
  }, [provider]);

  async function connect() {
    if (approving.current) return;
    const wallet = metatarzProvider();
    if (!wallet) {
      setView({ kind: "missing" });
      return;
    }
    if (wallet !== provider) setProvider(wallet);
    approving.current = true;
    try {
      await refresh(wallet, true);
    } finally {
      approving.current = false;
    }
  }

  return (
    <section aria-label="Metatarz Wallet">
      <button type="button" className="send-secondary" onClick={onBack}>
        Back to Send
      </button>
      <h2 className="send-card__title">Metatarz Wallet</h2>
      <p role="status">{connectionMessage(view)}</p>
      {view.kind === "connected" && (
        <p>
          Active party <code className="send-metatarz__party">{view.primaryParty}</code>
        </p>
      )}
      <p>Use Send Tokens in Metatarz Wallet for direct Canton Coin transfers.</p>
      {!isolated && (
        <button
          type="button"
          className="send-secondary"
          disabled={view.kind === "pending" || view.kind === "checking"}
          onClick={() => void connect()}
        >
          {view.kind === "connected" || view.kind === "wrong-network"
            ? "Refresh Metatarz connection"
            : "Connect Metatarz Wallet"}
        </button>
      )}
      {view.kind === "missing" && (
        <p>
          <a href={METATARZ_INSTALL} target="_blank" rel="noopener noreferrer">
            Get Metatarz Wallet
          </a>
        </p>
      )}
      {embedded && (
        <p>
          <a href={metatarzStandaloneUrl()} target="_blank" rel="noopener noreferrer">
            Open Send in a new tab
          </a>
        </p>
      )}
    </section>
  );
}
