/**
 * SendPanel
 *
 * The Send tab: one surface for moving value out of the connected wallet. The
 * user picks a destination kind (a nested tablist, same keys as the top row):
 *
 *   - `address`: a public ERC-20 transfer to a wallet address (AddressSend);
 *   - `stealth`: the existing Stealth settlement to the user's own stealth
 *     keys, handed to the Swap card (StealthSend);
 *   - `payment_app`: cashing out Base USDC to the user's own payment-app
 *     account through a Peer maker deposit (ramp/offramp/PaymentAppSend).
 *
 * Neither `address` nor `stealth` touches Peer. Each destination stays mounted
 * while hidden, so switching kinds keeps what was typed.
 */

import { useId } from "react";
import { PaymentAppSend } from "../../ramp/offramp/PaymentAppSend.js";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import {
  WidgetTabs,
  widgetTabIds,
  SEND_DESTINATION_KINDS,
  type SendDestinationKind,
  type WidgetTab,
} from "../trade/WidgetTabs.js";
import { AddressSend } from "./AddressSend.js";
import { StealthSend } from "./StealthSend.js";

const LABELS: Record<SendDestinationKind, string> = {
  address: "Address",
  stealth: "Stealth",
  payment_app: "Payment app",
};

interface SendPanelProps {
  destination: SendDestinationKind;
  onDestinationChange: (next: SendDestinationKind) => void;
  /** The kinds offered, in order (a host may narrow them later). */
  destinations?: readonly SendDestinationKind[];
  onStealthContinue: (order: Omit<SwapPrefill, "nonce">) => void;
  onConnectRequest?: () => void;
  /** Whether the Send tab is visible; a hidden payment_app slot reads nothing from Peer. */
  active?: boolean;
  fiatCurrency?: string;
}

export function SendPanel({
  destination,
  onDestinationChange,
  destinations = SEND_DESTINATION_KINDS,
  onStealthContinue,
  onConnectRequest,
  active = true,
  fiatCurrency,
}: SendPanelProps) {
  const baseId = useId();
  const tabs: WidgetTab<SendDestinationKind>[] = destinations.map((kind) => ({
    id: kind,
    label: LABELS[kind],
  }));
  const panel = (kind: SendDestinationKind) => {
    const ids = widgetTabIds(baseId, kind);
    return {
      role: "tabpanel",
      id: ids.panel,
      "aria-labelledby": ids.tab,
      hidden: destination !== kind,
      className: "send-card__panel",
    } as const;
  };

  return (
    <div className="send-card">
      <h2 className="send-card__title">Send</h2>
      <WidgetTabs
        baseId={baseId}
        tabs={tabs}
        active={destination}
        onSelect={onDestinationChange}
        label="Send to"
        className="send-card__kinds"
      />
      {destinations.includes("address") && (
        <div {...panel("address")}>
          <AddressSend onConnectRequest={onConnectRequest} />
        </div>
      )}
      {destinations.includes("stealth") && (
        <div {...panel("stealth")}>
          <StealthSend onContinue={onStealthContinue} onConnectRequest={onConnectRequest} />
        </div>
      )}
      {destinations.includes("payment_app") && (
        <div {...panel("payment_app")}>
          <PaymentAppSend
            fiatCurrency={fiatCurrency}
            active={active && destination === "payment_app"}
          />
        </div>
      )}
    </div>
  );
}
