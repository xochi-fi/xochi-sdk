import { useMemo, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme, lightTheme, type Locale } from "@rainbow-me/rainbowkit";
import { config, createWagmiConfig } from "../wagmi.js";
import { PALETTE } from "../constants.js";
import { useResolvedTheme, type AppTheme } from "../hooks/useTheme.js";
import type { HostConnection } from "@xochi/widget-lib";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 60_000,
    },
  },
});

const RAINBOW_THEMES = {
  dim: darkTheme({
    accentColor: PALETTE.mutedGold,
    accentColorForeground: PALETTE.obsidian,
    borderRadius: "small",
  }),
  dark: darkTheme({
    accentColor: PALETTE.mutedGoldBright,
    accentColorForeground: PALETTE.obsidian,
    borderRadius: "small",
  }),
  light: lightTheme({
    accentColor: PALETTE.mutedGoldDark,
    accentColorForeground: "#ffffff",
    borderRadius: "small",
  }),
} as const;

interface WalletProviderProps {
  children: ReactNode;
  /** The frame's current theme, or null to follow the stored/system choice. */
  theme?: AppTheme | null;
  /** The embedding page's bridge. Its wallet appears only while one is attached. */
  hostWallet?: HostConnection | null;
}

export function WalletProvider({ children, theme = null, hostWallet = null }: WalletProviderProps) {
  const resolvedTheme = useResolvedTheme(theme);
  // Keep one framed config for the bridge's lifetime. Swapping back to the
  // standalone config when a host detaches can revive a persisted widget-origin
  // wallet while the parent header is disconnected.
  const wagmiConfig = useMemo(
    () => (hostWallet === null ? config : createWagmiConfig(hostWallet)),
    [hostWallet],
  );

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={hostWallet === null}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider locale={"en" as Locale} theme={RAINBOW_THEMES[resolvedTheme]}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
