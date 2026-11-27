import { useLayoutEffect, useRef, useState } from "react";
import { CANTON_MAINNET_CHAIN_ID } from "@xochi/client";
import { METATARZ_MAINNET, metatarzProvider, readMetatarzSession } from "../send/metatarz.js";

export function useCantonRecipientFill(chainId: number, scope: string, locked: boolean) {
  // Xochi has one Canton destination. Metatarz's TestNet and EVM facade IDs
  // confer no authority to supply a party for this route.
  const network = chainId === CANTON_MAINNET_CHAIN_ID ? METATARZ_MAINNET : undefined;
  const embedded = window.parent !== window;
  const isolated = embedded && window.origin === "null";
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [needsStandalone, setNeedsStandalone] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    setNote("");
    setNeedsStandalone(false);
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [chainId, scope, locked]);

  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setNote("");
    setNeedsStandalone(false);
  }

  function unavailable() {
    setNote("Metatarz Wallet unavailable. Paste a party ID.");
    setNeedsStandalone(embedded);
  }

  async function fill(apply: (party: string) => void) {
    if (!network || isolated || locked || pending.current) return;
    const wallet = metatarzProvider();
    if (!wallet) {
      unavailable();
      return;
    }

    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setNote("");
    setNeedsStandalone(false);
    try {
      const session = await readMetatarzSession(wallet, true, network, request.signal);
      if (request.signal.aborted) return;
      const activeWallet = metatarzProvider();
      if (!activeWallet) {
        unavailable();
      } else if (session.kind === "changed" || wallet !== activeWallet) {
        setNote("Wallet changed. Try again.");
      } else if (session.kind === "connected") {
        apply(session.primaryParty);
      } else if (session.kind === "wrong-network") {
        setNote("Select Canton MainNet in Metatarz.");
      } else if (session.kind === "no-primary") {
        setNote("Select an allocated Canton MainNet party in Metatarz.");
      } else {
        setNote("Check your Metatarz connection and retry.");
      }
    } catch (error) {
      if (!request.signal.aborted) {
        const activeWallet = metatarzProvider();
        if (!activeWallet) return unavailable();
        if (wallet !== activeWallet) return setNote("Wallet changed. Try again.");
        const { code, message } = (error as { code?: unknown; message?: unknown } | null) ?? {};
        const blocked = embedded && code === 4100 && message === "Unauthorized: unknown origin";
        setNeedsStandalone(blocked);
        setNote(
          blocked
            ? "Wallet access is blocked in this embed."
            : code === 4001
              ? "Connection declined."
              : "Check your Metatarz connection and retry.",
        );
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return { fill, cancel, busy, note, isolated, showStandalone: isolated || needsStandalone };
}
