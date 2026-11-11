// @vitest-environment jsdom

/**
 * Pair gating and FX readiness (trade-widget-mvp.md, Phase 7).
 *
 * The availability LOGIC (three states, unsupported outranks locked, the
 * injectable requirements table, the FX seam) is unit-tested directly in
 * src/lib/pairAvailability.test.ts. This file used to pin the RENDERING half as
 * source text -- `readFileSync("../../components/TokenSearchModal.tsx")` plus
 * `toContain("aria-disabled={!selectable}")` and friends. Every one of those
 * passed while the row was wired to a live handler, i.e. while a blocked pair
 * was still selectable, which is the only failure that matters here. They are
 * replaced by renders of the real sheet that click the real rows.
 *
 * What must stay true:
 *   - The three states are distinct in text AND glyph, never colour alone:
 *     available rows carry the chevron, blocked rows carry the lock/slash glyph
 *     plus a badge, and the two blocked states never collapse into one grey row.
 *   - Blocked rows stay reachable (aria-disabled, not disabled -- they are still
 *     focusable) and their state text rides the row's accessible name via the
 *     hint line that replaces the token name.
 *   - Only an available row can be chosen, on pointer AND on keyboard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent } from "@testing-library/react";
import { renderTrade, apiStub } from "./harness.js";
import { TokenSearchModal } from "../../components/TokenSearchModal.js";
import { PAIR_GLYPH } from "../../lib/glyphs.js";
import type { Token } from "../../types/intent.js";
import type { PairAvailability } from "../../lib/pairAvailability.js";
import { findTokenBySymbol } from "./config.js";

const BASE = 8453;

/**
 * jsdom has no layout, so `Element.prototype.scrollIntoView` does not exist and
 * the sheet's keep-the-focused-row-in-view effect throws on mount. Platform
 * gap, not app behaviour: a no-op is what a headless browser would do anyway.
 */
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface SheetProps {
  allowedSymbols?: readonly string[];
  trustScore?: number;
  advertisedSymbols?: readonly string[];
  onSelect?: (token: Token) => void;
}

const configuredToken = (symbol: string): Token => {
  const found = findTokenBySymbol(BASE, symbol);
  if (!found) throw new Error(`${symbol} missing on Base`);
  return found;
};

const openSheet = ({
  allowedSymbols = ["USDC", "USDT"],
  trustScore = 0,
  advertisedSymbols = ["USDC", "USDT"],
  onSelect = () => {},
}: SheetProps = {}) => {
  const tokens = advertisedSymbols.map(configuredToken);
  const classify = (candidate: Token): PairAvailability =>
    !allowedSymbols.includes(candidate.symbol)
      ? { state: "unsupported", reason: `${candidate.symbol} can't be traded on this route.` }
      : trustScore < 0
        ? { state: "trust_locked", requiredScore: 0, requiredTier: "Standard" }
        : { state: "available" };

  return renderTrade(
    <TokenSearchModal
      open
      onClose={() => {}}
      onSelect={onSelect}
      chainIds={[BASE]}
      initialChainId={BASE}
      tokensByChain={new Map([[BASE, tokens]])}
      classify={classify}
    />,
  );
};

/** The "All tokens" rows only -- the Popular chips repeat symbols. */
const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".token-search-list .token-search-row"));

const row = (symbol: string): HTMLElement => {
  const found = rows().find(
    (el) => el.querySelector(".token-search-row-symbol")?.textContent === symbol,
  );
  if (!found) throw new Error(`no ${symbol} row; rendered: ${rows().length} rows`);
  return found;
};

const text = (symbol: string): string => row(symbol).textContent ?? "";

describe("three states, distinct in text and glyph", () => {
  it("gives each state its own glyph", () => {
    // Three distinct markers; a collision would collapse two states into one
    // shape, which is the exact failure the classifier exists to prevent.
    const glyphs = [PAIR_GLYPH.available, PAIR_GLYPH.locked, PAIR_GLYPH.unsupported];
    expect(new Set(glyphs).size).toBe(3);
  });

  it("draws an unsupported row apart from an available one, in words and glyph", async () => {
    // USDT is advertised by the route model but blocked for this opposite leg,
    // so it remains visible and explanatory. WETH is not advertised at all.
    await openSheet({ allowedSymbols: ["USDC"] });

    expect(text("USDC")).toContain("USD Coin");
    expect(text("USDC")).toContain(PAIR_GLYPH.available);
    expect(text("USDC")).not.toContain(PAIR_GLYPH.unsupported);

    // The hint takes the name slot, so the state is readable text, not a colour.
    expect(text("USDT")).toContain("USDT can't be traded");
    expect(text("USDT")).toContain("Unavailable");
    expect(text("USDT")).toContain(PAIR_GLYPH.unsupported);
    expect(text("USDT")).not.toContain(PAIR_GLYPH.available);
  });

  it("does not render a token absent from the injected capability inventory", async () => {
    await openSheet();
    expect(rows().some((candidate) => candidate.textContent?.includes("WETH"))).toBe(false);
  });

  it("keeps trust-locked distinct from unsupported rather than one grey row", async () => {
    // A below-floor score is the only way to reach the locked branch through
    // the component today: SYMBOL_TRUST_REQUIREMENT is deliberately empty
    // (every live pair is open at Standard, xochi#433), so no realistic score
    // locks anything. The branch is real rendering code and stays untested by
    // any render otherwise -- the shape this repo has shipped before. The day
    // an FX asset lands with a requirement, this becomes an ordinary case.
    await openSheet({ allowedSymbols: ["USDC"], trustScore: -1 });

    // Locked names the target ("locked" with no target is the bare 0/100
    // problem again) and unsupported says no user action helps.
    expect(text("USDC")).toContain("Reach Standard (0) to trade USDC");
    expect(text("USDC")).toContain(PAIR_GLYPH.locked);
    expect(text("USDT")).toContain(PAIR_GLYPH.unsupported);
    // Distinguishable from each other, not merely from available.
    expect(text("USDC")).not.toContain(PAIR_GLYPH.unsupported);
    expect(text("USDT")).not.toContain(PAIR_GLYPH.locked);
    expect(text("USDC")).not.toContain(PAIR_GLYPH.available);
  });
});

describe("token dialog focus", () => {
  it("focuses and traps keyboard navigation inside the opened portal", async () => {
    await openSheet();
    const dialog = screen.getByRole("dialog", { name: "Select token" });
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) throw new Error("token dialog has no focusable controls");

    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});

describe("blocked rows are information, not holes", () => {
  it("stays focusable via aria-disabled, with the state text in its accessible name", async () => {
    await openSheet({ allowedSymbols: ["USDC"] });

    // Queried BY the state text: if the hint ever stops riding the accessible
    // name, this lookup fails before any attribute is inspected.
    const blocked = screen.getByRole("button", { name: /USDT can't be traded/ });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    // `disabled` would drop the row from the tab order and suppress its title,
    // putting the reason somewhere nobody can reach -- the whole point of
    // showing blocked pairs instead of filtering them.
    expect(blocked.hasAttribute("disabled")).toBe(false);
    blocked.focus();
    expect(document.activeElement).toBe(blocked);

    expect(row("USDC").getAttribute("aria-disabled")).toBe("false");
  });
});

describe("only an available row can be chosen", () => {
  it("selects the token on click", async () => {
    const onSelect = vi.fn();
    await openSheet({ allowedSymbols: ["USDC"], onSelect });

    fireEvent.click(row("USDC"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ symbol: "USDC", chainId: BASE });
  });

  it("refuses the click on either blocked state", async () => {
    const onSelect = vi.fn();
    await openSheet({ allowedSymbols: ["USDC"], trustScore: -1, onSelect });

    fireEvent.click(row("USDT")); // unsupported
    fireEvent.click(row("USDC")); // trust-locked
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("gates the keyboard on the same rule as the pointer", async () => {
    // Arrow keys land on blocked rows on purpose (they stay in the list), so
    // Enter there must refuse exactly like the click path. A gate on the click
    // handler alone leaves the keyboard able to construct an unfillable pair.
    const onSelect = vi.fn();
    await openSheet({ allowedSymbols: ["USDC"], onSelect });

    fireEvent.mouseEnter(row("USDT"));
    fireEvent.keyDown(row("USDT"), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.mouseEnter(row("USDC"));
    fireEvent.keyDown(row("USDC"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ symbol: "USDC" });
  });
});
