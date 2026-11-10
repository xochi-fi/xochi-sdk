import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Drift guard for the mobile "death spiral": full-viewport fixed decorative
// overlays must set `pointer-events: none`, or they sit on top of the page and
// swallow every click/touch (the whitepaper TOC links became unclickable on
// mobile because `.pearl-bg` was the one overlay missing this). pointer-events
// is independent of z-index, so a decorative layer with default pointer-events
// intercepts taps regardless of stacking order.

const BASE_CSS = join(fileURLToPath(new URL(".", import.meta.url)), "base.css");

// Decorative, non-interactive layers that cover the viewport (position: fixed;
// inset: 0). None of these should ever capture pointer events.
const DECORATIVE_OVERLAYS = [".pearl-bg", ".dark-overlay", ".ripple-bg"];

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} not found in base.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

describe("full-viewport decorative overlays", () => {
  const css = readFileSync(BASE_CSS, "utf-8");

  it.each(DECORATIVE_OVERLAYS)("%s does not capture pointer events", (selector) => {
    const body = ruleBody(css, selector);
    // sanity: confirm it really is a full-viewport fixed layer
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/inset:\s*0/);
    expect(body, `${selector} must set pointer-events: none`).toMatch(/pointer-events:\s*none/);
  });
});
