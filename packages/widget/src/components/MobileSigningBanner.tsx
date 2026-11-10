/**
 * MobileSigningBanner
 *
 * On some mobile browsers -- DuckDuckGo especially -- aggressive storage
 * partitioning breaks the WalletConnect session, so the sign request never
 * reaches the wallet and a swap can never be signed. Safari works, and Coinbase
 * Wallet is relay-free, so this banner points relay-bound mobile users at a path
 * that actually signs. Shown only on a mobile browser that is not already a wallet
 * in-app browser; dismissible and remembered.
 *
 * (An "Open in MetaMask" one-tap deep link is the nicer fix, but MetaMask's in-app
 * browser currently crashes to a blank page; see the mobile signing issue. Until
 * that is fixed we guide to Safari / Coinbase, which work today.)
 */

import { useState } from "react";
import { STORAGE_KEYS } from "../constants.js";
import { shouldOfferInAppBrowser } from "../lib/mobileWallet.js";
import "../styles/mobile-signing-banner.css";

export function MobileSigningBanner() {
  // Seed synchronously so it does not flash in; never render if dismissed or if we
  // are not on a relay-bound mobile browser.
  const [visible, setVisible] = useState(
    () =>
      typeof window !== "undefined" &&
      shouldOfferInAppBrowser() &&
      localStorage.getItem(STORAGE_KEYS.mobileSigningHintDismissed) !== "1",
  );
  const [copied, setCopied] = useState(false);

  if (!visible) return null;

  const dismiss = (): void => {
    localStorage.setItem(STORAGE_KEYS.mobileSigningHintDismissed, "1");
    setVisible(false);
  };

  const copyLink = (): void => {
    // iOS has no reliable "open in Safari" scheme from another browser, so copy the
    // URL for the user to paste into Safari. Never throw on a clipboard rejection.
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  return (
    <section className="mobile-signing-banner" role="note" aria-label="Mobile signing tip">
      <div className="mobile-signing-banner__body">
        <p className="mobile-signing-banner__title">Trouble signing on mobile?</p>
        <p className="mobile-signing-banner__text">
          Some private browsers (DuckDuckGo especially) block the wallet connection. Open Xochi in
          Safari, or connect with Coinbase Wallet. Both sign reliably.
        </p>
      </div>
      <div className="mobile-signing-banner__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={copyLink}>
          {copied ? "Link copied" : "Copy link for Safari"}
        </button>
        <button
          type="button"
          className="mobile-signing-banner__dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
