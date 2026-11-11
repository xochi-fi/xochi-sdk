/**
 * AccountChip
 *
 * The connected wallet on the widget's top row: chain badge + short address,
 * opening RainbowKit's account modal (switch / disconnect). Renders nothing
 * while disconnected, because the card's own CTA is the one connect action.
 * On a chain the app does not support RainbowKit offers no account modal, so
 * the chip opens the chain switcher instead of being a dead button.
 */

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { EXTENDED_CHAIN_NAMES } from "@xochi/client";
import { CHAIN_ICONS } from "../assets/chains/index.js";
import type { ExtendedChainId } from "../types/intent.js";

export function AccountChip() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal }) => {
        if (!mounted || !account || !chain) return null;

        const shortAddress = `${account.address.slice(0, 6)}...${account.address.slice(-4)}`;
        const knownChain = chain.unsupported ? undefined : (chain.id as ExtendedChainId);
        const chainName =
          knownChain === undefined
            ? "an unsupported network"
            : (EXTENDED_CHAIN_NAMES[knownChain] ?? chain.name ?? `chain ${chain.id}`);
        const chainIcon = knownChain === undefined ? undefined : CHAIN_ICONS[knownChain];

        return (
          <button
            type="button"
            className="connect-wallet-btn connected account-chip"
            onClick={chain.unsupported ? openChainModal : openAccountModal}
            aria-label={`Account ${shortAddress} on ${chainName}`}
          >
            {chainIcon && <img src={chainIcon} alt="" className="chain-icon" />}
            {shortAddress}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
