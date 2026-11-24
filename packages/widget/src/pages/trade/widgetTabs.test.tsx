// @vitest-environment jsdom

/**
 * The widget's in-frame tabs and account chip (xochi-fi/xochi-widget#20).
 *
 * The widget is served alone, so what used to sit below the card on one long
 * page is now tabs at the card's width (Trade / Send / Activity / Claims, the
 * peer-send-tab addendum). What must stay true, checked against the real
 * provider stack and the rendered DOM:
 *   - the top row is a WAI-ARIA tablist: click selects, arrows move and select
 *     (wrapping), Home/End jump, one tab stop; Trade's Buy | Swap mode is a
 *     nested tablist with the same keys;
 *   - Claims exists only where it can render (a connected wallet);
 *   - leaving Swap mid-quote (for another tab or for Buy) keeps the held
 *     quote: no re-quote, no reset;
 *   - Buy shows its critical facts before any rail, reads Peer only for an
 *     entered amount, and offers only fresh live rails (nothing executes);
 *   - host narrowing (tabs / modes / destinations / rampProviders) hides
 *     surfaces and seeds the initial selection, never adds one;
 *   - every "go claim it" path lands on the Claims tab: the claims nudge, the
 *     activity row's claim action, and the stealth receipt's "Claim your
 *     payment";
 *   - an activity retry lands on Trade's Swap mode with the row's route prefilled;
 *   - the account chip appears only while connected and opens RainbowKit's
 *     account modal, whose Disconnect works.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Config } from "wagmi";
import { QuoteResponseSchema } from "@xochi/client";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { RampDiscoveryContext } from "../../ramp/availability/useRampDiscovery.js";
import { RECORDED_AT, recordedPort } from "../../test/rampPort.js";
import {
  renderTrade,
  makeTestConfig,
  apiStub,
  TEST_ACCOUNT,
  type ApiStubOptions,
  type StubbedRoute,
} from "./harness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "./embedParams.js";
import { STORAGE_KEYS } from "../../constants.js";
import type { SwapActivityItem } from "../../types/activity.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { clearWalletSession, getWalletToken } from "../../lib/walletSession.js";

// Longest tests: "lands the stealth receipt's Claim your payment on Claims"
// (the restored modal, the stealth ending, the modal closing) and the activity
// retry (the strip toggle, the row, the prefill): 1 render, 3 waits.
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_L1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/**
 * 1000 USDC in, 998 out on the default Base -> Arbitrum USDC pair. A preview:
 * the one test that quotes is disconnected, and the machine refuses a served
 * `preview` that disagrees with the request.
 */
const quoteBody = QuoteResponseSchema.parse(
  quoteWire({ to_amount: "998000000", min_to_amount: "996000000", cost_bps: 22, preview: true }),
);

/** The quote as the Worker serves it: a preview when the (disconnected) panel asked for one. */
const quoteRoute: StubbedRoute = {
  answer: (request) => ({
    ...quoteBody,
    preview:
      typeof request === "object" && request !== null && Reflect.get(request, "preview") === true,
  }),
};

/**
 * Stub `fetch` and count quote requests, so "the quote was kept" can be told
 * apart from "an identical quote was fetched again".
 */
const stubApi = (
  routes: Record<string, StubbedRoute> = {},
  options: ApiStubOptions = {},
): { quotes: () => number } => {
  let quotes = 0;
  const stub = apiStub({ "/api/intent/quote": quoteRoute, ...routes }, options);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/intent/quote")) quotes += 1;
    return stub(input, init);
  });
  return { quotes: () => quotes };
};

beforeEach(() => {
  clearWalletSession();
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearWalletSession();
  intentAPI.clearQuoteCache();
});

// ============================================================
// Handles
// ============================================================

/** The top row's tabs (the nested mode and destination tablists are not in it). */
const topTabs = (): HTMLElement[] =>
  within(screen.getByRole("tablist", { name: "Widget sections" })).getAllByRole("tab");

const tab = (name: "Trade" | "Send" | "Activity" | "Claims"): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Widget sections" })).getByRole("tab", {
    name: new RegExp(`^${name}`),
  });

const modeTab = (name: "Buy" | "Swap" | "Cash out"): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Trade mode" })).getByRole("tab", { name });

const tabNames = (): string[] => topTabs().map((t) => (t.textContent ?? "").replace(/\d.*$/, ""));

const selectedTab = (): string | undefined =>
  topTabs()
    .find((t) => t.getAttribute("aria-selected") === "true")
    ?.textContent?.replace(/\d.*$/, "");

const selectedMode = (): string | undefined =>
  within(screen.getByRole("tablist", { name: "Trade mode" }))
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? undefined;

/**
 * The one visible top-level tabpanel, checked against the selected tab's
 * aria-controls; every other top-level panel is hidden.
 */
const visiblePanel = (): HTMLElement => {
  const selected = topTabs().find((t) => t.getAttribute("aria-selected") === "true");
  const panel = document.getElementById(selected?.getAttribute("aria-controls") ?? "");
  if (!panel) throw new Error("selected tab controls no panel");
  expect(panel.getAttribute("role")).toBe("tabpanel");
  expect(panel.getAttribute("aria-labelledby")).toBe(selected?.id);
  expect(panel.hasAttribute("hidden")).toBe(false);
  for (const other of topTabs()) {
    if (other === selected) continue;
    const id = other.getAttribute("aria-controls");
    expect(id && document.getElementById(id)?.hasAttribute("hidden")).toBe(true);
  }
  return panel;
};

/** The pay field, found the way a screen reader names it. */
const payAmount = (): HTMLInputElement =>
  within(document.querySelector(".trade-card") as HTMLElement).getByLabelText<HTMLInputElement>(
    "Pay",
  );

const swapRecord = (over: Partial<SwapActivityItem> = {}): SwapActivityItem => ({
  id: "xi_widget_tabs",
  type: "swap",
  timestamp: Date.now() - 60_000,
  status: "failed",
  intentStatus: "failed",
  data: {
    fromChainId: 8453,
    toChainId: 42161,
    fromToken: USDC_BASE,
    toToken: USDC_ARB,
    fromAmount: "5000000",
    toAmount: "4989000",
    tier: "Standard",
    feeRate: 0.22,
    txHash: null,
    isCrossChain: true,
  },
  ...over,
});

const seedActivity = (...items: SwapActivityItem[]): void => {
  window.localStorage.setItem(
    `${STORAGE_KEYS.localActivityPrefix}${TEST_ACCOUNT.toLowerCase()}`,
    JSON.stringify(items),
  );
};

/** Expand the single row in the Activity tab. */
const expandActivityRow = async (): Promise<void> => {
  const row = await waitFor(() => {
    const found = document.querySelector(".activity-row");
    if (!found) throw new Error("activity row not rendered");
    return found;
  }, WAIT);
  fireEvent.click(row);
};

// ============================================================
// Tablist semantics
// ============================================================

describe("tablist", () => {
  it("switches panels by click, one panel visible at a time", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />);

    expect(screen.getByRole("tablist", { name: "Widget sections" })).toBeTruthy();
    expect(selectedTab()).toBe("Trade");
    expect(selectedMode()).toBe("Swap");
    expect(visiblePanel().querySelector(".trade-card")).toBeTruthy();

    fireEvent.click(tab("Activity"));
    expect(selectedTab()).toBe("Activity");
    const activity = visiblePanel();
    const activityLog = within(within(activity).getByRole("region", { name: "Transaction log" }));
    expect(activityLog.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(activityLog.queryByRole("button", { expanded: false })).toBeNull();
    // The card is still mounted, only hidden: that is what keeps a swap alive.
    expect(document.querySelector(".trade-card")?.closest("[hidden]")).not.toBeNull();

    fireEvent.click(tab("Send"));
    expect(selectedTab()).toBe("Send");
    expect(within(visiblePanel()).getByRole("textbox", { name: "To" })).toBeTruthy();

    fireEvent.click(tab("Trade"));
    expect(selectedTab()).toBe("Trade");
    expect(visiblePanel().querySelector(".trade-card")).toBeTruthy();
  });

  it("moves with the arrow keys, wraps, and jumps with Home/End", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    expect(tabNames()).toEqual(["Trade", "Send", "Activity", "Claims"]);

    const key = (k: string): void => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: k });
    };
    tab("Trade").focus();

    key("ArrowRight");
    expect(selectedTab()).toBe("Send");
    expect(document.activeElement).toBe(tab("Send"));

    key("ArrowRight");
    expect(selectedTab()).toBe("Activity");
    expect(document.activeElement).toBe(tab("Activity"));

    key("ArrowRight");
    expect(selectedTab()).toBe("Claims");
    key("ArrowRight");
    expect(selectedTab()).toBe("Trade");
    expect(document.activeElement).toBe(tab("Trade"));

    key("ArrowLeft");
    expect(selectedTab()).toBe("Claims");
    expect(document.activeElement).toBe(tab("Claims"));

    key("Home");
    expect(selectedTab()).toBe("Trade");
    key("End");
    expect(selectedTab()).toBe("Claims");
    expect(visiblePanel().querySelector('[aria-label="Stealth receiving"]')).toBeTruthy();

    // One tab stop: only the selected tab is in the Tab order.
    expect(topTabs().map((t) => t.tabIndex)).toEqual([-1, -1, -1, 0]);
  });

  it("moves between wrapped rows while keeping one tab stop", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    for (const [index, button] of topTabs().entries()) {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({
          x: (index % 2) * 100,
          y: Math.floor(index / 2) * 44,
          width: 100,
          height: 44,
        }),
      );
    }
    tab("Trade").focus();
    fireEvent.keyDown(tab("Trade"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("Activity"));
    expect(selectedTab()).toBe("Activity");
    fireEvent.keyDown(tab("Activity"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(tab("Trade"));
    expect(topTabs().filter((button) => button.tabIndex === 0)).toEqual([tab("Trade")]);
  });

  it("switches Trade between Buy and Swap with the same keys", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    expect(selectedMode()).toBe("Swap");

    modeTab("Swap").focus();
    fireEvent.keyDown(modeTab("Swap"), { key: "ArrowRight" });
    expect(selectedMode()).toBe("Buy");
    expect(document.activeElement).toBe(modeTab("Buy"));
    // The top row did not move: the mode is Trade's own selection.
    expect(selectedTab()).toBe("Trade");

    fireEvent.keyDown(modeTab("Buy"), { key: "End" });
    expect(selectedMode()).toBe("Cash out");
    fireEvent.keyDown(modeTab("Cash out"), { key: "ArrowRight" });
    expect(selectedMode()).toBe("Swap");
    expect(
      within(screen.getByRole("tablist", { name: "Trade mode" }))
        .getAllByRole("tab")
        .map((t) => t.tabIndex),
    ).toEqual([0, -1, -1]);
  });

  it("shows Buy's critical facts before any rail and reads Peer only for an amount", async () => {
    stubApi();
    const port = recordedPort({ account: TEST_ACCOUNT, clock: { t: RECORDED_AT } });
    await renderTrade(
      <RampDiscoveryContext value={port}>
        <Trade look={FULL_LOOK} />
      </RampDiscoveryContext>,
      { connected: true },
    );
    fireEvent.click(modeTab("Buy"));

    const buy = document.getElementById(modeTab("Buy").getAttribute("aria-controls") ?? "")!;
    expect(buy.hasAttribute("hidden")).toBe(false);
    expect(within(buy).getByRole("region", { name: "Before you choose" }).textContent).toMatch(
      /wallet addresses are public/,
    );
    expect(within(buy).queryAllByRole("radio")).toHaveLength(0);
    expect(port.calls).toEqual([]);
    // The Swap card is hidden, not unmounted.
    expect(document.querySelector(".trade-card")?.closest("[hidden]")).not.toBeNull();

    fireEvent.change(within(buy).getByLabelText("USDC to receive"), { target: { value: "25" } });
    await within(buy).findByRole("radio", { name: "Wise" }, WAIT);
    expect(port.calls).toEqual(["25000000"]);
    expect(within(buy).getByLabelText(/Wise/)).toBeTruthy();
    expect(
      within(buy).getByRole("region", { name: "Unavailable payment apps" }).textContent,
    ).toMatch(/Venmo.*Temporarily unavailable/);
  });

  it("follows the host's initial tab and mode, and hides what it narrows out", async () => {
    stubApi();
    await renderTrade(
      <Trade look={FULL_LOOK} embed={{ initialTab: "trade", initialMode: "onramp" }} />,
    );
    expect(selectedTab()).toBe("Trade");
    expect(selectedMode()).toBe("Buy");
    cleanup();

    await renderTrade(
      <Trade look={FULL_LOOK} embed={{ rampProviders: [], initialMode: "onramp" }} />,
    );
    expect(selectedMode()).toBe("Swap");
    expect(
      within(screen.getByRole("tablist", { name: "Trade mode" }))
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Swap"]);
    fireEvent.click(tab("Send"));
    expect(screen.getByRole("textbox", { name: "To" })).toBeTruthy();
    cleanup();

    await renderTrade(
      <Trade look={FULL_LOOK} embed={{ initialTab: "trade", initialMode: "offramp" }} />,
    );
    expect(selectedTab()).toBe("Trade");
    expect(selectedMode()).toBe("Cash out");
    cleanup();

    await renderTrade(<Trade look={FULL_LOOK} embed={{ tabs: ["activity"] }} />);
    expect(tabNames()).toEqual(["Activity"]);
    expect(document.querySelector(".trade-card")).toBeNull();
  });

  it("offers Claims only to a connected wallet", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />);
    // A disconnected visitor can neither set up stealth keys nor claim, so the
    // tab would open on an empty panel.
    expect(tabNames()).toEqual(["Trade", "Send", "Activity"]);
  });
});

// ============================================================
// The swap survives a tab switch
// ============================================================

describe("leaving Swap mid-quote", () => {
  it("keeps the held quote and the typed amount", async () => {
    const api = stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />);

    fireEvent.change(payAmount(), { target: { value: "1000" } });
    // useIntent debounces the quote by 500ms; wait for the priced receipt.
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    const receipt = document.querySelector(".quote-details")?.textContent;
    const quotesBefore = api.quotes();
    expect(quotesBefore).toBeGreaterThan(0);

    fireEvent.click(tab("Activity"));
    fireEvent.click(tab("Trade"));
    fireEvent.click(modeTab("Buy"));
    fireEvent.click(modeTab("Swap"));

    expect(payAmount().value).toBe("1000");
    expect(screen.getByLabelText<HTMLInputElement>("Amount to receive").value).toBe("998");
    expect(document.querySelector(".quote-details")?.textContent).toBe(receipt);
    // Kept, not re-fetched: the switch did not remount the panel.
    expect(api.quotes()).toBe(quotesBefore);
  });
});

// ============================================================
// Activity -> Swap and every claim path -> Claims
// ============================================================

describe("activity retry", () => {
  it("lands on Trade's Swap mode with the row's route prefilled", async () => {
    stubApi();
    // Only a failure the Worker marked `not_executed` is retried from the feed.
    seedActivity(swapRecord({ data: { ...swapRecord().data, substatus: "not_executed" } }));
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    // From Buy, so landing on Swap is the retry's doing.
    fireEvent.click(modeTab("Buy"));
    fireEvent.click(tab("Activity"));
    await expandActivityRow();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(selectedTab()).toBe("Trade");
    expect(selectedMode()).toBe("Swap");
    expect(visiblePanel().querySelector(".trade-card")).toBeTruthy();
    await waitFor(() => expect(payAmount().value).toBe("5"), WAIT);
  });
});

describe("claim paths land on the Claims tab", () => {
  /** A wallet session plus one claimable settlement, served from the platform boundary. */
  const withClaimable = (): void => {
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "harness-wallet-session", wallet: TEST_ACCOUNT.toLowerCase() }),
    );
    stubApi({
      "/api/settlement": { body: { settlements: [{ status: "claimable" }] } },
      "/api/intent/history": { body: { orders: [], hasMore: false } },
    });
  };

  it("lands the claims nudge on Claims and counts the payment on the tab", async () => {
    withClaimable();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    const nudge = await screen.findByRole("button", { name: /ready to claim/ }, WAIT);
    expect(tab("Claims").textContent).toContain("1");
    expect(screen.getByRole("tab", { name: /^Claims.*1 ready to claim/ })).toBeTruthy();

    fireEvent.click(nudge);
    expect(selectedTab()).toBe("Claims");
    expect(visiblePanel().querySelector('[aria-label="Stealth receiving"]')).toBeTruthy();
  });

  it("lands the activity row's claim action on Claims", async () => {
    stubApi();
    seedActivity(
      swapRecord({
        id: "xi_stealth_done",
        status: "completed",
        intentStatus: "completed",
        data: { ...swapRecord().data, settlementType: "stealth" },
      }),
    );
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    fireEvent.click(tab("Activity"));
    await expandActivityRow();
    fireEvent.click(screen.getByRole("button", { name: "Go to claims" }));
    expect(selectedTab()).toBe("Claims");
  });

  it("lands the stealth receipt's Claim your payment on Claims", async () => {
    // A stealth order to Ethereum L1, in flight when the tab was lost: the
    // panel resumes it, the solver reports it complete, and the modal shows the
    // stealth ending from the record alone, with no panel interaction.
    stubApi({
      "/status": {
        body: statusWire({ intent_id: "xi_stealth_l1", status: "completed", terminal: true }),
      },
    });
    seedActivity(
      swapRecord({
        id: "xi_stealth_l1",
        status: "pending",
        intentStatus: "settling",
        data: { ...swapRecord().data, toChainId: 1, toToken: USDC_L1, settlementType: "stealth" },
      }),
    );
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);

    const claim = await screen.findByRole("button", { name: "Claim payment" }, WAIT);
    // Somewhere other than Claims first, so the landing is the click's doing.
    fireEvent.click(tab("Activity"));
    expect(selectedTab()).toBe("Activity");

    fireEvent.click(claim);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    expect(selectedTab()).toBe("Claims");
  });
});

describe("Claims sign-in scans", () => {
  const openSignIn = async (): Promise<Config> => {
    const { config } = await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await waitFor(() => expect(config.state.status).toBe("connected"));
    fireEvent.click(tab("Claims"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    });
    await screen.findByRole("button", { name: "Sign in to scan" }, WAIT);
    return config;
  };

  it("signs in only on request and completes a scan with the post-auth authority", async () => {
    const signatures: string[] = [];
    stubApi(
      {
        "/api/auth/wallet/challenge": { body: { message: "Sign in", nonce: "claims-nonce" } },
        "/api/auth/wallet/verify": {
          body: { token: "claims-session", wallet: TEST_ACCOUNT },
        },
        "/api/stealth/announcements": {
          body: { announcements: [], count: 0 },
        },
      },
      {
        onWalletRpc: (method) => {
          if (method === "eth_sign" || method === "personal_sign") signatures.push(method);
        },
      },
    );
    const { config } = await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await waitFor(() => expect(config.state.status).toBe("connected"));
    expect(signatures).toEqual([]);
    expect(getWalletToken()).toBeNull();
    fireEvent.click(tab("Claims"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    });
    const signIn = await screen.findByRole("button", { name: "Sign in to scan" }, WAIT);
    expect(signatures).toHaveLength(1);
    expect(screen.queryByText("No stealth payments found")).toBeNull();

    fireEvent.click(signIn);

    await screen.findByText("No stealth payments found", {}, WAIT);
    expect(getWalletToken()).toBe("claims-session");
    expect(signatures).toHaveLength(2);
  });

  it.each(["chain", "chain round trip", "wallet", "connector", "disconnect"] as const)(
    "does not transfer a pending sign-in scan across a %s change",
    async (change) => {
      let config!: Config;
      const replacement = makeTestConfig();
      let verifications = 0;
      let scans = 0;
      const changeConnection = (chainId: number): void => {
        config.setState((state) => {
          const connection = state.current && state.connections.get(state.current);
          if (!connection || !state.current) throw new Error("Harness wallet is not connected");
          return {
            ...state,
            status: change === "disconnect" ? "disconnected" : state.status,
            connections: new Map(state.connections).set(state.current, {
              ...connection,
              chainId,
              accounts:
                change === "wallet"
                  ? (["0x2222222222222222222222222222222222222222"] as const)
                  : connection.accounts,
              connector: change === "connector" ? replacement.connectors[0] : connection.connector,
            }),
          };
        });
      };
      stubApi({
        "/api/auth/wallet/challenge": { body: { message: "Sign in", nonce: "claims-nonce" } },
        "/api/auth/wallet/verify": {
          answer: () => {
            verifications += 1;
            const connection =
              config.state.current && config.state.connections.get(config.state.current);
            if (!connection) throw new Error("Harness wallet is not connected");
            const otherChain = connection.chainId === 8453 ? 1 : 8453;
            changeConnection(change.startsWith("chain") ? otherChain : connection.chainId);
            if (change === "chain round trip") changeConnection(connection.chainId);
            return { token: "claims-session", wallet: TEST_ACCOUNT };
          },
        },
        "/api/stealth/announcements": {
          answer: () => {
            scans += 1;
            return { announcements: [], count: 0 };
          },
        },
      });
      config = await openSignIn();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign in to scan" }));
      });

      expect(verifications).toBe(1);
      expect(scans).toBe(0);
      expect(screen.queryByText("No stealth payments found")).toBeNull();
      if (change.startsWith("chain")) {
        expect(getWalletToken()).toBe("claims-session");
      }
    },
  );

  it("keeps rejected sign-in actionable without scanning", async () => {
    let scans = 0;
    stubApi({
      "/api/auth/wallet/challenge": { body: { message: "Sign in", nonce: "claims-nonce" } },
      "/api/auth/wallet/verify": { status: 401, body: { error: "Signature rejected" } },
      "/api/stealth/announcements": {
        answer: () => {
          scans += 1;
          return { announcements: [], count: 0 };
        },
      },
    });
    await openSignIn();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in to scan" }));
    });

    expect(getWalletToken()).toBeNull();
    expect(scans).toBe(0);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Sign in to scan" }).disabled,
    ).toBe(false);
    expect(screen.queryByText("No stealth payments found")).toBeNull();
  });
});

describe("Claims with locked keys", () => {
  const DAI_BASE = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
  const stealthSwap = swapRecord({
    id: "xi_stealth_base",
    status: "completed",
    intentStatus: "completed",
    data: {
      ...swapRecord().data,
      toChainId: 8453,
      toToken: DAI_BASE,
      toAmount: "4980000000000000000",
      settlementType: "stealth",
    },
  });
  const signatures: string[] = [];
  let scans = 0;
  const stubClaims = (): void => {
    signatures.length = 0;
    scans = 0;
    stubApi(
      {
        "/api/settlement": {
          body: {
            settlements: [
              {
                status: "claimable",
                intentId: "xi_stealth_base",
                tokenAddress: DAI_BASE,
                amount: "4980000000000000000",
              },
            ],
          },
        },
        "/api/intent/history": { body: { orders: [], hasMore: false } },
        "/api/auth/wallet/challenge": { body: { message: "Sign in", nonce: "claims-nonce" } },
        "/api/auth/wallet/verify": { body: { token: "claims-session", wallet: TEST_ACCOUNT } },
        "/api/stealth/announcements": {
          answer: () => {
            scans += 1;
            return { announcements: [], count: 0 };
          },
        },
      },
      {
        onWalletRpc: (method) => {
          if (method === "eth_sign" || method === "personal_sign") signatures.push(method);
        },
      },
    );
  };

  it("shows what is waiting before any signature, then unlocks and scans in one click", async () => {
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "harness-wallet-session", wallet: TEST_ACCOUNT.toLowerCase() }),
    );
    stubClaims();
    seedActivity(stealthSwap);
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    await screen.findByRole("button", { name: /^4\.98 DAI waiting on Base\. Open Claims/ }, WAIT);
    fireEvent.click(tab("Claims"));
    expect(
      within(visiblePanel()).getByText("4.98 DAI waiting on Base. Sign to unlock and claim."),
    ).toBeTruthy();
    expect(signatures).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock and scan" }));
    });

    await screen.findByText("No stealth payments found", {}, WAIT);
    expect(signatures).toHaveLength(1);
    expect(scans).toBeGreaterThan(0);
  });

  it("signs in, unlocks and scans from one click", async () => {
    stubClaims();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    fireEvent.click(tab("Claims"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in and unlock" }));
    });

    await screen.findByText("No stealth payments found", {}, WAIT);
    expect(getWalletToken()).toBe("claims-session");
    expect(signatures).toHaveLength(2);
    expect(scans).toBeGreaterThan(0);
  });
});

// ============================================================
// Account chip
// ============================================================

describe("account chip", () => {
  const chipName = new RegExp(
    `^Account ${TEST_ACCOUNT.slice(0, 6)}\\.\\.\\.${TEST_ACCOUNT.slice(-4)} on `,
  );

  it("is absent while disconnected", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />);
    expect(screen.queryByRole("button", { name: /^Account / })).toBeNull();
  });

  it("opens the account modal, whose Disconnect works", async () => {
    stubApi();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    const chip = await screen.findByRole("button", { name: chipName }, WAIT);
    expect(chip.querySelector("img.chain-icon")).toBeTruthy();

    fireEvent.click(chip);
    const disconnect = await screen.findByRole("button", { name: /Disconnect/ }, WAIT);
    fireEvent.click(disconnect);

    await waitFor(() => expect(screen.queryByRole("button", { name: chipName })).toBeNull(), WAIT);
    // Claims needs a wallet, so it goes with it.
    expect(tabNames()).toEqual(["Trade", "Send", "Activity"]);
  });
});
