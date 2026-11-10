/**
 * Get code (xochi-fi/xochi-widget#36): the footer of the options column, with
 * the public widget library as HTML or React, or the frame URL as a fallback.
 *
 * The code is written on this page's own origin, so a staging or preview build
 * hands out code for itself. Anywhere but production that is said next to Copy.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { EmbedParams } from "@xochi/widget-lib";
import { Chevron } from "../../components/Chevron.js";
import { CODE_FORMATS, codeFor, type CodeFormat } from "./snippets.js";
import { codeShownByDefault } from "./codeShown.js";

/** Where the production widget is served. */
export const PRODUCTION_HOST = "widget.xochi.fi";

/** How long the Copied confirmation stays. */
const COPIED_MS = 2000;

interface CodeDockProps {
  /** The widget origin and complete public params the preview is showing. */
  origin: string;
  params: EmbedParams;
  /** The host the widget is served from, for the embedding note. */
  host: string;
}

export function CodeDock({ origin, params, host }: CodeDockProps) {
  const headingId = useId();
  const tabIdBase = useId();
  const panelId = useId();
  const bodyId = useId();
  const [codeShown, setCodeShown] = useState(codeShownByDefault);
  const [format, setFormat] = useState<CodeFormat>("html");
  const tabRefs = useRef<Partial<Record<CodeFormat, HTMLButtonElement | null>>>({});
  const code = codeFor(format, origin, params);
  const active = CODE_FORMATS.find((f) => f.id === format) ?? CODE_FORMATS[0];

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => setCopyState("idle"), [code]);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copyState]);
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch (error) {
      console.error("[configurator] copying the embed code failed:", error);
      setCopyState("failed");
    }
  };

  // Arrow keys move between tabs (WAI-ARIA tabs, automatic activation).
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = CODE_FORMATS.findIndex((f) => f.id === format);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null;
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? CODE_FORMATS.length - 1
          : step === null
            ? null
            : (index + step + CODE_FORMATS.length) % CODE_FORMATS.length;
    if (target === null) return;
    event.preventDefault();
    const next = CODE_FORMATS[target].id;
    setFormat(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="config-dock" aria-labelledby={headingId}>
      <div className="config-dock__head">
        <h2 id={headingId} className="config-dock__title">
          <button
            type="button"
            className="config-dock__toggle"
            aria-expanded={codeShown}
            aria-controls={bodyId}
            onClick={() => setCodeShown((shown) => !shown)}
          >
            Get code
            <Chevron open={codeShown} />
          </button>
        </h2>
        <div className="config-dock__tools">
          <div className="config-tabs" role="tablist" aria-label="Code format">
            {CODE_FORMATS.map((f) => (
              <button
                key={f.id}
                ref={(el) => {
                  tabRefs.current[f.id] = el;
                }}
                type="button"
                role="tab"
                id={`${tabIdBase}-${f.id}`}
                className="config-tab"
                aria-selected={f.id === format}
                aria-controls={panelId}
                tabIndex={f.id === format ? 0 : -1}
                onClick={() => setFormat(f.id)}
                onKeyDown={onTabKey}
              >
                {f.tab}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={copyState === "copied" ? "config-copy config-copy--done" : "config-copy"}
            onClick={handleCopy}
          >
            {copyState === "copied" ? (
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path
                  d="M2 6.5 4.75 9 10 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
            {copyState === "copied" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {host === PRODUCTION_HOST ? null : (
        <p className="config-dock__notice">Non-production: snippets point at {host}.</p>
      )}

      <div id={bodyId} className="config-dock__body" hidden={!codeShown}>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${tabIdBase}-${format}`}
          className="config-dock__panel"
        >
          <pre className="config-code" aria-label={active.label} tabIndex={0}>
            <code>{code}</code>
          </pre>
        </div>
        <p className="config-hint">
          Loads only on approved sites. To add yours, email{" "}
          <a href="mailto:hello@xochi.fi?subject=Widget%20embedding">hello@xochi.fi</a>.
        </p>
      </div>
      <p
        className={copyState === "failed" ? "config-hint config-hint--error" : "sr-only"}
        role="status"
      >
        {copyState === "copied"
          ? `${active.label} copied`
          : copyState === "failed"
            ? "Couldn't copy. Select the code and copy it by hand."
            : ""}
      </p>
    </section>
  );
}
