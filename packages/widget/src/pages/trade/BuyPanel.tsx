/**
 * BuyPanel
 *
 * Trade's Buy mode (API `onramp`): buying Base USDC with fiat through Peer.
 * Shows live Peer rail availability (ramp/availability); only a fresh
 * `available` offer can be chosen, and choosing one starts nothing yet.
 */

import { useAccount, useWalletClient, usePublicClient, useSwitchChain } from "wagmi";
import { BuyOnramp } from "../../ramp/peer/BuyOnramp.js";
import { RampRails } from "../../ramp/availability/RampRails.js";

interface BuyPanelProps {
  /** Whether Buy is the visible mode; a hidden panel reads nothing from Peer. */
  active: boolean;
  fiatCurrency?: string;
}

export function BuyPanel({ active, fiatCurrency }: BuyPanelProps) {
  const { address, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient({ chainId: 8453 });
  return (
    <div className="send-card">
      <h2 className="send-card__title">Buy</h2>
      {address && chainId !== 8453 && (
        <button type="button" disabled={isPending} onClick={() => switchChain({ chainId: 8453 })}>
          Switch wallet to Base for Peer purchase
        </button>
      )}
      <RampRails
        direction="onramp"
        account={address}
        fiatCurrency={fiatCurrency}
        active={active}
        renderSelected={(intent, offer, lock) => (
          <BuyOnramp
            key={offer.capability_revision}
            intent={intent}
            offer={offer}
            wallet={chainId === 8453 ? wallet : undefined}
            publicClient={publicClient}
            onSubmit={() => lock()}
            onReset={() => lock(false)}
          />
        )}
      />
    </div>
  );
}
