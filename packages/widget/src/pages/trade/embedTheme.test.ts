// @vitest-environment jsdom

/**
 * The pieces main.tsx applies before the frame chunk loads (xochi-widget#37):
 * the app theme each frame theme maps to, and the attribute itself.
 */

import { describe, it, expect, afterEach } from "vitest";
import { EMBED_THEME_APP } from "./embedTheme.js";
import { applyTheme } from "../../hooks/applyTheme.js";

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("pre-paint theme", () => {
  it("puts each fixed theme on <html>, dim as the attribute's absence", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme(EMBED_THEME_APP.contrast ?? "dim");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("dim");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
