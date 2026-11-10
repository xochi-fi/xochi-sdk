/**
 * The Layout section (xochi-fi/xochi-widget#38): what the frame leaves out
 * and how tall it is. Every option removes or fixes; none adds to the card.
 * Without a height the frame fits its content (`@xochi/widget-lib`'s
 * `createXochiWidget` resizes the iframe over `xochi:resize`); with one,
 * `createXochiWidget` mounts and keeps the iframe at it and the widget
 * scrolls inside.
 */

import { useId } from "react";
import { EMBED_FRAME, type EmbedLayout } from "@xochi/widget-lib";
import { heightProblem } from "../trade/embedParams.js";

const LAYOUTS: readonly { id: EmbedLayout; name: string; meta: string }[] = [
  { id: "full", name: "Full widget", meta: "Swap, Activity and Claims tabs." },
  {
    id: "swap",
    name: "Swap only",
    meta: "The swap card alone. Stealth payments are claimed on the full widget.",
  },
];

interface LayoutSectionProps {
  layout: EmbedLayout;
  onLayout: (layout: EmbedLayout) => void;
  howItWorks: boolean;
  onHowItWorks: (shown: boolean) => void;
  /** The height as typed, which may be one the frame refuses. */
  heightText: string;
  onHeight: (text: string) => void;
}

export function LayoutSection({
  layout,
  onLayout,
  howItWorks,
  onHowItWorks,
  heightText,
  onHeight,
}: LayoutSectionProps) {
  const layoutName = useId();
  const heightId = useId();
  const heightHintId = useId();
  const error = heightProblem(heightText);
  return (
    <>
      <fieldset className="config-leg">
        <legend className="label">Tabs</legend>
        <div className="config-choices">
          {LAYOUTS.map(({ id, name, meta }) => (
            <label key={id} className="config-choice">
              <input
                type="radio"
                name={layoutName}
                value={id}
                checked={layout === id}
                onChange={() => onLayout(id)}
              />
              <span className="config-choice__name">{name}</span>
              <span className="config-choice__meta">{meta}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="config-leg">
        <legend className="label">Under the card</legend>
        <label className="config-choice">
          <input
            type="checkbox"
            checked={howItWorks}
            onChange={(e) => onHowItWorks(e.target.checked)}
          />
          <span className="config-choice__name">How it works</span>
          <span className="config-choice__meta">The collapsed three-step explainer.</span>
        </label>
      </fieldset>

      <div className="config-field config-field--amount">
        <label htmlFor={heightId} className="label">
          Frame height
        </label>
        <div className="config-amount">
          <input
            id={heightId}
            className="config-input"
            inputMode="numeric"
            autoComplete="off"
            placeholder={`${EMBED_FRAME.height} (standard)`}
            value={heightText}
            aria-invalid={error !== null}
            aria-describedby={heightHintId}
            onChange={(e) => onHeight(e.target.value)}
          />
          <span className="config-amount__unit">px</span>
        </div>
        <p id={heightHintId} className={error ? "config-hint config-hint--error" : "config-hint"}>
          {error ??
            `Empty: ${EMBED_FRAME.height}px. With a fixed height the widget scrolls inside the frame.`}
        </p>
      </div>
    </>
  );
}
