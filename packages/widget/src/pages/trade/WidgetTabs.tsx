/**
 * WidgetTabs
 *
 * The widget's in-frame tablist (Swap / Activity / Claims), following the
 * WAI-ARIA tabs pattern with automatic activation: one tab stop (roving
 * tabindex), Left/Right arrows move and select with wrap-around, Home/End jump
 * to the ends. Trade owns the selection and renders the matching tabpanels
 * under the ids from `widgetTabIds`.
 */

import { useRef, type KeyboardEvent } from "react";

export type WidgetTabId = "swap" | "activity" | "claims";

export interface WidgetTab {
  id: WidgetTabId;
  label: string;
  /** Count shown beside the label (e.g. claimable payments); hidden at 0. */
  count?: number;
  /** Spoken after the count, e.g. "ready to claim". */
  countLabel?: string;
}

/** Element ids tying a tab to its panel (aria-controls / aria-labelledby). */
export function widgetTabIds(baseId: string, tab: WidgetTabId): { tab: string; panel: string } {
  return { tab: `${baseId}-tab-${tab}`, panel: `${baseId}-panel-${tab}` };
}

interface WidgetTabsProps {
  baseId: string;
  tabs: readonly WidgetTab[];
  active: WidgetTabId;
  onSelect: (tab: WidgetTabId) => void;
}

export function WidgetTabs({ baseId, tabs, active, onSelect }: WidgetTabsProps) {
  const tabRefs = useRef(new Map<WidgetTabId, HTMLButtonElement>());

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const current = tabs.findIndex((t) => t.id === active);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + tabs.length) % tabs.length;
        break;
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
      aria-label="Widget sections"
      className="order-type-toggle widget-tabs"
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
