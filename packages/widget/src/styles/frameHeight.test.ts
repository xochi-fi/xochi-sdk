/**
 * A fixed frame height (`height=<px>`, xochi-fi/xochi-widget#38) is kept by
 * launch.css alone: the widget scrolls inside itself and the document never
 * does. jsdom loads no stylesheet, so frameLayout.test.tsx can only see the
 * class; this reads the SHIPPED rules, so deleting or weakening one fails here
 * instead of handing hosts an outer scrollbar.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./launch.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration of every rule whose selector list is exactly `selector`. */
function declarations(selector: string): string[] {
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

describe("fixed frame height (launch.css)", () => {
  it("scrolls the widget inside itself, capped to the frame", () => {
    const fixed = declarations(".launch-screen--fixed");
    expect(fixed).toContain("overflow-y: auto");
    expect(fixed).toContain("box-sizing: border-box");
    // vh first, for browsers without dvh: the later declaration wins where known.
    expect(fixed.indexOf("max-height: 100vh")).toBeGreaterThanOrEqual(0);
    expect(fixed.indexOf("max-height: 100dvh")).toBeGreaterThan(fixed.indexOf("max-height: 100vh"));
  });

  it("never scrolls the document", () => {
    expect(declarations("html:has(.launch-screen--fixed)")).toContain("overflow: hidden");
    expect(declarations("html:has(.launch-screen--fixed) body")).toContain("overflow: hidden");
  });

  it("lets the portaled flow modal scroll on its own", () => {
    expect(declarations("html:has(.launch-screen--fixed) .modal-overlay")).toContain(
      "overflow-y: auto",
    );
  });
});
