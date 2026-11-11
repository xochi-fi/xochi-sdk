/**
 * Mobile wallet helpers.
 *
 * On a mobile browser (Safari/Chrome/DuckDuckGo), connecting MetaMask goes through
 * the WalletConnect relay and deep-links out to the MetaMask app. Privacy browsers
 * (DuckDuckGo, Brave, Safari-with-ITP) partition storage aggressively, which breaks
 * the WC session so a sign request never reaches the wallet ("MetaMask opens but no
 * prompt"). The reliable path is to run inside the wallet's OWN in-app browser,
 * where the provider is injected and signing needs no relay round-trip.
 *
 * These helpers detect that situation.
 */

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

/** Best-effort mobile detection from the user agent. */
export function isMobileUserAgent(ua?: string): boolean {
  const agent = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return MOBILE_UA.test(agent);
}

/**
 * True when the page is already running inside a wallet's in-app browser (an
 * injected EIP-1193 provider is present). In that case signing is reliable and the
 * "open in your wallet" hint must NOT show. On desktop the extension also injects
 * `window.ethereum`, but the hint is mobile-gated, so this stays correct there.
 */
export function isInjectedWalletBrowser(
  win: unknown = typeof window !== "undefined" ? window : undefined,
): boolean {
  const eth = (
    win as
      | { ethereum?: { isMetaMask?: boolean; isCoinbaseWallet?: boolean; providers?: unknown[] } }
      | undefined
  )?.ethereum;
  return (
    !!eth &&
    (eth.isMetaMask === true || eth.isCoinbaseWallet === true || Array.isArray(eth.providers))
  );
}

/**
 * Whether to surface the "open in a wallet browser" hint: a mobile browser that is
 * NOT already an injected wallet browser (so it would otherwise fall back to the
 * fragile WalletConnect relay).
 */
export function shouldOfferInAppBrowser(
  win: unknown = typeof window !== "undefined" ? window : undefined,
  ua?: string,
): boolean {
  return isMobileUserAgent(ua) && !isInjectedWalletBrowser(win);
}
