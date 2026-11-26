import type { ResolvedRecipient } from "../../lib/recipient/index.js";
import { useState, type Ref } from "react";
import { METATARZ_TESTNET_CONNECTION } from "../../config.js";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import { SEND_DESTINATION_KINDS, type SendDestinationKind } from "../trade/WidgetTabs.js";
import type { SendRetryDraft } from "./sendRetry.js";
import { SendForm } from "./SendForm.js";
import { MetatarzConnection } from "./MetatarzConnection.js";

interface SendPanelProps {
  initialChain?: number;
  retry?: SendRetryDraft;
  onEditRetry?: () => void;
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
  const [metatarzOpen, setMetatarzOpen] = useState(false);
  const offerMetatarz = METATARZ_TESTNET_CONNECTION && !props.retry;
  const showMetatarz = offerMetatarz && metatarzOpen;
  const sendForm = (
    <SendForm
      key={props.retry?.nonce}
      destinations={destinations}
      {...props}
      active={active && !showQuote && !showMetatarz}
    />
  );
  return (
    <>
      <div className="send-card" hidden={showQuote}>
        {offerMetatarz ? (
          <>
            {!showMetatarz && (
              <button
                type="button"
                className="send-secondary"
                onClick={() => setMetatarzOpen(true)}
              >
                Canton TestNet via Metatarz
              </button>
            )}
            <div hidden={showMetatarz}>{sendForm}</div>
          </>
        ) : (
          sendForm
        )}
        {showMetatarz && active && !showQuote && (
          <MetatarzConnection onBack={() => setMetatarzOpen(false)} />
        )}
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
