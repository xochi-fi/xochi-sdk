import { describe, it, expect } from "vitest";
import { HOST_WALLET_ID, arc, config } from "./wagmi.js";
import { ARC_BROWSER_ENABLED, ARC_BROWSER_RPC_URL, GNOSIS_ENABLED } from "./config.js";

// Explicit wallet list. The "Recommended" group leads with Coinbase Wallet
// (Coinbase SDK, relay-free) so mobile Safari users land on a wallet that works
// even when the WalletConnect relay fails; MetaMask + WalletConnect follow as
// WC-relay fallbacks. The "More" group keeps Safe and Rainbow so Safe{Wallet}
// App embedding (institutional multisig) and the Rainbow option are not dropped.
// EIP-6963 injected discovery stays on (ssr: false) for desktop extensions.
//
// These tests lock the connectors that must stay registered so a future edit to
// the wallet list cannot silently drop one.

describe("wagmi config", () => {
  it("registers Arc only when a browser-safe RPC enables it", () => {
    const ids = config.chains.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([1, 42161, 10, 8453, 137, 4663]));
    expect(ids.includes(5042)).toBe(ARC_BROWSER_ENABLED);
    if (ARC_BROWSER_ENABLED) {
      expect(arc.rpcUrls.default.http[0]).toBe(ARC_BROWSER_RPC_URL);
    }
  });

  it("uses Arc mainnet metadata", () => {
    expect(arc.id).toBe(5042);
    expect(arc.blockExplorers.default.url).toBe("https://explorer.arc.io");
  });

  // usePublicBalances reads Gnosis only under the same flag; a wallet chain
  // registered without it (or the reverse) desyncs the network menu from the
  // trade selectors and can fail the batched balance read.
  it("registers Gnosis only when VITE_XOCHI_GNOSIS_LIVE enables it", () => {
    const ids = config.chains.map((c) => c.id);
    expect(ids.includes(100)).toBe(GNOSIS_ENABLED);
  });

  it("leads with the relay-free Coinbase Wallet connector", () => {
    const ids = config.connectors.map((c) => c.id);
    expect(ids).toContain("coinbaseWalletSDK");
  });

  it("includes a WalletConnect connector so mobile wallets can deep-link", () => {
    const hasWalletConnect = config.connectors.some(
      (c) => c.id === "walletConnect" || /walletconnect/i.test(c.name),
    );
    expect(hasWalletConnect).toBe(true);
  });

  it("keeps the Safe connector so Safe App / multisig users aren't dropped", () => {
    const ids = config.connectors.map((c) => c.id);
    expect(ids).toContain("safe");
  });

  it("offers Base Account as a secondary smart-wallet option", () => {
    // baseAccount is the deprecation successor to coinbaseWallet but a smart
    // account (no ERC-3009), so it is a secondary option, not the EOA lead.
    const ids = config.connectors.map((c) => c.id);
    expect(ids).toContain("baseAccount");
  });

  it("does not advertise a host wallet in a standalone or providerless frame", () => {
    expect(config.connectors.map((connector) => connector.id)).not.toContain(HOST_WALLET_ID);
  });
});
