import type { ResolvedRecipient } from "../../lib/recipient/index.js";
import type { Ref } from "react";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import { SEND_DESTINATION_KINDS, type SendDestinationKind } from "../trade/WidgetTabs.js";
import { SendForm } from "./SendForm.js";

interface SendPanelProps {
  initialChain?: number;
  active: boolean;
  destinations?: readonly SendDestinationKind[];
  showQuote: boolean;
  quoteMount: Ref<HTMLDivElement>;
  onCloseQuote: () => void;
  onQuote: (order: Omit<SwapPrefill, "nonce">, recipient: ResolvedRecipient) => void;
  onConnectRequest?: () => void;
}

export function SendPanel({
  destinations = SEND_DESTINATION_KINDS,
  active,
  showQuote,
  quoteMount,
  onCloseQuote,
  ...props
}: SendPanelProps) {
  return (
    <>
      <div className="send-card" hidden={showQuote}>
        <SendForm destinations={destinations} {...props} active={active && !showQuote} />
      </div>
      <section className="send-quote" hidden={!showQuote} aria-label="Send quote">
        <button type="button" className="send-secondary" onClick={onCloseQuote}>
          Back to Send
        </button>
        <div className="send-swap-mount" ref={quoteMount} />
      </section>
    </>
  );
}
