import { useEffect, useState } from "react";
import { WalletProvider } from "./components/WalletProvider.js";
import { ToastProvider } from "./components/Toast.js";
import { SessionReloadBanner } from "./components/SessionReloadBanner.js";
import { StealthProvider } from "./hooks/useStealth.js";
import { useTheme } from "./hooks/useTheme.js";
import { Trade } from "./pages/Trade.js";
import { useConfig } from "wagmi";
import { startHostBridge, type HostBridgeLease } from "./lib/hostBridge.js";
import { autoConnectHostWallet } from "./wagmi.js";
import { useEmbedLook } from "./hooks/useEmbedLook.js";
import type { EmbedLook } from "./pages/trade/embedParams.js";
import { EMBED_THEME_APP } from "./pages/trade/embedTheme.js";

// The widget is the trade card and its in-frame tabs, nothing else: no site
// header, footer or storage notice (xochi-fi/xochi-widget#20). It is served at
// /embed, the URL a host frames; route and layout come from the URL, while
// the initial URL theme can be overridden live by the host bridge.
function Widget({ look, lease }: { look: EmbedLook; lease: HostBridgeLease }) {
  useTheme(EMBED_THEME_APP[look.theme]);
  useHostResize(lease);
  useHostAutoConnect(lease);

  return (
    <ToastProvider>
      <title>Trade | Xochi</title>
      <SessionReloadBanner />

      {/* Background layers */}
      <div className="pearl-bg demo-bg" />
      <div className="dark-overlay demo-overlay" />

      <Trade look={look} hostConnection={lease.bridge} />
    </ToastProvider>
  );
}

/**
 * Report the content height to the embedding page (`xochi:resize`) so it can
 * size the iframe. No-op unless framed by a host using @xochi/widget-lib.
 */
function useHostResize(lease: HostBridgeLease): void {
  useEffect(() => {
    const root = document.getElementById("root");
    const { bridge } = lease;
    if (!lease.active || !bridge || !root) return;
    const observer = new ResizeObserver(() => bridge.resize(root.getBoundingClientRect().height));
    observer.observe(root);
    return () => observer.disconnect();
  }, [lease]);
}

/** Connect the host wallet on load when the host opted in (`autoConnectHostWallet`). */
function useHostAutoConnect(lease: HostBridgeLease): void {
  const config = useConfig();
  useEffect(() => {
    if (!lease.active || !lease.bridge) return;
    return autoConnectHostWallet(config, lease.bridge);
  }, [config, lease]);
}

/** The frame with its whole provider stack. Loaded only on /embed. */
export default function EmbedApp() {
  // Preserve the bridge through effect cleanup: null means standalone, not the
  // gap while Activity replaces a framed connection.
  const [lease, setLease] = useState<HostBridgeLease | null>(null);
  const look = useEmbedLook(lease?.bridge ?? null);
  useEffect(() => {
    const nextLease = startHostBridge();
    setLease(nextLease);
    return () => nextLease.stop();
  }, []);
  if (lease === null) return null;
  return (
    <WalletProvider theme={EMBED_THEME_APP[look.theme]} hostWallet={lease.bridge}>
      {/* Inside WalletProvider: stealth keys derive from a wallet signature, so
          the provider needs wagmi's account context. */}
      <StealthProvider>
        <Widget look={look} lease={lease} />
      </StealthProvider>
    </WalletProvider>
  );
}
