import { describe, it, expect } from "vitest";
import {
  isMobileUserAgent,
  isInjectedWalletBrowser,
  shouldOfferInAppBrowser,
} from "./mobileWallet.js";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) DDG/17.0";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120";

describe("isMobileUserAgent", () => {
  it("detects a mobile browser (DuckDuckGo on iPhone)", () => {
    expect(isMobileUserAgent(IPHONE_UA)).toBe(true);
  });
  it("is false for desktop", () => {
    expect(isMobileUserAgent(DESKTOP_UA)).toBe(false);
  });
});

describe("isInjectedWalletBrowser", () => {
  it("true inside MetaMask's in-app browser", () => {
    expect(isInjectedWalletBrowser({ ethereum: { isMetaMask: true } })).toBe(true);
  });
  it("true inside Coinbase Wallet's browser", () => {
    expect(isInjectedWalletBrowser({ ethereum: { isCoinbaseWallet: true } })).toBe(true);
  });
  it("false in a plain mobile browser (no injected provider)", () => {
    expect(isInjectedWalletBrowser({})).toBe(false);
  });
});

describe("shouldOfferInAppBrowser", () => {
  it("offers the hint on a mobile browser with no injected wallet", () => {
    expect(shouldOfferInAppBrowser({}, IPHONE_UA)).toBe(true);
  });
  it("does NOT offer inside a wallet's in-app browser", () => {
    expect(shouldOfferInAppBrowser({ ethereum: { isMetaMask: true } }, IPHONE_UA)).toBe(false);
  });
  it("does NOT offer on desktop", () => {
    expect(shouldOfferInAppBrowser({}, DESKTOP_UA)).toBe(false);
  });
});
