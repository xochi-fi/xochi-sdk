import { useCallback, useEffect, useRef, useState } from "react";
import {
  METATARZ_INSTALL,
  METATARZ_TESTNET,
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
        : "";
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
  const pendingRead = useRef<AbortController | null>(null);
  const approving = useRef<typeof provider>(undefined);
  const walletChanged = useRef(false);

  useEffect(
    () => () => {
      pendingRead.current?.abort();
    },
    [],
  );

  const refresh = useCallback(async (wallet: NonNullable<typeof provider>, connect = false) => {
    pendingRead.current?.abort();
    const request = new AbortController();
    pendingRead.current = request;
    setView({ kind: connect ? "pending" : "checking" });
    function current() {
      if (request.signal.aborted) return false;
      const active = metatarzProvider();
      if (active === wallet) return true;
      setProvider(active);
      if (!active) setView({ kind: "missing" });
      return false;
    }
    try {
      let next = await readMetatarzSession(wallet, connect, METATARZ_TESTNET, request.signal);
      // An approval can itself emit statusChanged. Re-read after it settles
      // if the wallet also reported a change while the request was in flight.
      while (connect && walletChanged.current && current()) {
        walletChanged.current = false;
        next = await readMetatarzSession(wallet, false, METATARZ_TESTNET, request.signal);
      }
      if (current()) setView(next);
    } catch (error) {
      if (!current()) return;
      const code = (error as { code?: unknown } | null)?.code;
      setView({ kind: code === 4001 ? "rejected" : code === 4100 ? "disconnected" : "failed" });
    }
  }, []);

  useEffect(() => {
    if (!provider) return;
    function changed() {
      const wallet = metatarzProvider();
      if (wallet !== provider) {
        pendingRead.current?.abort();
        setProvider(wallet);
        if (!wallet) setView({ kind: "missing" });
      } else if (approving.current === provider) {
        walletChanged.current = true;
      } else if (wallet) {
        void refresh(wallet);
      }
    }
    provider.on("statusChanged", changed);
    provider.on("accountsChanged", changed);
    if (approving.current !== provider) void refresh(provider);
    return () => {
      provider.removeListener("statusChanged", changed);
      provider.removeListener("accountsChanged", changed);
    };
  }, [provider, refresh]);

  async function connect() {
    if (approving.current) return;
    const wallet = metatarzProvider();
    if (!wallet) {
      setView({ kind: "missing" });
      return;
    }
    if (wallet !== provider) setProvider(wallet);
    approving.current = wallet;
    walletChanged.current = false;
    try {
      await refresh(wallet, true);
    } finally {
      approving.current = undefined;
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
            : view.kind === "ready" || pending || view.kind === "disconnected"
              ? "Connect"
              : "Retry"}
        </button>
      )}
    </div>
  );
}
