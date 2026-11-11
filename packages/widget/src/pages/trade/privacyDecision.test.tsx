// @vitest-environment jsdom

/**
 * Privacy at the decision point (trade-widget-mvp.md, Phase 4).
 *
 * These were source-text assertions -- `readFileSync("./SwapPanel.tsx")` plus
 * `toContain('shieldedPreLive ? <span className="destination-tag--soon">Soon</span>')`
 * and friends. Every one of them broke under the notice-union refactor while the
 * behaviour was identical, and every one passed today even if the control were
 * wired to nothing. They are replaced here by renders that click the actual
 * controls, so what is pinned is the contract a user meets:
 *
 *   - three settlement modes, presented as peers, each with exactly one line:
 *     what it does, or the one fix when it is unavailable;
 *   - the user's selection is never switched without a user action;
 *   - Shielded enters zk.money through a public Ethereum deposit;
 *     direct Aztec settlement remains gated (#142);
 *   - Stealth discovery stays available before wallet setup or a supported pair;
 *     live exact routes still gate private quoting and execution;
 *   - AT MOST ONE guidance line is on screen. That invariant used to be three
 *     independent booleans and a comment asking the reader to clear the other
 *     two; it is now a single nullable union, and this is the test that says so;
 *   - the standalone privacy section renders only for a wallet that can use it;
 *   - first-use education is a collapsed drawer, never a blocking surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderTrade, apiStub } from "./harness.js";
import { FALLBACK_CAPABILITIES } from "../../lib/capabilities.js";
import { SwapPanel } from "./SwapPanel.js";
import { Trade } from "../Trade.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { FULL_LOOK } from "./embedParams.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { findTokenBySymbol } from "./config.js";

// Longest test: "keeps Stealth selected when the destination leaves Ethereum,
// showing its fix" -- 1 render, 4 waits (the solver's stealth chains landing,
// Stealth commits, the chain option is offered, the fix line appears).
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 4 }) });

const BASE = 8453;
const ARBITRUM = 42161;
const ETHEREUM = 1;
const CAPABILITY_CHAIN_IDS = [ETHEREUM, BASE, ARBITRUM] as const;
const capabilityToken = (symbol: string) => {
  const deployments = CAPABILITY_CHAIN_IDS.flatMap((chainId) => {
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
const PUBLIC_ROUTE = {
  origin: { chain_id: BASE, token: "USDC" },
  destination: { kind: "chain", chain_id: ARBITRUM, token: "USDC" },
  privacy_modes: ["public"],
};
const ETHEREUM_STEALTH_ROUTE = {
  origin: { chain_id: BASE, token: "USDC" },
  destination: { kind: "chain", chain_id: ETHEREUM, token: "USDC" },
  privacy_modes: ["public", "stealth"],
};
const ZK_MONEY_ROUTE = {
  origin: { chain_id: BASE, token: "USDC" },
  destination: { kind: "zk_money", token: "DAI" },
  privacy_modes: ["public"],
};
const fallbackRaw = FALLBACK_CAPABILITIES.raw as {
  chains: readonly Record<string, unknown>[];
};
const capabilityBody = (
  source: "live" | "stale" = "live",
  routes: readonly Record<string, unknown>[] = [
    PUBLIC_ROUTE,
    ETHEREUM_STEALTH_ROUTE,
    ZK_MONEY_ROUTE,
  ],
) => ({
  source,
  capabilities: {
    ...FALLBACK_CAPABILITIES.raw,
    tokens: [capabilityToken("USDC"), capabilityToken("DAI")],
    stealth_chains: [ETHEREUM],
    chains: fallbackRaw.chains.map((chain) =>
      chain.chain_id === ETHEREUM
        ? { ...chain, stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
        : chain,
    ),
    routes,
  },
});

const LIVE_ROUTE_CAPABILITIES = { body: capabilityBody() };
const PUBLIC_ONLY_CAPABILITIES = {
  body: capabilityBody("live", [PUBLIC_ROUTE, ZK_MONEY_ROUTE]),
};
const NO_STEALTH_CAPABILITIES = {
  body: capabilityBody("live", [
    PUBLIC_ROUTE,
    { ...ETHEREUM_STEALTH_ROUTE, privacy_modes: ["public"] },
    ZK_MONEY_ROUTE,
  ]),
};
const NO_ZK_MONEY_CAPABILITIES = {
  body: capabilityBody("live", [PUBLIC_ROUTE, ETHEREUM_STEALTH_ROUTE]),
};

beforeEach(() => {
  // Typed exact routes, not token metadata or the legacy stealth list, grant
  // privacy. The default route is public-only and Ethereum is its Stealth fix.
  vi.stubGlobal("fetch", apiStub({ "/api/capabilities": LIVE_ROUTE_CAPABILITIES }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

/** The three settlement buttons, by their visible label. */
const mode = (name: "Public" | "Stealth" | "Shielded"): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

const selected = (): string[] =>
  (["Public", "Stealth", "Shielded"] as const).filter(
    (name) => mode(name).getAttribute("aria-pressed") === "true",
  );

/** Wait for route guidance, not merely the always-browsable Stealth control. */
const stealthOffered = (): Promise<void> =>
  waitFor(() => {
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    expect(mode("Stealth").textContent).not.toContain("Loading routes");
  }, WAIT);

/** The pay-amount field. Queried by id: its placeholder is a bare "0". */
const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

/** The tap notice the live caption is answering, if any. Other guidance shares its class. */
const captionNotice = (): string | null =>
  document.querySelector(".settlement-caption[aria-live]")?.getAttribute("data-notice") ?? null;

/** Every guidance line currently on screen: the caption notice and the alert. */
const notices = (): string[] =>
  [captionNotice(), document.querySelector('[role="alert"]') ? "alert" : null].filter(
    (s): s is string => s !== null,
  );

/** The one-line slots under a mode button, and how many of them are a fix. */
const metaLines = (name: "Public" | "Stealth" | "Shielded") => {
  const lines = mode(name).querySelectorAll(".type-btn__meta");
  return { lines: lines.length, fixes: mode(name).querySelectorAll(".type-btn__meta--fix").length };
};

function RefreshCapabilities() {
  const { retry } = useCapabilities();
  return <button onClick={retry}>Refresh capabilities</button>;
}

async function chooseEthereumDestination(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "On Arbitrum - Change network" }));
  const dialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
  fireEvent.click(within(dialog).getByRole("button", { name: /^Ethereum/ }));
}

describe("peer options with non-color cues", () => {
  it("offers three privacy choices with supporting descriptions", async () => {
    await renderTrade(<SwapPanel />);
    const group = screen.getByRole("group", { name: "Settlement privacy" });
    expect(group.querySelectorAll("button")).toHaveLength(3);
    // Text, not colour: each option carries exactly one line of words. PrivacyBars
    // carries the ordering graphically and is tested in PrivacyBars.test.tsx.
    for (const name of ["Public", "Stealth", "Shielded"] as const) {
      expect(metaLines(name).lines).toBe(1);
    }
  });
});

describe("zk.money privacy shortcut", () => {
  it("enters zk.money directly from explicit Stealth discovery", async () => {
    await renderTrade(<SwapPanel />);
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    expect(selected()).toEqual(["Stealth"]);

    fireEvent.click(mode("Shielded"));
    expect(screen.getByRole("button", { name: "On zk.money - Change network" })).toBeTruthy();
    expect(screen.getByLabelText("zk.money tag")).toBeTruthy();
    expect(selected()).toEqual(["Shielded"]);
    // The tag rail stays Public internally; Stealth is still navigation out.
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    expect(mode("Stealth").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notices()).toEqual([]);
  });
  it("shows the reason when zk.money is unavailable", async () => {
    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": NO_ZK_MONEY_CAPABILITIES }));
    await renderTrade(<SwapPanel />);

    const shielded = mode("Shielded") as HTMLButtonElement;
    await waitFor(() => expect(shielded.disabled).toBe(true), WAIT);
    const reasonId = shielded.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    const reason = reasonId ? document.getElementById(reasonId) : null;
    expect(reason?.textContent).not.toBe("Send to zk.money");
    expect(reason?.textContent?.trim()).not.toBe("");
    expect(reason?.classList.contains("type-btn__meta--fix")).toBe(true);
  });
});

describe("stealth blockers are triaged, not collapsed", () => {
  it("selects Stealth anonymously and offers discovery without wallet setup", async () => {
    const walletMethods: string[] = [];
    const quoteRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      apiStub(
        {
          "/api/capabilities": LIVE_ROUTE_CAPABILITIES,
          "/api/intent/quote": {
            answer: (request) => {
              quoteRequests.push(request);
              throw new Error("Stealth discovery must not request a quote");
            },
          },
        },
        { onWalletRpc: (method) => walletMethods.push(method) },
      ),
    );
    await renderTrade(<SwapPanel />);
    await stealthOffered();
    expect(metaLines("Stealth")).toEqual({ lines: 1, fixes: 1 });
    expect(document.querySelector("#stealth-destinations")?.textContent).toBe(
      "Stealth destinations: Ethereum only.",
    );
    expect(mode("Stealth").getAttribute("aria-describedby")).toBe("stealth-destinations");
    fireEvent.click(mode("Stealth"));
    expect(captionNotice()).toBeNull();
    expect(document.querySelector(".settlement-caption[aria-live]")?.textContent).toContain(
      "Stealth derives its one-time address from a connected wallet.",
    );
    // The picker's exact-route guidance replaces the network hint, never stacks on it.
    expect(document.querySelector("#stealth-destinations")).toBeNull();
    expect(mode("Stealth").hasAttribute("aria-describedby")).toBe(false);
    expect(selected()).toEqual(["Stealth"]);
    expect(payAmount().value).toBe("");
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "isn't a live Stealth",
    );
    const connect = screen.getByRole<HTMLButtonElement>("button", { name: "Connect wallet" });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(await screen.findByRole("dialog", undefined, WAIT)).toBeTruthy();
    expect(quoteRequests).toEqual([]);
    expect(walletMethods).not.toContain("personal_sign");
    expect(walletMethods).not.toContain("eth_sign");
  });

  it("keeps the unsupported pair visible until a live destination is explicitly chosen", async () => {
    await renderTrade(<SwapPanel />, { connected: true });
    await stealthOffered();
    fireEvent.click(mode("Stealth"));

    expect(selected()).toEqual(["Stealth"]);
    expect(screen.getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to Ethereum instead" })).toBeNull();
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "Ethereum",
    );
    fireEvent.click(mode("Public"));
    expect(document.querySelector("#stealth-destination-guidance")).toBeNull();
    expect(selected()).toEqual(["Public"]);
  });

  it("selects the destination only after a separate explicit receive choice", async () => {
    await renderTrade(<SwapPanel />, { connected: true });
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    await chooseEthereumDestination();

    // The destination now carries Stealth; keys still require an explicit setup.
    await waitFor(() => expect(selected()).toEqual(["Stealth"]), WAIT);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows Stealth discovery without inventing choices from a public-only route", async () => {
    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": PUBLIC_ONLY_CAPABILITIES }));
    await renderTrade(<SwapPanel />, { connected: true });

    await waitFor(() => expect(mode("Stealth").textContent).toContain("Try another route"), WAIT);
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mode("Stealth"));
    expect(selected()).toEqual(["Stealth"]);
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "No live Stealth destinations",
    );
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
  });

  it("preserves Stealth through the hosted-wallet EIP-1193 bridge", async () => {
    const walletMethods: string[] = [];
    vi.stubGlobal(
      "fetch",
      apiStub(
        { "/api/capabilities": LIVE_ROUTE_CAPABILITIES },
        { onWalletRpc: (method) => walletMethods.push(method) },
      ),
    );
    await renderTrade(<SwapPanel />, { connected: true, hostWallet: true, walletChainId: 8453 });
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    await chooseEthereumDestination();

    await waitFor(() => expect(selected()).toEqual(["Stealth"]), WAIT);
    expect(metaLines("Stealth")).toEqual({ lines: 1, fixes: 1 });
    expect(walletMethods).not.toContain("personal_sign");
    expect(walletMethods).not.toContain("eth_sign");
    fireEvent.click(screen.getByRole("button", { name: "Set up Stealth" }));
    await waitFor(() => expect(metaLines("Stealth")).toEqual({ lines: 1, fixes: 0 }), WAIT);
    expect(
      walletMethods.some((method) => method === "personal_sign" || method === "eth_sign"),
    ).toBe(true);
  });

  it("keeps Stealth selected but blocks it when a refresh removes route support", async () => {
    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": LIVE_ROUTE_CAPABILITIES }));
    await renderTrade(
      <>
        <SwapPanel />
        <RefreshCapabilities />
      </>,
      { connected: true },
    );
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    await chooseEthereumDestination();
    await waitFor(() => expect(selected()).toEqual(["Stealth"]), WAIT);

    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": NO_STEALTH_CAPABILITIES }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh capabilities" }));

    await waitFor(
      () =>
        expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
          "No live Stealth destinations",
        ),
      WAIT,
    );
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    expect(selected()).toEqual(["Stealth"]);
    expect(metaLines("Stealth")).toEqual({ lines: 1, fixes: 1 });
    expect(screen.queryByText(/Stealth pays out on/)).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
  });

  it("distinguishes loading routes from a failed capability read", async () => {
    // Executor form: the project's TS lib predates Promise.withResolvers.
    let finishLoad!: (response: Response) => void;
    const pendingLoad = new Promise<Response>((resolve) => {
      finishLoad = resolve;
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/api/capabilities")
        ? pendingLoad
        : Promise.reject(new Error(`privacy test: unstubbed fetch ${url}`));
    });
    await renderTrade(<SwapPanel />);

    expect(mode("Stealth").querySelector(".type-btn__meta--fix")?.textContent).toBe(
      "Loading routes",
    );

    finishLoad(
      new Response(JSON.stringify(capabilityBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(
      () =>
        expect(mode("Stealth").querySelector(".type-btn__meta--fix")?.textContent).toBe(
          "Connect a wallet",
        ),
      WAIT,
    );
  });

  // No solver matrix (every capability read fails): neither Public nor Stealth
  // can quote from static display-only metadata.
  it("keeps discovery available on failed route data without guessing a chain", async () => {
    vi.stubGlobal("fetch", apiStub({}, { serveDefaultCapabilities: false }));
    await renderTrade(<SwapPanel />, { connected: true });

    await waitFor(
      () =>
        expect(mode("Stealth").querySelector(".type-btn__meta--fix")?.textContent).toBe(
          "Route data unavailable",
        ),
      WAIT,
    );
    expect(mode("Stealth").getAttribute("title")).toBe("Stealth route data could not be loaded");
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mode("Stealth"));
    expect(selected()).toEqual(["Stealth"]);
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "couldn't be verified",
    );
    expect(document.body.textContent).not.toMatch(/temporarily unavailable/i);
    expect(screen.queryByText(/Stealth pays out on/)).toBeNull();
  });

  it("never reads stealth chains off the worker's fallback envelope", async () => {
    // Even a fallback body that lists a chain is not the solver's answer.
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/capabilities": {
          body: {
            source: "fallback",
            capabilities: { ...FALLBACK_CAPABILITIES.raw, stealth_chains: [1] },
          },
        },
      }),
    );
    await renderTrade(<SwapPanel />, { connected: true });

    await waitFor(
      () => expect(mode("Stealth").textContent).toContain("Route data unavailable"),
      WAIT,
    );
    expect((mode("Stealth") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mode("Stealth"));
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "couldn't be verified",
    );
  });

  it("fails closed on a stale route matrix without requesting a wallet signature", async () => {
    const walletMethods: string[] = [];
    vi.stubGlobal(
      "fetch",
      apiStub(
        { "/api/capabilities": { body: capabilityBody("stale") } },
        { onWalletRpc: (method) => walletMethods.push(method) },
      ),
    );
    await renderTrade(<SwapPanel />, { connected: true });

    await waitFor(
      () => expect(mode("Stealth").textContent).toContain("Route data unavailable"),
      WAIT,
    );
    fireEvent.click(mode("Stealth"));
    expect(selected()).toEqual(["Stealth"]);
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "couldn't be verified",
    );
    expect(walletMethods).not.toContain("personal_sign");
    expect(walletMethods).not.toContain("eth_sign");
  });
});

describe("the selection is never switched for the user", () => {
  it("limits the Stealth picker to live routes and restores the public catalog explicitly", async () => {
    await renderTrade(<SwapPanel />, { connected: true });
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    await chooseEthereumDestination();
    await waitFor(() => expect(selected()).toEqual(["Stealth"]), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "On Ethereum - Change network" }));
    const stealthDialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
    expect(within(stealthDialog).queryByRole("button", { name: /^Arbitrum/ })).toBeNull();
    fireEvent.keyDown(stealthDialog, { key: "Escape" });
    expect(selected()).toEqual(["Stealth"]);

    fireEvent.click(mode("Public"));
    fireEvent.click(screen.getByRole("button", { name: "On Ethereum - Change network" }));
    const publicDialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
    fireEvent.click(within(publicDialog).getByRole("button", { name: /^Arbitrum/ }));
    expect(screen.getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
    expect(selected()).toEqual(["Public"]);
  });
});

describe("the guidance slot holds at most one notice", () => {
  it("replaces, never stacks, as the user taps between modes", async () => {
    await renderTrade(<SwapPanel />);
    await stealthOffered();

    fireEvent.click(mode("Stealth"));
    expect(selected()).toEqual(["Stealth"]);
    expect(captionNotice()).toBeNull();

    // Picking a real mode clears the slot entirely.
    fireEvent.click(mode("Public"));
    expect(notices()).toEqual([]);
  });

  it("keeps explicit Stealth and its destination guidance when the amount is edited", async () => {
    await renderTrade(<SwapPanel />);
    await stealthOffered();
    fireEvent.click(mode("Stealth"));
    fireEvent.change(payAmount(), { target: { value: "5" } });
    expect(selected()).toEqual(["Stealth"]);
    expect(captionNotice()).toBeNull();
    expect(document.querySelector("#stealth-destination-guidance")).toBeTruthy();
  });
});

describe("standalone privacy UI only when relevant", () => {
  it("gates the private receiving section on a connected wallet", async () => {
    const anonymous = await renderTrade(<Trade look={FULL_LOOK} />);
    expect(anonymous.container.querySelector('[aria-label="Private receiving"]')).toBeNull();
    cleanup();

    const connected = await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    expect(connected.container.querySelector('[aria-label="Private receiving"]')).toBeTruthy();
  });
});

describe("education never blocks the form", () => {
  it("keeps the explainer collapsed until asked", async () => {
    await renderTrade(<SwapPanel />);
    const toggle = screen.getByRole("button", { name: /How it works/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Sign an intent")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Sign an intent")).toBeTruthy();
  });
});
