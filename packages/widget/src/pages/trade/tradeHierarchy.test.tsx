// @vitest-environment jsdom

/**
 * One dominant trade surface (trade-widget-mvp.md, Phase 2).
 *
 * These were source-text assertions -- `readFileSync("../Trade.tsx")` plus
 * `indexOf("<SwapPanel") < indexOf("<AssetsStrip")` and friends. Page order
 * inferred from byte offsets in a file is not page order: a landmark moved
 * inside a conditional, a wrapper re-parented, or a component that renders
 * null still reads as "in the right place" to `indexOf`, and a Prettier
 * rewrap or a rename breaks it while the page is identical. They are replaced
 * here by renders that read the real DOM, so what is pinned is the layout a
 * user actually meets.
 *
 * What must stay true:
 *   - The trade card comes first; balances, activity, and trust/claims all
 *     follow it, in that order (Swap, Activity, Claims tab panels).
 *   - One contextual wallet action (the form CTA). The connected wallet's
 *     account chip renders nothing while disconnected. The standalone
 *     WalletLinkPrompt banner and the AssetsStrip disconnected connect prompt
 *     were both retired for repeating it; the strip renders nothing at all
 *     without a wallet.
 *   - The claims row appears only while a settlement is actually claimable.
 *   - The assurance copy lives inside the collapsed "How it works" explainer,
 *     scoped to the order, and never claims a swap is "never broadcast".
 *   - A token field is sibling controls, never a button inside a button.
 *   - Chain context is text, not an unlabeled icon, on both token fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { EXTENDED_CHAIN_NAMES } from "@xochi/client";
import { renderTrade, apiStub, TEST_ACCOUNT } from "./harness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "./embedParams.js";
import { SwapPanel } from "./SwapPanel.js";
import { TokenSelector } from "./Selectors.js";
import { AssetsStrip } from "../../components/AssetsStrip.js";
import { DEFAULT_CHAIN_ID, DEFAULT_TO_CHAIN_ID, findTokenBySymbol } from "./config.js";
import { STORAGE_KEYS } from "../../constants.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

// Longest test: "shows the claims row while a settlement is claimable" -- one
// `renderTrade` of the whole page plus one wait, so 1 render and 1 wait. That
// wait is the `findByRole` for the claims row, which took RTL's 1000ms default
// while the page was still connecting the wallet and serving /api/settlement.
// Every other test here renders once and waits not at all.
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 1 }) });

beforeEach(() => {
  // No endpoint stubbed by default: capabilities degrade to
  // FALLBACK_CAPABILITIES and nothing else is served, which is the state every
  // layout assertion below is about (order does not depend on server data).
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

/**
 * The four page landmarks, in the order Phase 2 requires. Read from one
 * `querySelectorAll`, which returns document order, so the assertions compare
 * rendered position instead of source position.
 */
const LANDMARKS = [
  { name: "trade card", selector: ".trade-card" },
  { name: "holdings strip", selector: ".assets-strip" },
  { name: "activity feed", selector: ".launch-txlog" },
  { name: "trust/claims", selector: '[aria-label="Private receiving"]' },
] as const;

const LANDMARK_QUERY = LANDMARKS.map((l) => l.selector).join(", ");

/** Names of the landmarks present, in document order. */
const pageOrder = (root: ParentNode): string[] =>
  [...root.querySelectorAll(LANDMARK_QUERY)].map(
    (el) => LANDMARKS.find((l) => el.matches(l.selector))?.name ?? "unknown",
  );

/** Every control on screen that asks the user for a wallet. */
// The settlement-mode buttons are excluded: an unavailable mode's one line can
// name its fix ("Connect a wallet" on Stealth), but the button is the mode
// toggle, not a wallet action, and tapping it never opens the connect modal.
const walletAsks = (root: ParentNode): string[] =>
  [...root.querySelectorAll("button")]
    .filter((b) => !b.closest('[aria-label="Settlement privacy"]'))
    .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
    .filter((label) => /connect|link .*wallet|sign in/i.test(label));

describe("widget-first page order", () => {
  // One render, not three: mounting the whole page with a connected wallet is
  // the slowest thing in this file, and the four landmarks are one fact.
  it("renders the trade card first, then balances, activity, trust/claims", async () => {
    const { container } = await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    const order = pageOrder(container);

    // Guard first: without it every ordering assertion below would pass
    // vacuously on a page that rendered two of the four.
    expect([...order].sort()).toEqual(LANDMARKS.map((l) => l.name).sort());

    const at = (name: string): number => order.indexOf(name);
    expect(at("trade card")).toBeLessThan(at("holdings strip"));
    expect(at("trade card")).toBeLessThan(at("activity feed"));
    expect(at("trade card")).toBeLessThan(at("trust/claims"));
    expect(at("activity feed")).toBeLessThan(at("trust/claims"));

    // Independent of DOM nesting: compareDocumentPosition answers "which
    // comes first in the document" even if a landmark is re-parented into a
    // wrapper, where a shared-parent index comparison would not.
    const activity = container.querySelector(".launch-txlog");
    const trust = container.querySelector('[aria-label="Private receiving"]');
    expect(
      activity!.compareDocumentPosition(trust!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("one contextual wallet action", () => {
  it("renders nothing at all when no wallet is connected", async () => {
    // The strip's old internal connect prompt is retired, not just bypassed by
    // Trade.tsx's mount gate: mounted directly and disconnected it must render
    // no node, so it cannot regrow a wallet ask of its own.
    //
    // Measured in a slot of our own because the harness's ToastProvider always
    // renders its own live region as a sibling -- asserting on `container`
    // would be asserting about the harness.
    await renderTrade(
      <div data-testid="strip-slot">
        <AssetsStrip />
      </div>,
    );
    const slot = screen.getByTestId("strip-slot");
    expect(slot.childElementCount).toBe(0);
    expect(slot.textContent).toBe("");
  });

  it("leaves exactly one wallet ask on the disconnected page", async () => {
    // The standalone WalletLinkPrompt banner is gone, so the form CTA is the
    // page's only ask. Counted from rendered controls: a banner reintroduced
    // under any name fails this, which a `not.toMatch(/WalletLinkPrompt/)` on
    // the source could not.
    const { container } = await renderTrade(<Trade look={FULL_LOOK} />);
    expect(walletAsks(container)).toHaveLength(1);
    // And it is the form's own CTA, inside the card -- not a separate banner.
    const cta = container.querySelector(".trade-card .submit-btn");
    expect(cta?.textContent).toMatch(/connect/i);
  });

  it("shows no holdings strip on the disconnected page", async () => {
    const { container } = await renderTrade(<Trade look={FULL_LOOK} />);
    expect(container.querySelector(".assets-strip")).toBeNull();
  });
});

describe("claims surface after the card", () => {
  /**
   * `claimableCount` comes from `useSettlements` -> `GET /api/settlement`,
   * which is wallet-session gated: with no session the hook skips the request
   * and reports 0. Both inputs are platform state, so the row is driven from
   * outside -- a seeded sessionStorage token plus a stubbed endpoint -- with no
   * hook faked.
   *
   * Returns a promise that settles once the endpoint has been served, which is
   * the synchronization point the absence case needs: "the row stayed away
   * after the answer arrived", not "the row had not rendered yet".
   */
  const withSettlements = (statuses: string[]): Promise<void> => {
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "harness-wallet-session", wallet: TEST_ACCOUNT.toLowerCase() }),
    );
    const stub = apiStub({
      "/api/settlement": { body: { settlements: statuses.map((status) => ({ status })) } },
      "/api/intent/history": { body: { orders: [], hasMore: false } },
    });
    let served: () => void = () => {};
    const wasServed = new Promise<void>((resolve) => {
      served = resolve;
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/settlement")) served();
      return stub(input, init);
    });
    return wasServed;
  };

  it("shows the claims row while a settlement is claimable", async () => {
    withSettlements(["claimable"]);
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    const row = await screen.findByRole("button", { name: /ready to claim/ }, WAIT);
    expect(row.textContent).toContain("1");
    expect(row.textContent).toContain("payment is ready to claim");
  });

  it("hides the claims row when nothing is waiting", async () => {
    const wasServed = withSettlements(["claimed", "pending"]);
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    // act() flushes the state update the served response queued, so this is
    // a settled page and not a race we happened to win.
    await act(async () => {
      await wasServed;
    });
    expect(screen.queryByRole("button", { name: /ready to claim/ })).toBeNull();
  });
});

describe("assurance copy lives in How it works", () => {
  const custody = (): HTMLElement | null => screen.queryByText(/No deposits, no account\./);
  const explainerToggle = (): HTMLElement => screen.getByRole("button", { name: /How it works/ });

  it("keeps the custody claim out of the always-visible area under the action", async () => {
    // The standing one-liner under the CTA was cluttering the action; the copy
    // moved into the collapsed explainer instead of being deleted.
    const { container } = await renderTrade(<SwapPanel />);
    expect(container.querySelector(".trade-assurance")).toBeNull();
    expect(custody()).toBeNull();

    fireEvent.click(explainerToggle());
    expect(custody()).not.toBeNull();
    expect(explainerToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("states the mempool claim once, in the steps", async () => {
    const { container } = await renderTrade(<SwapPanel />);
    fireEvent.click(explainerToggle());
    const steps = document.getElementById("trade-explainer-steps");
    expect(steps).not.toBeNull();
    expect(steps!.textContent).toContain("skips the public mempool");
    // Step 1 already carries the clause, so the moved sentence dropped it: one
    // statement per collapsed panel, not two.
    expect(container.textContent?.match(/skips the public mempool/g)).toHaveLength(1);
  });

  it("never claims a swap is not broadcast", async () => {
    // Settlement transactions are public and the activity feed links them, so
    // the absolute claim would be a misrepresentation. Checked collapsed AND
    // expanded: the copy it was retired from now lives behind the toggle.
    const { container } = await renderTrade(<SwapPanel />);
    expect(container.textContent).not.toContain("never broadcast");
    fireEvent.click(explainerToggle());
    expect(container.textContent).not.toContain("never broadcast");
  });
});

describe("selector unit is sibling controls", () => {
  const NESTED_FOCUSABLE =
    "button button, button [tabindex], button a, button input, button [role]";

  it("never nests a focusable control inside the token button", async () => {
    // A button may not contain a focusable descendant (HTML content model). The
    // unit is a styled wrapper around two SIBLING buttons; the old role="button"
    // span inside the token button was invalid markup and read as one control
    // wrapping another in screen readers.
    const token = findTokenBySymbol(DEFAULT_CHAIN_ID, "USDC");
    expect(token).toBeDefined();
    const { container } = await renderTrade(
      <TokenSelector
        chainId={DEFAULT_CHAIN_ID}
        value={token!}
        chainIds={[DEFAULT_CHAIN_ID]}
        tokensByChain={new Map([[DEFAULT_CHAIN_ID, [token!]]])}
        classify={() => ({ state: "available" })}
        onChange={() => {}}
        onChainChange={() => {}}
        showChain
        isSource
      />,
    );
    expect(container.querySelectorAll("button")).not.toHaveLength(0);
    expect(container.querySelectorAll(NESTED_FOCUSABLE)).toHaveLength(0);

    // Same rule with the chain picker open: the dropdown adds a button per
    // chain, and nesting them under the badge would be the same defect.
    fireEvent.click(screen.getByRole("button", { name: /Change network/ }));
    expect(
      within(screen.getByRole("dialog", { name: "Select network" })).queryAllByRole("button"),
    ).not.toHaveLength(0);
    expect(container.querySelectorAll(NESTED_FOCUSABLE)).toHaveLength(0);
  });
});

describe("chain context on both fields", () => {
  it("names the chain in words on the pay and receive fields", async () => {
    // The chain used to be an unlabeled icon, so users had to infer which
    // network each side settles on. Both fields must NAME it: an icon-only
    // badge, or a badge on only one leg, fails here.
    const { container } = await renderTrade(<SwapPanel />);
    const units = container.querySelectorAll(".token-selector");
    expect(units).toHaveLength(2);

    const named = [...units].map((unit) => {
      const badge = unit.querySelector(".chain-badge");
      // "on" is the badge's visual prefix; the chain name is the rest.
      return badge?.textContent?.replace(/^on/, "").trim() ?? null;
    });
    expect(named).toEqual([
      EXTENDED_CHAIN_NAMES[DEFAULT_CHAIN_ID],
      EXTENDED_CHAIN_NAMES[DEFAULT_TO_CHAIN_ID],
    ]);
  });
});
