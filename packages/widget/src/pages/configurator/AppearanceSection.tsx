/**
 * The Appearance section (xochi-fi/xochi-widget#37): the frame's theme, as a
 * preset per theme the app already ships (src/styles/themes.css). Custom
 * colours with a contrast floor are xochi-fi/xochi#581, not here.
 *
 * Each thumbnail is a miniature card painted with its theme's own tokens,
 * copied into configurator.css (the configurator page wears one theme, so it
 * cannot read another's live); themeThumbs.test.ts holds the copies to the
 * shipped values.
 */

import { useId } from "react";
import { EMBED_THEMES, type EmbedTheme } from "@xochi/widget-lib";

/** Each preset's name and what it looks like, for its card and its row. */
export const THEME_PRESET: Record<EmbedTheme, { name: string; meta: string }> = {
  auto: { name: "Auto", meta: "Follows the visitor's system: light or dim." },
  light: { name: "Light", meta: "Warm off-white with dark text." },
  dim: { name: "Dim", meta: "Soft dark, Xochi's default." },
  contrast: { name: "High contrast", meta: "True black and pure white text." },
};

/**
 * The looks a thumbnail shows: one theme, or for `auto` the two the system
 * can pick between, each painting half of the same card.
 */
const THUMB_LOOKS: Record<EmbedTheme, readonly ("dim" | "light" | "contrast")[]> = {
  auto: ["dim", "light"],
  light: ["light"],
  dim: ["dim"],
  contrast: ["contrast"],
};

interface AppearanceSectionProps {
  theme: EmbedTheme;
  onTheme: (theme: EmbedTheme) => void;
}

export function AppearanceSection({ theme, onTheme }: AppearanceSectionProps) {
  const name = useId();
  return (
    <fieldset className="config-leg">
      <legend className="label">Theme</legend>
      <div className="config-themes">
        {EMBED_THEMES.map((id) => (
          <label key={id} className="config-theme">
            <input
              type="radio"
              name={name}
              value={id}
              checked={theme === id}
              onChange={() => onTheme(id)}
            />
            <span className="config-theme__thumb" aria-hidden="true">
              {THUMB_LOOKS[id].map((look) => (
                <span key={look} className={`config-theme__look config-theme__look--${look}`}>
                  <span className="config-theme__card">
                    <span className="config-theme__bar" />
                    <span className="config-theme__bar config-theme__bar--short" />
                    <span className="config-theme__cta" />
                  </span>
                </span>
              ))}
            </span>
            <span className="config-theme__name">{THEME_PRESET[id].name}</span>
            <span className="config-theme__meta">{THEME_PRESET[id].meta}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
