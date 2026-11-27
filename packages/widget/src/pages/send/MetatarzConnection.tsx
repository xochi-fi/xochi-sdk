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
      return "";
    case "missing":
      return "Wallet unavailable here.";
    case "isolated":
      return "Wallet access is blocked in this embed.";
    case "pending":
      return "Check your wallet.";
    case "checking":
      return "Checking connection…";
    case "disconnected":
      return view.reason?.startsWith("No Canton account")
        ? "Activate a TestNet party in your wallet."
        : "Unlock your wallet and reconnect.";
    case "unreachable":
      return "TestNet connection unavailable.";
    case "wrong-network":
      return "Switch to Canton TestNet in your wallet.";
    case "no-primary":
      return "Select an active TestNet party.";
    case "connected":
      return "Connected";
    case "rejected":
      return "Connection declined.";
    case "failed":
    case "changed":
      return "Couldn’t verify the connection.";
  }
}

export function MetatarzConnection() {
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

  const pending = view.kind === "pending" || view.kind === "checking";
  const openStandalone = isolated || (embedded && view.kind === "missing");
  const party = view.kind === "connected" ? view.primaryParty : undefined;
  const preview = party && `${party.slice(0, 11)}…${party.slice(-6)}`;
  return (
    <div className="send-metatarz__connection">
      <div className="send-metatarz__status">
        <div role="status">{connectionMessage(view)}</div>
        {party && (
          <details className="send-metatarz__party" key={party}>
            <summary aria-label={`Full active party ID, ${preview}`}>
              <code>{preview}</code>
            </summary>
            <div className="send-input">
              <input
                className="send-field__control"
                aria-label="Active party ID"
                readOnly
                value={party}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          </details>
        )}
      </div>
      {openStandalone ? (
        <a href={metatarzStandaloneUrl()} target="_blank" rel="noopener noreferrer">
          Open Send in a new tab
        </a>
      ) : view.kind === "missing" ? (
        <a href={METATARZ_INSTALL} target="_blank" rel="noopener noreferrer">
          Get Metatarz Wallet
        </a>
      ) : (
        <button
          type="button"
          className="send-secondary"
          disabled={pending}
          onClick={() => void connect()}
        >
          {view.kind === "connected"
            ? "Refresh"
            : view.kind === "ready" || pending
              ? "Connect"
              : "Retry"}
        </button>
      )}
    </div>
  );
}
