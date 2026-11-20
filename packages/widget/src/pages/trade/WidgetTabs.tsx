/**
 * WidgetTabs
 *
 * The widget's in-frame tablist (Trade / Send / Activity / Claims), following
 * the WAI-ARIA tabs pattern with automatic activation: one tab stop (roving
 * tabindex), Left/Right arrows move and select with wrap-around, Home/End jump
 * to the ends. Trade owns the selection and renders the matching tabpanels
 * under the ids from `widgetTabIds`.
 *
 * The same component renders the nested choices inside a tab (Trade’s Swap |
 * Buy | Cash out modes, Send's destination kind), so every level of the widget's
 * navigation moves by the same keys.
 *
 * The id vocabularies are the embed contract's (peer-send-tab addendum), so
 * the frame URL's `initialTab` / `tabs` / `initialMode` / `sendDestinations`
 * can drive this state directly once they are parsed.
 */

import { useRef, type KeyboardEvent } from "react";

/** Top-level tabs, in display order. */
export const WIDGET_TAB_IDS = ["trade", "send", "activity", "claims"] as const;
export type WidgetTabId = (typeof WIDGET_TAB_IDS)[number];

export { TRADE_MODES, SEND_DESTINATIONS as SEND_DESTINATION_KINDS } from "@xochi/widget-lib";
export type { TradeMode, SendDestinationKind } from "@xochi/widget-lib";

export interface WidgetTab<Id extends string = WidgetTabId> {
  id: Id;
  label: string;
  /** Count shown beside the label (e.g. claimable payments); hidden at 0. */
  count?: number;
  /** Spoken after the count, e.g. "ready to claim". */
  countLabel?: string;
}

/** Element ids tying a tab to its panel (aria-controls / aria-labelledby). */
export function widgetTabIds(baseId: string, tab: string): { tab: string; panel: string } {
  return { tab: `${baseId}-tab-${tab}`, panel: `${baseId}-panel-${tab}` };
}

interface WidgetTabsProps<Id extends string> {
  baseId: string;
  tabs: readonly WidgetTab<Id>[];
  active: Id;
  onSelect: (tab: Id) => void;
  /** The tablist's accessible name. */
  label?: string;
  /** Extra classes for a nested tablist (e.g. a mode switch inside a tab). */
  className?: string;
}

export function WidgetTabs<Id extends string = WidgetTabId>({
  baseId,
  tabs,
  active,
  onSelect,
  label = "Widget sections",
  className = "widget-tabs",
}: WidgetTabsProps<Id>) {
  const tabRefs = useRef(new Map<Id, HTMLButtonElement>());

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const current = tabs.findIndex((t) => t.id === active);
    if (current < 0) return;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case "ArrowUp":
      case "ArrowDown": {
        const origin = tabRefs.current.get(active)?.getBoundingClientRect();
        if (!origin) return;
        const direction = e.key === "ArrowUp" ? -1 : 1;
        const candidates = tabs.flatMap(({ id }, index) => {
          const rect = tabRefs.current.get(id)?.getBoundingClientRect();
          if (!rect || direction * (rect.top - origin.top) <= 1) return [];
          return [
            {
              index,
              row: Math.abs(rect.top - origin.top),
              distance: Math.abs(rect.left + rect.width / 2 - origin.left - origin.width / 2),
            },
          ];
        });
        candidates.sort((a, b) => a.row - b.row || a.distance - b.distance);
        if (!candidates[0]) return;
        next = candidates[0].index;
        break;
      }
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = tabs[next].id;
    onSelect(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={`order-type-toggle ${className}`}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const ids = widgetTabIds(baseId, tab.id);
        const count = tab.count ?? 0;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
              else tabRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            className={`type-btn widget-tabs__tab ${selected ? "active" : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {count > 0 && (
              <>
                <span className="claims-nudge__count" aria-hidden="true">
                  {count}
                </span>
                <span className="sr-only">
                  {`, ${count}${tab.countLabel ? ` ${tab.countLabel}` : ""}`}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
