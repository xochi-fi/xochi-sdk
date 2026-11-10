/**
 * Whether the frame shows its Activity and Claims tabs (`layout`,
 * xochi-fi/xochi-widget#38). Flow copy that sends the user to a tab reads it:
 * without tabs (`layout=swap`) those places do not exist in the frame, and a
 * claim happens on the full widget, opened in a new tab. Trade provides it;
 * anything rendered outside Trade sees the full widget.
 */

import { createContext, useContext } from "react";

export const WidgetTabsContext = createContext<boolean>(true);

export function useWidgetTabsShown(): boolean {
  return useContext(WidgetTabsContext);
}

/**
 * Whether a frame without tabs claims stealth payments outside the widget
 * (decided 2026-10-31): its wallet is the host page's, lent over
 * `@xochi/widget-lib`, which a tab of the widget's own cannot reach, so the
 * full widget opened there could not claim. The frame then offers no Claim
 * payment and says where to claim instead (`CLAIM_IN_XOCHI_APP`). Trade
 * provides it; anything outside Trade claims in the widget.
 */
export const ClaimInXochiAppContext = createContext<boolean>(false);

export function useClaimInXochiApp(): boolean {
  return useContext(ClaimInXochiAppContext);
}

/** Where a host-wallet frame sends a stealth recipient to claim. */
export const CLAIM_IN_XOCHI_APP = "Claim it in the Xochi app with the receiving wallet.";
