// @vitest-environment jsdom

/**
 * The configurator at `/` (xochi-widget#21, #35, #36).
 *
 * Rendered with the real capability read, served a live matrix at the fetch
 * boundary. What must stay true:
 *   - changing an option reloads the preview with the matching /embed URL;
 *   - the code to copy reproduces exactly the URL the preview shows, and that
 *     URL opens the frame on the chosen options;
 *   - only what the solver fills can be chosen: the Route pickers are the
 *     frame's own, an unadvertised pair stays listed with the frame's reason
 *     and refuses the pick, the flip swaps the legs unless a lock or the
 *     reversed pair refuses it, and unsupported selected Stealth remains visible;
 *   - each settings row drills into its section and back, and Reset restores
 *     the defaults;
 *   - the preview's host background and device width change only the preview,
 *     never the code, and the device toggle is offered only where the stage
 *     can show the two widths apart;
 *   - the Get code dock collapses to its head row and opens again;
 *   - every Get code format (HTML, React, URL) reproduces the preview on this
 *     page's own origin through public params, and copying confirms;
 *   - the page's URL carries every option, so reloading it restores them;
 *   - the Developer parameters round-trip with the controls, and a draft the
 *     frame would not fully honour is flagged and not applied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseCapabilities } from "@xochi/signer";
import { Configurator, PREVIEW_DEBOUNCE_MS } from "./Configurator.js";
import { CodeDock } from "./configurator/CodeDock.js";
import { parseEmbedParams } from "@xochi/widget-lib";
import { embedOffer, resolveEmbedDefaults } from "./trade/embedParams.js";
import { WAIT, testBudget } from "../test/waitBudget.js";
import { anonymousIntentAPI } from "../lib/intentAPI.js";
import { SIMPLE_ACCOUNT_FACTORY, type SelectableChainId } from "@xochi/client";
import { findTokenBySymbol } from "./trade/config.js";

// Longest test: "keeps the options in the page URL, so a reload restores them,
// and Reset clears it" -- 2 renders, 6 waits.
vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 6 }) });

const LIVE_CHAIN_IDS = [1, 8453, 42161] as const satisfies readonly SelectableChainId[];
const capabilityToken = (symbol: string) => {
  const deployments = LIVE_CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`${symbol} has no configured deployment`);
  return {
    symbol,
    roles: ["origin", "destination"],
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};
const LIVE = {
  source: "live",
  capabilities: {
    cross_chain_only: true,
    chains: LIVE_CHAIN_IDS.map((chain_id) => ({
      chain_id,
      chain_name: String(chain_id),
      vm_type: "evm",
      ...(chain_id === 1 ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : {}),
    })),
    tokens: [capabilityToken("USDC"), capabilityToken("USDT")],
    conversion_pairs: [{ from: "USDT", to: "USDC" }],
    stealth_chains: [1],
    routes: LIVE_CHAIN_IDS.flatMap((fromChainId) =>
      LIVE_CHAIN_IDS.flatMap((toChainId) =>
        fromChainId === toChainId
          ? []
          : [
              { from: "USDC", to: "USDC" },
              { from: "USDT", to: "USDT" },
              { from: "USDT", to: "USDC" },
            ].map(({ from, to }) => ({
              origin: { chain_id: fromChainId, token: from },
              destination: { kind: "chain", chain_id: toChainId, token: to },
              privacy_modes: toChainId === 1 ? ["public", "stealth"] : ["public"],
            })),
      ),
    ),
  },
};

function renderConfigurator() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <Configurator />
    </QueryClientProvider>,
  );
}

/** Drill into a section from the settings list. */
type SectionName =
  | "Route"
  | "Allowed assets"
  | "Privacy"
  | "Appearance"
  | "Layout"
  | "Integration"
  | "Developer";

function openSection(name: SectionName): void {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

/** Back from a section to the settings list. */
function back(): void {
  fireEvent.click(screen.getByRole("button", { name: "Back to all settings" }));
}

const rowSummary = (name: SectionName): string =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }).textContent ?? "";

const snippetText = (): string => screen.getByLabelText("HTML code").textContent ?? "";

type LegName = "Send" | "Receive";
const leg = (name: LegName) => within(screen.getByRole("group", { name }));

/** A leg's chain menu option, opening the menu (the frame's chain badge). */
function chainOption(name: LegName, chain: string): HTMLElement {
  if (screen.queryByRole("dialog", { name: "Select network" }) === null) {
    fireEvent.click(leg(name).getByRole("button", { name: /Change network$/ }));
  }
  return within(screen.getByRole("dialog", { name: "Select network" })).getByRole("button", {
    name: new RegExp(`^${chain}`),
  });
}

/** Pick a leg's chain from the frame's chain menu. */
function pickChain(name: LegName, chain: string): void {
  fireEvent.click(chainOption(name, chain));
}

/** A row of the frame's token search, opening it from the leg's token button. */
function tokenRow(name: LegName, symbol: string): HTMLElement {
  if (screen.queryByRole("dialog", { name: "Select token" }) === null) {
    fireEvent.click(leg(name).getByRole("button", { name: /Change token$/ }));
  }
  const dialog = screen.getByRole("dialog", { name: "Select token" });
  const row = within(dialog)
    .getAllByRole("button")
    .find(
      (b) =>
        b.classList.contains("token-search-row") &&
        b.querySelector(".token-search-row-symbol")?.textContent === symbol,
    );
  if (!row) throw new Error(`no ${symbol} row in the ${name} token search`);
  return row;
}

/** Pick a leg's token from the frame's token search. */
function pickToken(name: LegName, symbol: string): void {
  fireEvent.click(tokenRow(name, symbol));
}

const previewFrame = (): HTMLIFrameElement => screen.getByTitle(/preview$/) as HTMLIFrameElement;
const previewUrl = (): URL => new URL(previewFrame().src);
const previewSrc = (): string => `${previewUrl().pathname}${previewUrl().search}`;
const previewParams = (): URLSearchParams => previewUrl().searchParams;

/**
 * Until the live matrix answers, the configurator offers only what the
 * fallback can confirm, so every test starts from the live one.
 */
async function liveMatrix(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector(".config-status")).toBeNull();
  }, WAIT);
}

/** A solvable preview quote, for the "What users see" panel. */
const PREVIEW_QUOTE = {
  success: true,
  intent_id: "xi_preview",
  quote_id: "xq_preview",
  can_solve: true,
  preview: true,
  to_amount: "99780000",
  min_to_amount: "99281100",
  cost_bps: 22,
  expiry: "2099-01-01T00:00:00.000Z",
};

/**
 * The configurator reads the capability matrix (`capabilities`); its "What
 * users see" panel reads the price feed and asks for preview quotes. Each path
 * gets its own body, so no read is handed another endpoint's shape. Anything
 * else is a bug, so it rejects.
 */
function stubApi(capabilities: unknown = LIVE): void {
  const answers: Record<string, unknown> = {
    "/api/capabilities": capabilities,
    "/api/prices": { prices: { USDC: 1, USDT: 1 }, live: true },
    "/api/intent/quote": PREVIEW_QUOTE,
  };
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = Object.keys(answers).find((p) => url.includes(p));
    if (path === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
    return Promise.resolve(
      new Response(JSON.stringify(answers[path]), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

beforeEach(() => stubApi());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The configurator writes its options into the page URL.
  window.history.replaceState(null, "", "/");
});

describe("configurator", () => {
  it("updates the preview src when an option changes", async () => {
    renderConfigurator();
    await liveMatrix();
    await waitFor(() => expect(previewParams().get("settlement")).toBe("stealth"), WAIT);
    const frame = previewFrame();

    openSection("Route");
    pickChain("Receive", "Arbitrum");
    await waitFor(() => expect(previewParams().get("toChain")).toBe("42161"), WAIT);
    // Public updateParams replaces the params on the mounted widget.
    expect(previewFrame()).toBe(frame);
  });

  it("destroys the public widget with the preview", async () => {
    const { unmount } = renderConfigurator();
    await liveMatrix();
    const stage = screen.getByRole("region", { name: "Host page" });
    expect(stage.querySelector("iframe")).not.toBeNull();

    unmount();
    expect(stage.querySelector("iframe")).toBeNull();
  });

  it("emits code whose URL reproduces the preview and the chosen options", async () => {
    renderConfigurator();
    await liveMatrix();

    openSection("Route");
    pickToken("Send", "USDT");
    pickChain("Receive", "Ethereum");
    fireEvent.change(screen.getByLabelText("Amount to send"), { target: { value: "250" } });
    back();
    openSection("Privacy");
    fireEvent.click(await screen.findByRole("radio", { name: /Stealth/ }));

    await waitFor(() => expect(previewSrc()).toMatch(/settlement=stealth/), WAIT);
    fireEvent.click(screen.getByRole("tab", { name: "URL" }));
    const url = new URL(screen.getByLabelText("Embed URL").textContent ?? "");
    expect(url.origin).toBe(window.location.origin);
    expect(`${url.pathname}${url.search}`).toBe(previewSrc());

    // And that URL opens the frame on what was chosen, under the same matrix.
    const caps = parseCapabilities(LIVE.capabilities);
    if (caps === null) throw new Error("test matrix did not parse");
    const opened = resolveEmbedDefaults(parseEmbedParams(url.search), embedOffer(caps, true));
    expect({
      sell: opened.fromToken.symbol,
      buy: opened.toToken.symbol,
      from: opened.fromChainId,
      to: opened.toChainId,
      amount: opened.amount,
      settlement: opened.settlement,
    }).toEqual({
      sell: "USDT",
      buy: "USDC",
      from: 8453,
      to: 1,
      amount: "250",
      settlement: "stealth",
    });
  });

  it("offers only what the solver fills", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Route");

    const receiveChain = leg("Receive").getByRole("button", {
      name: /Change network$/,
    }).textContent;
    // USDC -> USDT is not advertised, so with USDC sent USDT stays listed on
    // the receive leg, with the frame's own reason, and refuses the pick.
    const usdt = tokenRow("Receive", "USDT");
    expect(usdt.getAttribute("aria-disabled")).toBe("true");
    // The reason stays visible instead of being ellipsised.
    expect(usdt.querySelector(".token-search-row-name--reason")).not.toBeNull();
    fireEvent.click(usdt);
    expect(tokenRow("Receive", "USDC").getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(leg("Receive").getByRole("button", { name: "USDC - Change token" })).toBeTruthy();
    // Cross-chain only: the send chain stays listed as the destination, says
    // why, and cannot be chosen.
    const base = chainOption("Receive", "Base");
    expect(base.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(base);
    expect(leg("Receive").getByRole("button", { name: /Change network$/ }).textContent).toBe(
      receiveChain,
    );
    pickChain("Receive", "Ethereum");
    back();

    // Stealth needs an Ethereum destination.
    openSection("Privacy");
    expect(await screen.findByRole("radio", { name: /Stealth/ })).toBeTruthy();
    back();
    openSection("Route");
    pickChain("Receive", "Arbitrum");
    back();
    openSection("Privacy");
    const retained = screen.getByRole("radio", { name: /Stealth/ }) as HTMLInputElement;
    expect(retained.checked).toBe(true);
    expect(retained.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect((screen.getByRole("radio", { name: /Public/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("flips the route into preview and code, unless a lock or the reversed pair refuses", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Route");
    pickChain("Receive", "Arbitrum");
    const flip = screen.getByRole("button", { name: "Flip route" });

    fireEvent.click(flip);
    await waitFor(() => expect(previewParams().get("fromChain")).toBe("42161"), WAIT);
    expect(previewParams().get("toChain")).toBe("8453");
    expect(snippetText()).toContain("fromChainId: 42161");
    expect(snippetText()).toContain("toChainId: 8453");
    expect(leg("Send").getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
    expect(leg("Receive").getByRole("button", { name: "On Base - Change network" })).toBeTruthy();

    // A locked side holds the route: the flip says so and does nothing.
    fireEvent.click(screen.getByRole("checkbox", { name: "Lock send token" }));
    expect(flip.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Can't flip: Locked fields hold the route/)).toBeTruthy();
    fireEvent.click(flip);
    await waitFor(() => expect(previewParams().get("lock")).toBe("sell"), WAIT);
    expect(previewParams().get("fromChain")).toBe("42161");
    expect(previewParams().get("toChain")).toBe("8453");
    fireEvent.click(screen.getByRole("checkbox", { name: "Lock send token" }));

    // USDT -> USDC fills; reversed, USDC -> USDT is not advertised, so the
    // flip refuses with the frame's reason for that pair.
    pickToken("Send", "USDT");
    expect(leg("Receive").getByRole("button", { name: "USDC - Change token" })).toBeTruthy();
    expect(flip.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(flip);
    expect(leg("Send").getByRole("button", { name: "USDT - Change token" })).toBeTruthy();
  });

  it("offers a theme preset per shipped theme, and a pick reaches preview and code", async () => {
    renderConfigurator();
    await liveMatrix();
    expect(rowSummary("Appearance")).toContain("Auto");

    openSection("Appearance");
    const themes = within(screen.getByRole("group", { name: "Theme" }));
    const presets = themes.getAllByRole("radio").map((r) => (r as HTMLInputElement).value);
    expect(presets).toEqual(["auto", "light", "dim", "contrast"]);
    expect((themes.getByRole("radio", { name: /^Auto/ }) as HTMLInputElement).checked).toBe(true);
    // Every preset carries a thumbnail.
    for (const radio of themes.getAllByRole("radio")) {
      expect(radio.closest("label")?.querySelector(".config-theme__thumb")).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("radio", { name: /^High contrast/ }));
    await waitFor(() => expect(previewParams().get("theme")).toBe("contrast"), WAIT);
    expect(snippetText()).toContain('theme: "contrast"');
    back();
    expect(rowSummary("Appearance")).toContain("High contrast");

    // The theme survives a route change, and Auto writes nothing.
    openSection("Route");
    pickChain("Receive", "Arbitrum");
    await waitFor(() => expect(previewParams().get("toChain")).toBe("42161"), WAIT);
    expect(previewParams().get("theme")).toBe("contrast");
    back();
    openSection("Appearance");
    fireEvent.click(screen.getByRole("radio", { name: /^Auto/ }));
    await waitFor(() => expect(previewParams().has("theme")).toBe(false), WAIT);
  });

  it("drives tabs, How it works and a fixed height into preview and code", async () => {
    renderConfigurator();
    await liveMatrix();
    expect(rowSummary("Layout")).toContain("Full widget, 760px");
    // `createXochiWidget` mounts the preview at the frame's height; the code
    // passes the same params, so it mounts the host's iframe the same way.
    const previewHeight = (): string => (screen.getByTitle(/preview$/) as HTMLIFrameElement).height;
    expect(previewHeight()).toBe("760");
    expect(snippetText()).not.toContain("height:");

    openSection("Layout");
    fireEvent.click(screen.getByRole("radio", { name: /^Swap only/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /How it works/ }));
    const height = screen.getByLabelText("Frame height");
    // Out of bounds: named, and not applied.
    fireEvent.change(height, { target: { value: "300" } });
    expect(height.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/whole number of pixels from 480 to 1600/)).toBeTruthy();
    await waitFor(() => expect(previewParams().get("howItWorks")).toBe("0"), WAIT);
    expect(previewParams().get("layout")).toBe("swap");
    expect(previewParams().has("height")).toBe(false);

    fireEvent.change(height, { target: { value: "640" } });
    await waitFor(() => expect(previewParams().get("height")).toBe("640"), WAIT);
    expect(previewHeight()).toBe("640");
    for (const field of ['layout: "swap"', "howItWorks: false", "height: 640"]) {
      expect(snippetText()).toContain(field);
    }
    back();
    expect(rowSummary("Layout")).toContain("Swap only, no How it works, 640px fixed");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(previewParams().has("layout")).toBe(false), WAIT);
    expect(previewParams().has("height")).toBe(false);
    expect(previewHeight()).toBe("760");
  });

  it("drills into a section and back, and Reset restores the defaults", async () => {
    renderConfigurator();
    await liveMatrix();
    await waitFor(() => expect(previewParams().get("settlement")).toBe("stealth"), WAIT);
    const initialRoute = rowSummary("Route");
    const initialPrivacy = rowSummary("Privacy");
    const initialPreview = previewSrc();

    const reset = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    // Drilling in swaps the list for the section, and lands focus on its heading.
    openSection("Route");
    const heading = screen.getByRole("heading", { name: "Route" });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("button", { name: /^Privacy/ })).toBeNull();

    pickToken("Send", "USDT");
    pickChain("Receive", "Ethereum");
    fireEvent.change(screen.getByLabelText("Amount to send"), { target: { value: "250" } });

    // Back shows the list again with the new value, focus on the row it left.
    back();
    expect(screen.queryByRole("group", { name: "Send" })).toBeNull();
    expect(rowSummary("Route")).toContain("250 USDT on Base to USDC on Ethereum");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Route/ }));

    openSection("Privacy");
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    back();
    expect(rowSummary("Privacy")).toContain("Public");
    await waitFor(() => expect(previewParams().get("settlement")).toBe("public"), WAIT);

    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(rowSummary("Route")).toBe(initialRoute);
    expect(rowSummary("Privacy")).toBe(initialPrivacy);
    expect(reset.disabled).toBe(true);
    await waitFor(() => expect(previewSrc()).toBe(initialPreview), WAIT);
    fireEvent.click(screen.getByRole("tab", { name: "URL" }));
    expect(new URL(screen.getByLabelText("Embed URL").textContent ?? "").href).toBe(
      previewUrl().href,
    );

    // Reset from inside a section clears its fields too, even a refused amount.
    openSection("Route");
    fireEvent.change(screen.getByLabelText("Amount to send"), { target: { value: "abc" } });
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect((screen.getByLabelText("Amount to send") as HTMLInputElement).value).toBe("");
  });

  it("changes the preview's host page and device but never the code", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Route");
    pickChain("Receive", "Arbitrum");
    await waitFor(() => expect(previewParams().get("toChain")).toBe("42161"), WAIT);

    const code = snippetText();
    const src = previewSrc();
    const stage = screen.getByRole("region", { name: "Host page" });
    const frame = previewFrame();

    for (const name of ["Light", "Dark", "Checker"]) {
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(stage.className).toContain(`config-stage--${name.toLowerCase()}`);
    }
    fireEvent.change(screen.getByLabelText("Custom background colour"), {
      target: { value: "#123456" },
    });
    expect((screen.getByRole("radio", { name: "Custom" }) as HTMLInputElement).checked).toBe(true);
    expect(stage.style.backgroundColor).toBe("rgb(18, 52, 86)");

    fireEvent.click(screen.getByRole("radio", { name: /Phone/ }));
    expect(frame.getAttribute("width")).toBe("390");
    fireEvent.click(screen.getByRole("radio", { name: "Desktop" }));
    expect(frame.getAttribute("width")).toBe("460");

    expect(snippetText()).toBe(code);
    expect(previewSrc()).toBe(src);
    // The same frame element: switching the view never reloads the widget.
    expect(previewFrame()).toBe(frame);
  });

  it("offers the device toggle only where the stage can show the phone width", async () => {
    // jsdom does no layout, so the stage's measured width is reported by hand
    // through the one browser API the preview reads it from.
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const reportStageWidth = (width: number): void =>
      act(() => {
        for (const callback of observers) {
          callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
        }
      });

    renderConfigurator();
    await liveMatrix();
    const frame = previewFrame();

    reportStageWidth(640);
    fireEvent.click(screen.getByRole("radio", { name: /Phone/ }));
    expect(frame.getAttribute("width")).toBe("390");

    // Under 460px but still over 390px, Desktop (the stage width) and Phone
    // (390px) still differ, so the toggle stays.
    reportStageWidth(422);
    expect((screen.getByRole("radio", { name: /Phone/ }) as HTMLInputElement).checked).toBe(true);
    expect(frame.getAttribute("width")).toBe("390");

    // Narrower than 390px, both widths would render the same: the toggle is
    // hidden (still laid out, so the measurement cannot depend on it), and the
    // frame is offered the full embed width to shrink from, as on a host.
    reportStageWidth(342);
    expect(screen.queryByRole("radio", { name: /Phone/ })).toBeNull();
    expect(screen.getByText("Device")).toBeTruthy();
    expect(frame.getAttribute("width")).toBe("460");

    // Wide again: the choice was kept.
    reportStageWidth(642);
    expect((screen.getByRole("radio", { name: /Phone/ }) as HTMLInputElement).checked).toBe(true);
    expect(frame.getAttribute("width")).toBe("390");
  });

  it("collapses the Get code dock to its head row and opens it again", async () => {
    renderConfigurator();
    await liveMatrix();
    const toggle = screen.getByRole("button", { name: "Get code" });
    const code = screen.getByLabelText("HTML code");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(code.closest("[hidden]")).not.toBeNull();
    // Copy stays in the head row.
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(code.closest("[hidden]")).toBeNull();
  });

  it("opens the previewed frame in a new tab", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Route");
    pickChain("Receive", "Arbitrum");
    await waitFor(() => expect(previewParams().get("toChain")).toBe("42161"), WAIT);

    const link = screen.getByRole("link", { name: /Open in new tab/ });
    expect(link.getAttribute("href")).toBe(previewSrc());
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

describe("get code and shared configuration", () => {
  /** Configure a non-default route through the controls. */
  async function configure(): Promise<void> {
    openSection("Route");
    pickToken("Send", "USDT");
    pickChain("Receive", "Ethereum");
    fireEvent.change(screen.getByLabelText("Amount to send"), { target: { value: "250" } });
    back();
    await waitFor(() => expect(previewParams().get("amount")).toBe("250"), WAIT);
  }

  function code(tab: "HTML" | "React" | "URL"): string {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    return screen.getByRole("tabpanel").querySelector("pre")?.textContent ?? "";
  }

  it("emits public library code and a fallback URL from the previewed params", async () => {
    renderConfigurator();
    await liveMatrix();
    await configure();

    const preview = previewUrl();
    const params = parseEmbedParams(preview.search);
    for (const tab of ["HTML", "React"] as const) {
      const snippet = code(tab);
      expect(snippet, tab).toContain("createXochiWidget");
      expect(snippet, tab).toContain(`origin: ${JSON.stringify(preview.origin)}`);
      for (const [key, value] of Object.entries(params)) {
        expect(snippet, `${tab} ${key}`).toContain(`${key}: ${JSON.stringify(value)}`);
      }
      expect(snippet, tab).not.toContain("autoConnect");
      expect(snippet, tab).not.toContain("<iframe");
      expect(snippet, tab).not.toContain("widget.xochi.fi");
    }
    expect(code("React")).toContain("widget.destroy()");

    const url = new URL(code("URL"));
    expect(url.origin).toBe(preview.origin);
    expect(parseEmbedParams(url.search)).toEqual(params);
    expect(url.href).toBe(preview.href);
  });

  it("copies the selected format and confirms it", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderConfigurator();
    await liveMatrix();

    fireEvent.click(screen.getByRole("tab", { name: "React" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" }, WAIT)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(screen.getByLabelText("React code").textContent);
    expect(screen.getByText("React code copied")).toBeTruthy();

    // A refused clipboard says so instead of confirming.
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    fireEvent.click(screen.getByRole("tab", { name: "URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Couldn't copy/, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("restores every option from a shared configurator URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/?toChain=1&sell=USDT&amount=250&settlement=stealth&bg=custom&bgColor=2b3a55&device=phone",
    );
    renderConfigurator();
    await liveMatrix();

    // Stealth reaches the preview with the live matrix: the fallback the page
    // opened on leaves the stealth chains unknown.
    await waitFor(
      () => expect(previewSrc()).toBe("/embed?toChain=1&sell=USDT&amount=250&settlement=stealth"),
      WAIT,
    );
    expect(rowSummary("Route")).toContain("250 USDT on Base to USDC on Ethereum");
    expect(rowSummary("Privacy")).toContain("Stealth");
    expect((screen.getByRole("radio", { name: "Custom" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("region", { name: "Host page" }).style.backgroundColor).toBe(
      "rgb(43, 58, 85)",
    );
    expect(previewFrame().getAttribute("width")).toBe("390");
  });

  it("restores shared options on reload and preserves preview settings on Reset", async () => {
    renderConfigurator();
    await liveMatrix();
    await configure();
    openSection("Privacy");
    fireEvent.click(screen.getByRole("radio", { name: /Stealth/ }));
    back();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    await waitFor(
      () => expect(new URLSearchParams(window.location.search).get("bg")).toBe("dark"),
      WAIT,
    );
    const shared = `${window.location.pathname}${window.location.search}`;

    // Reload: a fresh configurator on the same address.
    cleanup();
    window.history.replaceState(null, "", shared);
    renderConfigurator();
    await liveMatrix();
    await waitFor(
      () => expect(previewSrc()).toBe("/embed?toChain=1&sell=USDT&amount=250&settlement=stealth"),
      WAIT,
    );
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(
      () => expect(new URLSearchParams(window.location.search).has("amount")).toBe(false),
      WAIT,
    );
    expect(new URLSearchParams(window.location.search).get("bg")).toBe("dark");
  });

  it("writes the page URL once per pause, however fast the options change", async () => {
    renderConfigurator();
    await liveMatrix();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writes = vi.spyOn(window.history, "replaceState");

    // A colour-picker drag: 120 values 16ms apart, about two seconds.
    const picker = screen.getByLabelText("Custom background colour");
    let last = "";
    for (let i = 0; i < 120; i++) {
      last = `#${(0x102030 + i * 0x010101).toString(16)}`;
      fireEvent.change(picker, { target: { value: last } });
      act(() => vi.advanceTimersByTime(16));
    }
    expect(writes).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(window.location.search).get("bgColor")).toBe(last.slice(1));
  });

  it("keeps working when the browser refuses a URL write", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("Attempt to use history.replaceState() too often", "SecurityError");
    });
    renderConfigurator();
    await liveMatrix();

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(errors).toHaveBeenCalled(), WAIT);
    expect(String(errors.mock.calls[0][0])).toMatch(/page URL/);
    // Still the configurator, not the error fallback.
    expect(screen.getByRole("region", { name: "Host page" }).className).toContain(
      "config-stage--dark",
    );
  });

  it("leaves an untouched shared URL alone on the fallback matrix, then follows edits", async () => {
    stubApi({ ...LIVE, source: "fallback" });
    window.history.replaceState(null, "", "/?amount=250&toChain=1&sell=USDT");
    renderConfigurator();
    expect(await screen.findByRole("button", { name: "Retry" }, WAIT)).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Untouched: the shared address stays exactly as it was sent.
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3));
    expect(window.location.search).toBe("?amount=250&toChain=1&sell=USDT");

    // Any edit makes the URL follow, live matrix or not.
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(new URLSearchParams(window.location.search).get("bg")).toBe("light");
    expect(new URLSearchParams(window.location.search).get("toChain")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("sell")).toBe("USDT");
    expect(new URLSearchParams(window.location.search).get("amount")).toBe("250");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(new URLSearchParams(window.location.search).get("bg")).toBe("light");
    expect(new URLSearchParams(window.location.search).has("amount")).toBe(false);
  });

  it("keeps a shared route on the fallback matrix when only the layout changes", async () => {
    stubApi({ ...LIVE, source: "fallback" });
    window.history.replaceState(null, "", "/?amount=250&toChain=1&sell=USDT");
    renderConfigurator();
    expect(await screen.findByRole("button", { name: "Retry" }, WAIT)).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Like the theme: a layout edit never pins the route to what the fallback
    // can confirm.
    openSection("Layout");
    fireEvent.click(screen.getByRole("radio", { name: /^Swap only/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /How it works/ }));
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    const shared = new URLSearchParams(window.location.search);
    expect(shared.get("toChain")).toBe("1");
    expect(shared.get("sell")).toBe("USDT");
    expect(shared.get("amount")).toBe("250");
    expect(shared.get("layout")).toBe("swap");
    expect(shared.get("howItWorks")).toBe("0");
  });

  it("accepts the fallback URL Get code emits back in the Developer parameters", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Developer");
    const field = (): HTMLTextAreaElement =>
      screen.getByLabelText("Embed parameters") as HTMLTextAreaElement;

    const roundTrip = (): void => {
      fireEvent.change(field(), { target: { value: code("URL") } });
      expect(field().getAttribute("aria-invalid")).toBe("false");
      expect(screen.queryByText("Not applied")).toBeNull();
      back();
      openSection("Developer");
    };
    roundTrip();

    fireEvent.change(field(), { target: { value: "toChain=1\nsell=USDT\namount=250" } });
    await waitFor(() => expect(previewParams().get("amount")).toBe("250"), WAIT);
    roundTrip();
  });

  it("round-trips the Developer parameters with the controls", async () => {
    renderConfigurator();
    await liveMatrix();
    await configure();

    // Controls -> parameters.
    openSection("Developer");
    const params = screen.getByLabelText("Embed parameters") as HTMLTextAreaElement;
    expect(new URLSearchParams(params.value.replace(/\n/g, "&")).get("amount")).toBe("250");

    // Parameters -> controls, as typed (a pasted URL reads as its query).
    fireEvent.change(params, {
      target: {
        value: `${window.location.origin}/embed?toChain=1&sell=usdt&amount=75&settlement=stealth`,
      },
    });
    expect(params.getAttribute("aria-invalid")).toBe("false");
    back();
    expect(rowSummary("Route")).toContain("75 USDT on Base to USDC on Ethereum");
    expect(rowSummary("Privacy")).toContain("Stealth");
    await waitFor(
      () => expect(previewSrc()).toBe("/embed?toChain=1&sell=USDT&amount=75&settlement=stealth"),
      WAIT,
    );
    openSection("Route");
    expect(leg("Send").getByRole("button", { name: "USDT - Change token" })).toBeTruthy();
    expect((screen.getByLabelText("Amount to send") as HTMLInputElement).value).toBe("75");
    back();
    openSection("Developer");
    expect((screen.getByLabelText("Embed parameters") as HTMLTextAreaElement).value).toBe(
      "toChain=1\nsell=USDT\namount=75\nsettlement=stealth",
    );
  });

  it("flags parameters the frame would not honour and does not apply them", async () => {
    renderConfigurator();
    await liveMatrix();
    const initialRoute = rowSummary("Route");
    const initialPrivacy = rowSummary("Privacy");
    openSection("Developer");
    const paramsField = (): HTMLTextAreaElement =>
      screen.getByLabelText("Embed parameters") as HTMLTextAreaElement;

    const cases: [string, RegExp][] = [
      ["toChain=1\ncolour=red", /Unknown parameter "colour"/],
      ["toChain=1\nfromChain=abc", /fromChain=abc is not valid/],
      ["toChain=1\ntoChain=10", /toChain is set twice/],
      ["toChain=1\nsell=DOGE", /would ignore sell=DOGE/],
      ["toChain=1\namount=1.1234567", /would ignore amount=1.1234567: USDC takes at most 6/],
      ["toChain=1\nref=a b", /ref=a b is not valid/],
    ];
    for (const [text, problem] of cases) {
      fireEvent.change(paramsField(), { target: { value: text } });
      expect(paramsField().getAttribute("aria-invalid"), text).toBe("true");
      expect(screen.getByText(problem)).toBeTruthy();
      // Nothing applied: the controls and the code are still on the defaults.
      expect(rowSummaryAfterBack(), text).toBe(initialRoute);
      expect(rowSummary("Privacy"), text).toBe(initialPrivacy);
      openSection("Developer");
    }

    // The draft survives a trip away while flagged, and a fix applies it.
    const flagged = paramsField();
    expect(flagged.value).toBe(cases.at(-1)?.[0]);
    fireEvent.change(flagged, { target: { value: "toChain=1\nsettlement=stealth" } });
    expect(flagged.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByText("Not applied")).toBeNull();
    await waitFor(() => expect(previewSrc()).toBe("/embed?toChain=1&settlement=stealth"), WAIT);
  });
});

describe("locks and allow-lists", () => {
  const POLICY_NOTE = /Locks and allow-lists shape the widget only/;
  const check = (name: string | RegExp, scope: HTMLElement = document.body): HTMLInputElement =>
    within(scope).getByRole("checkbox", { name }) as HTMLInputElement;
  const assetBox = (legName: "Send" | "Receive", list: "Chains" | "Tokens", option: string) =>
    check(
      option,
      within(screen.getByRole("group", { name: legName })).getByRole("group", { name: list }),
    );

  it("drives the frame's lock and lists into preview, code and the page URL", async () => {
    renderConfigurator();
    await liveMatrix();

    openSection("Route");
    expect(screen.getByText(POLICY_NOTE)).toBeTruthy();
    // A locked amount needs an amount: named, and the lock dropped.
    fireEvent.click(check(/^Lock amount/));
    await waitFor(() => expect(screen.getByText(/only be locked/)).toBeTruthy(), WAIT);
    fireEvent.change(screen.getByLabelText("Amount to send"), { target: { value: "25" } });
    fireEvent.click(check("Lock receive token"));
    // The amount lock holds the send token and chain; the frame re-derives
    // them, so the URL carries the lock as set.
    await waitFor(() => expect(previewParams().get("lock")).toBe("amount,buy"), WAIT);
    expect(screen.queryByText(/only be locked/)).toBeNull();
    expect(check("Lock send token").checked).toBe(true);
    expect(check("Lock send token").disabled).toBe(true);
    back();

    openSection("Allowed assets");
    expect(screen.getByText(POLICY_NOTE)).toBeTruthy();
    fireEvent.click(assetBox("Send", "Chains", "Ethereum"));
    fireEvent.click(assetBox("Receive", "Tokens", "USDT"));
    await waitFor(() => expect(previewParams().get("fromChains")).toBe("8453,42161"), WAIT);
    expect(previewParams().get("buyTokens")).toBe("USDC");
    expect(previewParams().get("toChains")).toBeNull();
    back();
    expect(rowSummary("Allowed assets")).toContain("Restricted");

    // The code carries exactly what the preview does, and so does the page URL.
    for (const field of [
      'locks: ["amount","buy"]',
      "fromChains: [8453,42161]",
      'buyTokens: ["USDC"]',
    ]) {
      expect(snippetText()).toContain(field);
    }
    await waitFor(
      () =>
        expect(new URLSearchParams(window.location.search).get("fromChains")).toBe("8453,42161"),
      WAIT,
    );
    const shared = `${window.location.pathname}${window.location.search}`;
    const embedded = previewSrc();

    // A shared link restores the boxes as set.
    cleanup();
    window.history.replaceState(null, "", shared);
    renderConfigurator();
    await liveMatrix();
    expect(previewSrc()).toBe(embedded);
    openSection("Route");
    expect(check(/^Lock amount/).checked).toBe(true);
    expect(check("Lock receive token").checked).toBe(true);
    expect(check("Lock send token").checked).toBe(true);
    expect(check("Lock send token").disabled).toBe(true);
    expect(check("Lock receive chain").checked).toBe(false);
    back();
    openSection("Allowed assets");
    expect(assetBox("Send", "Chains", "Ethereum").checked).toBe(false);
    expect(assetBox("Send", "Chains", "Base").checked).toBe(true);
    expect(assetBox("Receive", "Tokens", "USDT").checked).toBe(false);
  });

  it("leaves the lists open after a route change", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Route");
    pickToken("Send", "USDT");
    back();
    openSection("Allowed assets");
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) {
      expect(box.checked, box.parentElement?.textContent ?? "").toBe(true);
    }
    await waitFor(() => expect(previewParams().get("sell")).toBe("USDT"), WAIT);
  });

  it("says why it ignores lists that leave no route, and leaves them off the frame", async () => {
    renderConfigurator();
    await liveMatrix();
    openSection("Allowed assets");

    // Base to Base only: the solver fills cross-chain routes only.
    fireEvent.click(assetBox("Send", "Chains", "Ethereum"));
    fireEvent.click(assetBox("Send", "Chains", "Arbitrum"));
    fireEvent.click(assetBox("Receive", "Chains", "Ethereum"));
    fireEvent.click(assetBox("Receive", "Chains", "Arbitrum"));
    // The last box left cannot be unticked.
    expect(assetBox("Send", "Chains", "Base").disabled).toBe(true);

    const notice = await screen.findByText("Lists not applied", undefined, WAIT);
    const reasons = notice.closest("[role=status]")?.textContent ?? "";
    expect(reasons).toMatch(/Send chains: .*leave no route the solver fills/);
    expect(reasons).toMatch(/Receive chains: .*leave no route the solver fills/);
    expect(previewParams().has("fromChains")).toBe(false);
    expect(previewParams().has("toChains")).toBe(false);
    const reset = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(screen.queryByText("Lists not applied")).toBeNull();
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) {
      expect(box.checked).toBe(true);
    }
    back();
    // The frame opens on no lists, so the summary says so.
    expect(rowSummary("Allowed assets")).toContain("Every chain and token");
  });
});

/** Back to the list and read the Route summary there. */
function rowSummaryAfterBack(): string {
  back();
  return rowSummary("Route");
}

describe("get code on a non-production host", () => {
  it("says the snippets point at this host everywhere but production", () => {
    const { unmount } = render(
      <CodeDock
        origin="https://config-36.xochi-widget-staging.pages.dev"
        params={{}}
        host="config-36.xochi-widget-staging.pages.dev"
      />,
    );
    expect(screen.getByText(/Non-production/).textContent).toContain(
      "config-36.xochi-widget-staging.pages.dev",
    );
    unmount();

    render(<CodeDock origin="https://widget.xochi.fi" params={{}} host="widget.xochi.fi" />);
    expect(screen.queryByText(/Non-production/)).toBeNull();
  });
});

describe("shared-link notice", () => {
  const notice = () => screen.queryByRole("region", { name: "Opened from a shared link" });

  it("lists the widget presets a link carries until dismissed", async () => {
    window.history.replaceState(
      null,
      "",
      "/?toChain=1&sell=usdt&amount=250&settlement=stealth&bg=dark&device=phone",
    );
    renderConfigurator();
    await liveMatrix();
    await waitFor(
      () => expect(previewSrc()).toBe("/embed?toChain=1&sell=USDT&amount=250&settlement=stealth"),
      WAIT,
    );

    const region = notice();
    if (!region) throw new Error("no shared-link notice");
    // The presets that reach the code, as the link spelled them; not the view.
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["toChain=1", "sell=usdt", "amount=250", "settlement=stealth"]);

    // It belongs to the list: a section gets the whole column, and it returns.
    openSection("Route");
    expect(notice()).toBeNull();
    back();
    const again = notice();
    if (!again) throw new Error("no shared-link notice after back");

    fireEvent.click(within(again).getByRole("button", { name: "Dismiss" }));
    expect(notice()).toBeNull();
    // Dismissing changes nothing else.
    expect(previewSrc()).toBe("/embed?toChain=1&sell=USDT&amount=250&settlement=stealth");
  });

  it("is not shown without widget presets", async () => {
    window.history.replaceState(null, "", "/?bg=dark&device=phone");
    renderConfigurator();
    await liveMatrix();
    expect(notice()).toBeNull();
  });

  it("goes with Reset, which clears the presets it names", async () => {
    window.history.replaceState(null, "", "/?amount=250");
    renderConfigurator();
    await liveMatrix();
    expect(notice()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(notice()).toBeNull();
  });
});

describe("promo codes (xochi-widget#48)", () => {
  // The quote cache outlives a render: each test asks the server afresh.
  afterEach(() => anonymousIntentAPI.clearQuoteCache());

  /** The quote the server serves when it applies neither code. */
  const QUIET = {
    referral_note: "Referral code not applied.",
    promo_note: "This code can't be applied.",
  };

  /** Serve the matrix and the given quote, recording each quote request body. */
  function serveQuote(codes: Record<string, unknown>): Record<string, unknown>[] {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let answer: unknown = LIVE;
      if (url.includes("/api/intent/quote") && typeof init?.body === "string") {
        const body: unknown = JSON.parse(init.body);
        if (typeof body === "object" && body !== null) bodies.push({ ...body });
        answer = {
          success: true,
          intent_id: "xi_preview",
          quote_id: "xq_preview",
          can_solve: true,
          preview: true,
          to_amount: "99800000",
          expiry: "2026-10-10T00:00:00Z",
          ...codes,
        };
      } else if (!url.includes("/api/capabilities")) {
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }
      return Promise.resolve(
        new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
      );
    });
    return bodies;
  }

  const field = () => screen.getByLabelText("Promo code") as HTMLInputElement;
  const result = () => document.querySelector(".config-codecheck")?.textContent ?? "";

  it("reports a preview no solver priced as no bid, never as a code turned down", async () => {
    serveQuote({ can_solve: false, error: "No solver bid", ...QUIET });
    renderConfigurator();
    await liveMatrix();
    openSection("Integration");
    fireEvent.change(field(), { target: { value: "LAUNCH10" } });

    const status = await screen.findByText(/no bid on this route/, {}, WAIT);
    expect(status.textContent).toContain("No solver bid");
    expect(document.body.textContent).not.toMatch(/Not applied|can't be applied/);
  });

  it("checks a typed code on a preview quote and writes it into preview, code and URL", async () => {
    const bodies = serveQuote(QUIET);
    renderConfigurator();
    await liveMatrix();
    expect(rowSummary("Integration")).toContain("No codes");
    openSection("Integration");
    expect(document.querySelector(".config-codecheck")).toBeNull();

    fireEvent.change(field(), { target: { value: "launch10" } });

    await waitFor(() => expect(previewParams().get("promo")).toBe("LAUNCH10"), WAIT);
    expect(snippetText()).toContain('promo: "LAUNCH10"');
    await waitFor(
      () => expect(new URLSearchParams(window.location.search).get("promo")).toBe("LAUNCH10"),
      WAIT,
    );

    // The server's own words, and that the quote still goes through.
    await waitFor(
      () => expect(result()).toContain("Not applied. This code can't be applied."),
      WAIT,
    );
    expect(result()).toContain("first-trade code");
    expect(result()).toContain("never blocks a quote");
    // The "What users see" fee preview quotes the same route without codes and
    // may land after the check, so find the check's own request.
    const checked = bodies.filter((body) => body.promo === "LAUNCH10");
    expect(checked.at(-1)).toMatchObject({ preview: true, promo: "LAUNCH10" });
    expect(checked.at(-1)).not.toHaveProperty("wallet");

    back();
    expect(rowSummary("Integration")).toContain("Promo LAUNCH10");
  });

  it("shows an applied promo's discount", async () => {
    serveQuote({ promo: { code: "LAUNCH10", discount_bps: 5 } });
    renderConfigurator();
    await liveMatrix();
    openSection("Integration");
    fireEvent.change(field(), { target: { value: "LAUNCH10" } });

    await waitFor(
      () => expect(result()).toContain("Applied. LAUNCH10: 5 bps off the venue and routing fees"),
      WAIT,
    );
    expect(result()).not.toContain("never blocks a quote");
  });

  it("says a server that did not look at the code has codes off, not that it is invalid", async () => {
    // Codes off (staging today): the server answers with neither an outcome
    // nor a note.
    serveQuote({});
    renderConfigurator();
    await liveMatrix();
    openSection("Integration");
    fireEvent.change(field(), { target: { value: "LAUNCH10" } });

    await waitFor(() => expect(result()).toContain("Not checked."), WAIT);
    expect(result()).toContain("Promo codes are off on this server.");
    expect(result()).not.toMatch(/Not applied/);
  });

  it("flags a code of the wrong shape and neither sends nor writes it", async () => {
    const bodies = serveQuote(QUIET);
    renderConfigurator();
    await liveMatrix();
    openSection("Integration");
    fireEvent.change(field(), { target: { value: "a b" } });
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/^Use 3 to 32 letters, digits, _ or -/)).toBeTruthy();

    // A valid change after it: once the preview shows that, the debounce has
    // passed, and the bad code went nowhere.
    fireEvent.change(field(), { target: { value: "launch10" } });
    await waitFor(() => expect(previewParams().get("promo")).toBe("LAUNCH10"), WAIT);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0), WAIT);
    for (const body of bodies) expect(body.promo ?? "LAUNCH10").toBe("LAUNCH10");
  });

  it("round-trips with the Developer parameters and a shared link", async () => {
    serveQuote(QUIET);
    window.history.replaceState(null, "", "/?ref=partner");
    renderConfigurator();
    await liveMatrix();
    // A link that presets a referral code says so: copied as is, it credits
    // someone else's code.
    const region = screen.getByRole("region", { name: "Opened from a shared link" });
    expect(within(region).getByRole("listitem").textContent).toBe("ref=PARTNER");

    openSection("Developer");
    const params = screen.getByLabelText("Embed parameters") as HTMLTextAreaElement;
    expect(new URLSearchParams(params.value.replace(/\n/g, "&")).get("ref")).toBe("PARTNER");
    fireEvent.change(params, { target: { value: "ref=partner\npromo=launch10" } });
    expect(params.getAttribute("aria-invalid")).toBe("false");
    back();
    openSection("Integration");
    expect(field().value).toBe("LAUNCH10");
    await waitFor(() => expect(previewParams().get("promo")).toBe("LAUNCH10"), WAIT);
    expect(previewParams().get("ref")).toBe("PARTNER");

    back();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    openSection("Integration");
    expect(field().value).toBe("");
    await waitFor(() => expect(previewParams().has("promo")).toBe(false), WAIT);
  });
});
