/**
 * The settings list (xochi-fi/xochi-widget#35): one row per section with a
 * summary of its current value, and a sub-panel each row drills into.
 */

import { useEffect, useId, useRef, type ReactNode, type Ref } from "react";
import { Chevron } from "../../components/Chevron.js";

interface SettingsRowProps {
  title: string;
  /** The section's current value, in words. */
  summary: string;
  onOpen: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** A row that opens its section. Its accessible name is title then summary. */
export function SettingsRow({ title, summary, onOpen, ref }: SettingsRowProps) {
  return (
    <li>
      <button ref={ref} type="button" className="config-row" onClick={onOpen}>
        <span className="config-row__title">{title}</span>
        <span className="config-row__summary">{summary}</span>
        <Chevron className="config-row__chevron" />
      </button>
    </li>
  );
}

interface SettingsPanelProps {
  title: string;
  onBack: () => void;
  children: ReactNode;
}

/**
 * One section's options. Opening it moves focus to its heading, so a screen
 * reader announces where the user landed.
 */
export function SettingsPanel({ title, onBack, children }: SettingsPanelProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <section className="config-sub" aria-labelledby={headingId}>
      <div className="config-sub__head">
        <button
          type="button"
          className="config-back"
          onClick={onBack}
          aria-label="Back to all settings"
        >
          <Chevron className="config-back__chevron" />
        </button>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="config-sub__title">
          {title}
        </h2>
      </div>
      <div className="config-sub__body">{children}</div>
    </section>
  );
}
