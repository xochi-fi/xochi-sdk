/**
 * The ramp and Send release rules (xochi-sdk#180) live in the shipped CSS:
 * jsdom loads no stylesheet, so this reads ramp.css and send.css and fails
 * when a rule the release checklist relies on is deleted or weakened.
 *
 *   - every Buy button without a class of its own gets a 44px target and a
 *     visible focus ring, and the primary button keeps its look in a route;
 *   - review actions wrap at 200% zoom instead of overflowing the column;
 *   - forced colours keep the chosen rail marked;
 *   - reduced motion drops the rail transition.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ramp = read("./ramp.css");
const send = read("./send.css");

/** Every declaration of every rule (at any depth) whose selector list includes `selector`. */
function declarations(css: string, selector: string): string[] {
  const out: string[] = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = sel.split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    out.push(
      ...body
        .split(";")
        .map((d) => d.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    );
  }
  return out;
}

/** The body of the first `@media <query>` block. */
function media(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  return "";
}

describe("ramp buttons", () => {
  it.each([
    ".onramp-review button:not([class])",
    ".onramp-resume button:not([class])",
    ".onramp-steps button:not([class])",
    ".send-card > button:not([class])",
  ])("%s is a 44px target with a focus ring", (selector) => {
    expect(declarations(ramp, selector)).toContain("min-height: 44px");
  });

  it("rings every Buy control on keyboard focus", () => {
    for (const selector of [
      ".onramp-review button:focus-visible",
      ".onramp-resume button:focus-visible",
      ".onramp-steps button:focus-visible",
    ])
      expect(declarations(ramp, selector)).toContain("outline: 2px solid var(--muted-gold)");
  });

  it("leaves the shared primary button styled inside a route card", () => {
    expect(declarations(ramp, ".ramp-route button")).toEqual([
      "min-height: 44px",
      "max-width: 100%",
    ]);
    expect(declarations(ramp, ".ramp-route button:not(.submit-btn)")).toContain("width: 100%");
  });
});

describe("zoom, contrast and motion", () => {
  it("wraps review actions rather than overflow at 200% zoom", () => {
    expect(declarations(send, ".send-review__actions")).toContain("flex-wrap: wrap");
  });

  it("keeps the chosen rail marked under forced colours", () => {
    expect(
      declarations(
        media(ramp, "(forced-colors: active)"),
        ".ramp-rail--selectable:has(input:checked)",
      ),
    ).toContain("outline: 2px solid Highlight");
  });

  it("drops the rail transition for reduced motion", () => {
    expect(
      declarations(media(ramp, "(prefers-reduced-motion: reduce)"), ".ramp-rail--selectable"),
    ).toContain("transition: none");
  });
});
