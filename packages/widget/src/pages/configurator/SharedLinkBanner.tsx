/**
 * The shared-link notice (xochi-fi/xochi-widget#47). A configurator link can
 * preset what the widget opens on (an amount, stealth settlement), and an
 * integrator who copies the code straight away ships those presets to their
 * own users. So a page opened with widget options in its URL says which, until
 * dismissed.
 */

import { useId } from "react";
import { EMBED_PARAM, type EmbedParams } from "@xochi/widget-lib";

/** The link's widget presets as `key=value`, in the frame's parameter order. */
export function sharedPresets(params: EmbedParams): string[] {
  return (Object.keys(EMBED_PARAM) as (keyof typeof EMBED_PARAM)[]).flatMap((field) => {
    const value = params[field];
    if (value === undefined) return [];
    // As the URL spells it: a flag is 1 or 0.
    return [`${EMBED_PARAM[field]}=${typeof value === "boolean" ? Number(value) : value}`];
  });
}

interface SharedLinkBannerProps {
  presets: readonly string[];
  onDismiss: () => void;
}

export function SharedLinkBanner({ presets, onDismiss }: SharedLinkBannerProps) {
  const titleId = useId();
  return (
    <section className="config-shared" aria-labelledby={titleId}>
      <div className="config-shared__text">
        <h2 id={titleId} className="config-shared__title">
          Opened from a shared link
        </h2>
        <p>These presets go into the code. Check them before copying:</p>
        <ul className="config-shared__presets">
          {presets.map((preset) => (
            <li key={preset}>
              <code>{preset}</code>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="config-shared__dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
