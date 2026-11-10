// @vitest-environment jsdom

/**
 * The frame's theme (xochi-widget#37): a `theme` parameter fixes it, and
 * without one the frame resolves it as it always has, following the system.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getTheme, useResolvedTheme, useTheme, type AppTheme } from "./useTheme.js";
import { STORAGE_KEYS } from "../constants.js";

/** A system colour scheme the test can flip, with its change listeners. */
function stubSystem(prefersLight: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { light: prefersLight };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("light") && state.light;
    },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  }));
  return {
    flip(light: boolean): void {
      state.light = light;
      act(() => listeners.forEach((fn) => fn({ matches: light })));
    },
  };
}

const applied = (): string | undefined => document.documentElement.dataset.theme;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("useTheme", () => {
  it("follows the system when no theme is fixed", () => {
    const system = stubSystem(false);
    renderHook(() => useTheme());
    expect(applied()).toBeUndefined();
    system.flip(true);
    expect(applied()).toBe("light");
  });

  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["dim", undefined],
  ] as [AppTheme, string | undefined][])(
    "applies a fixed %s theme over the system and a stored choice",
    (fixed, attribute) => {
      localStorage.setItem(STORAGE_KEYS.theme, fixed === "light" ? "dark" : "light");
      const system = stubSystem(fixed !== "light");
      renderHook(() => useTheme(fixed));
      expect(applied()).toBe(attribute);
      system.flip(fixed === "light");
      expect(applied()).toBe(attribute);
      expect(getTheme(fixed)).toBe(fixed);
    },
  );

  it("resolves the current system preference immediately when returning to auto", () => {
    const system = stubSystem(false);
    const { rerender } = renderHook(({ fixed }: { fixed: AppTheme | null }) => useTheme(fixed), {
      initialProps: { fixed: "dark" as AppTheme | null },
    });
    system.flip(true);
    expect(applied()).toBe("dark");
    rerender({ fixed: null });
    expect(applied()).toBe("light");
    system.flip(false);
    expect(applied()).toBeUndefined();
  });

  it("shares live standalone resolution with consumers such as wallet dialogs", () => {
    const system = stubSystem(false);
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dim");
    system.flip(true);
    expect(result.current).toBe("light");
  });

  it("respects a saved choice when returning from a fixed theme to auto", () => {
    stubSystem(true);
    localStorage.setItem(STORAGE_KEYS.theme, "dim");
    const { rerender } = renderHook(({ fixed }: { fixed: AppTheme | null }) => useTheme(fixed), {
      initialProps: { fixed: "dark" as AppTheme | null },
    });
    rerender({ fixed: null });
    expect(applied()).toBeUndefined();
  });
});
