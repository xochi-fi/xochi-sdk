/**
 * BuyPanel
 *
 * Trade's Buy mode (API `onramp`): buying Base USDC with fiat through Peer.
 * Shows live Peer rail availability (ramp/availability); only a fresh
 * `available` offer can be chosen, and choosing one starts nothing yet.
 */

import { useAccount } from "wagmi";
import { RampRails } from "../../ramp/availability/RampRails.js";

interface BuyPanelProps {
  /** Whether Buy is the visible mode; a hidden panel reads nothing from Peer. */
  active: boolean;
  fiatCurrency?: string;
}

export function BuyPanel({ active, fiatCurrency }: BuyPanelProps) {
  const { address } = useAccount();
  return (
    <div className="send-card">
      <h2 className="send-card__title">Buy</h2>
      <RampRails direction="onramp" account={address} fiatCurrency={fiatCurrency} active={active} />
    </div>
  );
}
