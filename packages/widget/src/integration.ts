import "./browser.js";

/** Shared browser modules used by the separately hosted affiliate dashboard. Load after configureWidget. */
export { WalletProvider } from "./components/WalletProvider.js";
export { AccountChip } from "./components/AccountChip.js";
export { useTheme } from "./hooks/useTheme.js";
export { useWalletSession, type WalletSessionState } from "./hooks/useWalletSession.js";
export { clearWalletSession, getWalletToken, hasWalletSession } from "./lib/walletSession.js";
export { apiGet } from "./lib/api.js";
export { STORAGE_KEYS } from "./constants.js";
