import { useEffect, useState } from "react";
import { WalletProvider } from "./components/WalletProvider.js";
import { ToastProvider } from "./components/Toast.js";
import { SessionReloadBanner } from "./components/SessionReloadBanner.js";
import { StealthProvider } from "./hooks/useStealth.js";
import { useTheme } from "./hooks/useTheme.js";
import { Trade } from "./pages/Trade.js";
import { useConfig } from "wagmi";
import { hostBridge, startHostBridge } from "./lib/hostBridge.js";
import { autoConnectHostWallet } from "./wagmi.js";
import { useEmbedLook } from "./hooks/useEmbedLook.js";
import type { EmbedLook } from "./pages/trade/embedParams.js";
import { EMBED_THEME_APP } from "./pages/trade/embedTheme.js";

// The widget is the trade card and its in-frame tabs, nothing else: no site
// header, footer or storage notice (xochi-fi/xochi-widget#20). It is served at
// /embed, the URL a host frames; route and layout come from the URL, while
// the initial URL theme can be overridden live by the host bridge.
function Widget({ look }: { look: EmbedLook }) {
  useTheme(EMBED_THEME_APP[look.theme]);
  useHostResize();
  useHostAutoConnect();

  return (
    <ToastProvider>
      <title>Trade | Xochi</title>
      <SessionReloadBanner />

      {/* Background layers */}
      <div className="pearl-bg demo-bg" />
      <div className="dark-overlay demo-overlay" />

      <Trade look={look} />
    </ToastProvider>
  );
}

/**
 * Report the content height to the embedding page (`xochi:resize`) so it can
 * size the iframe. No-op unless framed by a host using @xochi/widget-lib.
 */
function useHostResize(): void {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!hostBridge || !root) return;
    const bridge = hostBridge;
    const observer = new ResizeObserver(() => bridge.resize(root.getBoundingClientRect().height));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
}

/** Connect the host wallet on load when the host opted in (`autoConnectHostWallet`). */
function useHostAutoConnect(): void {
  const config = useConfig();
  useEffect(() => {
    if (!hostBridge) return;
    return autoConnectHostWallet(config, hostBridge);
  }, [config]);
}

/** The frame with its whole provider stack. Loaded only on /embed. */
export default function EmbedApp() {
  const look = useEmbedLook(hostBridge);
  const [bridgeReady, setBridgeReady] = useState(false);
  useEffect(() => {
    const stop = startHostBridge();
    setBridgeReady(true);
    return stop;
  }, []);
  if (!bridgeReady) return null;
  return (
    <WalletProvider theme={EMBED_THEME_APP[look.theme]} hostWallet={hostBridge}>
      {/* Inside WalletProvider: stealth keys derive from a wallet signature, so
          the provider needs wagmi's account context. */}
      <StealthProvider>
        <Widget look={look} />
      </StealthProvider>
    </WalletProvider>
  );
}
