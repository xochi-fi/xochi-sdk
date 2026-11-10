/**
 * The Appearance thumbnails (xochi-widget#37) paint each theme with copies of
 * its tokens, because the configurator page wears one theme and cannot read
 * another's live. This holds every copy to the SHIPPED declaration, so a theme
 * that changes colour cannot leave its thumbnail showing the old one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EMBED_THEME_APP } from "../trade/embedTheme.js";

const read = (f: string): string => readFileSync(new URL(f, import.meta.url), "utf8");
const BASE = read("../../styles/base.css");
const THEMES = read("../../styles/themes.css");
const CONFIGURATOR = read("../../styles/configurator.css");

/** The body of the first `selector { ... }` block. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("\n}", open));
}

const declaration = (body: string, name: string): string | null =>
  new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

const TOKENS = ["obsidian", "panel-bg", "panel-border", "text-emphasis", "muted-gold"];

describe("theme thumbnails", () => {
  it.each(["light", "dim", "contrast"] as const)("paint %s with its shipped tokens", (look) => {
    const app = EMBED_THEME_APP[look];
    const root = block(BASE, ":root");
    const themed = app === "dim" ? null : block(THEMES, `[data-theme="${app}"]`);
    const thumb = block(CONFIGURATOR, `.config-theme__look--${look}`);
    for (const token of TOKENS) {
      const shipped = (themed && declaration(themed, token)) ?? declaration(root, token);
      expect(shipped, `--${token} for ${look}`).not.toBeNull();
      expect(declaration(thumb, `thumb-${token}`), `--thumb-${token} for ${look}`).toBe(shipped);
    }
  });
});
