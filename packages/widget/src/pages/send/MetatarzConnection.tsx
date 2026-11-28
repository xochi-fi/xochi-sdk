import { useCallback, useEffect, useRef, useState } from "react";
import {
  METATARZ_INSTALL,
  METATARZ_TESTNET,
  metatarzProvider,
  metatarzStandaloneUrl,
  readMetatarzSession,
  type MetatarzSession,
} from "./metatarz.js";
import { checkMetatarzLedger, type LedgerCheck } from "./metatarzLedger.js";

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
  const pendingLedger = useRef<AbortController | null>(null);
  const [ledger, setLedger] = useState<LedgerCheck>();
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [updateId, setUpdateId] = useState("");
  const [updateOffset, setUpdateOffset] = useState("");
  const approving = useRef<typeof provider>(undefined);
  const walletChanged = useRef(false);

  useEffect(
    () => () => {
      pendingRead.current?.abort();
      pendingLedger.current?.abort();
    },
    [],
  );

  const refresh = useCallback(async (wallet: NonNullable<typeof provider>, connect = false) => {
    pendingRead.current?.abort();
    pendingLedger.current?.abort();
    setLedger(undefined);
    setLedgerBusy(false);
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
        pendingLedger.current?.abort();
        setLedger(undefined);
        setLedgerBusy(false);
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

  async function readLedger() {
    if (!party || !provider || (pendingLedger.current && !pendingLedger.current.signal.aborted))
      return;
    const request = new AbortController();
    pendingLedger.current = request;
    setLedger(undefined);
    setLedgerBusy(true);
    try {
      const result = await checkMetatarzLedger(
        provider,
        party,
        { id: updateId.trim(), offset: updateOffset.trim() },
        request.signal,
      );
      if (!request.signal.aborted) setLedger(result);
    } catch {
      if (!request.signal.aborted)
        setLedger({ offset: "Couldn’t verify the active TestNet party." });
    } finally {
      if (pendingLedger.current === request) {
        pendingLedger.current = null;
        if (!request.signal.aborted) setLedgerBusy(false);
      }
    }
  }

  return (
    <>
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
      {party && (
        <details className="send-metatarz__party">
          <summary>TestNet ledger</summary>
          <label className="send-input">
            <input
              className="send-field__control"
              aria-label="Optional update ID"
              placeholder="Optional update ID"
              maxLength={255}
              value={updateId}
              disabled={ledgerBusy}
              onChange={(event) => {
                setUpdateId(event.target.value);
                setUpdateOffset("");
                setLedger(undefined);
              }}
            />
          </label>
          {updateId.trim() && (
            <label className="send-input">
              <input
                className="send-field__control"
                aria-label="Optional update offset"
                placeholder="Optional update offset"
                inputMode="numeric"
                maxLength={16}
                value={updateOffset}
                disabled={ledgerBusy}
                onChange={(event) => {
                  setUpdateOffset(event.target.value);
                  setLedger(undefined);
                }}
              />
            </label>
          )}
          <button
            type="button"
            className="send-secondary"
            disabled={ledgerBusy}
            onClick={() => void readLedger()}
          >
            {ledgerBusy ? "Reading ledger…" : "Check ledger"}
          </button>
          {ledger && (
            <ul aria-live="polite">
              <li>{ledger.offset}</li>
              {ledger.holdings && <li>{ledger.holdings}</li>}
              {ledger.update && <li>{ledger.update}</li>}
            </ul>
          )}
        </details>
      )}
    </>
  );
}
