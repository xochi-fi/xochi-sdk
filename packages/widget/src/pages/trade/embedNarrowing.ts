/**
 * Which tabs, Trade modes and Send destinations the frame offers, from the
 * host's embed parameters (`readWidgetEmbedConfig`).
 *
 * Narrowing only removes surfaces; it never adds one or makes a rail usable
 * (live Peer data alone decides that, in ramp/availability). A surface goes
 * when the host leaves it out, and also when what it depends on is gone:
 *
 *   - `rampProviders` without `peer` removes Buy and Cash out
 *     modes (Peer is the only ramp provider);
 *   - Stealth send hands its order to the Swap card, so it goes with Swap;
 *   - Trade with no mode left, or Send with no destination left, goes too.
 *
 * `initialTab` / `initialMode` pick among what is left and fall back to the
 * usual defaults (Trade, Swap) when they name something that is not.
 */

import type { WidgetEmbedConfig } from "../../config.js";
import {
  SEND_DESTINATION_KINDS,
  TRADE_MODES,
  WIDGET_TAB_IDS,
  type SendDestinationKind,
  type TradeMode,
  type WidgetTabId,
} from "./WidgetTabs.js";

export interface WidgetSurfaces {
  /** Tabs the host allows, in display order. Claims still needs its own live conditions. */
  tabs: readonly WidgetTabId[];
  modes: readonly TradeMode[];
  destinations: readonly SendDestinationKind[];
  initialTab: WidgetTabId | undefined;
  initialMode: TradeMode | undefined;
  initialDestination: SendDestinationKind | undefined;
}

export function widgetSurfaces(embed: WidgetEmbedConfig = {}): WidgetSurfaces {
  const peer = embed.rampProviders === undefined || embed.rampProviders.includes("peer");
  const allowedTabs: readonly string[] = embed.tabs ?? WIDGET_TAB_IDS;
  const modes = allowedTabs.includes("trade")
    ? TRADE_MODES.filter((m) => (embed.modes ?? TRADE_MODES).includes(m) && (m === "swap" || peer))
    : [];
  const destinations = allowedTabs.includes("send")
    ? SEND_DESTINATION_KINDS.filter(
        (k) =>
          (embed.sendDestinations ?? SEND_DESTINATION_KINDS).includes(k) &&
          (k !== "stealth" || modes.includes("swap")),
      )
    : [];
  const tabs = WIDGET_TAB_IDS.filter(
    (t) =>
      allowedTabs.includes(t) &&
      (t !== "trade" || modes.length > 0) &&
      (t !== "send" || destinations.length > 0),
  );
  const firstTab = tabs.find((t) => t !== "claims");
  return {
    tabs,
    modes,
    destinations,
    initialTab:
      embed.initialTab !== undefined && tabs.includes(embed.initialTab)
        ? embed.initialTab
        : firstTab,
    initialMode:
      embed.initialMode !== undefined && modes.includes(embed.initialMode)
        ? embed.initialMode
        : modes.includes("swap")
          ? "swap"
          : modes[0],
    initialDestination: destinations[0],
  };
}
