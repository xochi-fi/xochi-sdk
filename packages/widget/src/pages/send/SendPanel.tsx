import { useId, useState } from "react";
import { PrivacyBars } from "../../components/PrivacyBars.js";
import { MODE_META } from "../trade/settlementCopy.js";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import { SEND_DESTINATION_KINDS, type SendDestinationKind } from "../trade/WidgetTabs.js";
import { AddressSend } from "./AddressSend.js";
import { StealthSend } from "./StealthSend.js";

const LABELS: Record<SendDestinationKind, string> = {
  address: "Wallet address",
  stealth: "Stealth address",
};

interface SendPanelProps {
  initialChain?: number;
  destination: SendDestinationKind;
  onDestinationChange: (next: SendDestinationKind) => void;
  destinations?: readonly SendDestinationKind[];
  onStealthContinue: (order: Omit<SwapPrefill, "nonce">) => void;
  onConnectRequest?: () => void;
}

export function SendPanel({
  initialChain,
  destination,
  onDestinationChange,
  destinations = SEND_DESTINATION_KINDS,
  onStealthContinue,
  onConnectRequest,
}: SendPanelProps) {
  const id = useId();
  const [walletAddress, setWalletAddress] = useState("");
  const [metaAddress, setMetaAddress] = useState("");
  const [pasteError, setPasteError] = useState("");

  const applyPaste = (raw: string) => {
    const value = raw.trim();
    const kind = /^st:eth:/i.test(value) ? "stealth" : /^0x/i.test(value) ? "address" : destination;
    if (!destinations.includes(kind)) {
      setPasteError("This recipient type is unavailable here.");
      return;
    }
    setPasteError("");
    if (kind === "stealth") setMetaAddress(value);
    else setWalletAddress(value);
    onDestinationChange(kind);
  };

  const paste = async () => {
    try {
      applyPaste(await navigator.clipboard.readText());
    } catch {
      setPasteError("Paste into the recipient field directly.");
    }
  };

  return (
    <div className="send-card">
      <h2 className="sr-only">Send</h2>
      <fieldset className="send-destinations">
        <legend>Send to</legend>
        {destinations.map((kind) => (
          <label className="send-destination" key={kind}>
            <input
              className="sr-only"
              type="radio"
              aria-label={LABELS[kind]}
              aria-description={MODE_META[kind === "address" ? "public" : "stealth"]}
              aria-controls={`${id}-${kind}`}
              name={id}
              checked={destination === kind}
              onChange={() => onDestinationChange(kind)}
            />
            <PrivacyBars count={kind === "address" ? 1 : 2} active={destination === kind} />
            <strong>{LABELS[kind]}</strong>
            <small>{MODE_META[kind === "address" ? "public" : "stealth"]}</small>
          </label>
        ))}
      </fieldset>
      {pasteError && (
        <p className="send-note" role="status">
          {pasteError}
        </p>
      )}
      {destinations.includes("address") && (
        <div id={`${id}-address`} hidden={destination !== "address"} className="send-card__panel">
          <AddressSend
            initialChain={initialChain}
            onConnectRequest={onConnectRequest}
            recipient={walletAddress}
            onRecipient={setWalletAddress}
            onPaste={paste}
            onPasteValue={applyPaste}
          />
        </div>
      )}
      {destinations.includes("stealth") && (
        <div id={`${id}-stealth`} hidden={destination !== "stealth"} className="send-card__panel">
          <StealthSend
            initialChain={initialChain}
            onContinue={onStealthContinue}
            onConnectRequest={onConnectRequest}
            recipient={metaAddress}
            onRecipient={setMetaAddress}
            onPaste={paste}
            onPasteValue={applyPaste}
          />
        </div>
      )}
    </div>
  );
}
