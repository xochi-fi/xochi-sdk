// @vitest-environment jsdom

/**
 * The frame's layout parameters (xochi-fi/xochi-widget#38), on the real Trade
 * page behind the platform boundary:
 *   - `layout=swap` drops the tab row and keeps the account chip, and a stealth
 *     receipt still offers Claim payment, opening the full widget on Claims in
 *     a new tab;
 *   - the full widget opened at `#claims` lands on Claims once it exists;
 *   - `howItWorks=0` removes the disclosure;
 *   - `height` fixes the widget's height.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { connect } from "@wagmi/core";
import { QuoteResponseSchema } from "@xochi/client";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import {
  renderTrade,
  apiStub,
  L1_STEALTH_CAPABILITIES,
  TEST_ACCOUNT,
  type StubbedRoute,
} from "./harness.js";
import { Trade } from "../Trade.js";
import { STORAGE_KEYS } from "../../constants.js";
import type { SwapActivityItem } from "../../types/activity.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { CLAIM_IN_XOCHI_APP } from "../../components/widgetTabsContext.js";
import { parseEmbedParams } from "@xochi/widget-lib";
import { FULL_LOOK, claimsPath, embedLook, type EmbedLook } from "./embedParams.js";

// Longest test: "keeps a way to claim after the receipt closes, with no wallet
// session" -- 1 render, 5 waits (stealth landing, the dialog, its Claim
// payment, the dialog closing, the claims row).
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 5 }) });

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_L1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const look = (search: string): EmbedLook => embedLook(parseEmbedParams(search));

function hostedConnection(onRequest: () => void) {
  return {
    walletUi: () => "host" as const,
    requestConnect: onRequest,
    onWalletUi: (listener: (owner: "widget" | "host") => void) => {
      listener("host");
      return () => undefined;
    },
  };
}

const stubApi = (routes: Record<string, StubbedRoute> = {}): void => {
  const body = QuoteResponseSchema.parse(quoteWire({ to_amount: "998000000" }));
  vi.stubGlobal("fetch", apiStub({ "/api/intent/quote": { body }, ...routes }));
};

/** A stealth order to Ethereum, in flight when the page was left. */
const seedStealthOrder = (): void => {
  const record: SwapActivityItem = {
    id: "xi_stealth_l1",
    type: "swap",
    timestamp: Date.now() - 60_000,
    status: "pending",
    intentStatus: "settling",
    data: {
      fromChainId: 8453,
      toChainId: 1,
      fromToken: USDC_BASE,
      toToken: USDC_L1,
      fromAmount: "5000000",
      toAmount: "4989000",
      tier: "Standard",
      feeRate: 0.22,
      txHash: null,
      isCrossChain: true,
      settlementType: "stealth",
    },
  };
  window.localStorage.setItem(
    `${STORAGE_KEYS.localActivityPrefix}${TEST_ACCOUNT.toLowerCase()}`,
    JSON.stringify([record]),
  );
};

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

beforeEach(() => {
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  sessionStorage.clear();
  intentAPI.clearQuoteCache();
  window.history.replaceState(null, "", "/");
});

describe("layout=swap", () => {
  it("shows the card without tabs, and keeps the account chip", async () => {
    stubApi();
    await renderTrade(<Trade look={look("layout=swap")} />, { connected: true });

    expect(await screen.findByRole("button", { name: /^Account / }, WAIT)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.queryByRole("region", { name: "Transaction log" })).toBeNull();
    expect(screen.getByLabelText("Send")).toBeTruthy();
  });

  it("hides account chrome when the host owns wallet UI", async () => {
    stubApi({ "/api/capabilities": L1_STEALTH_CAPABILITIES });
    await renderTrade(
      <Trade look={look("layout=swap")} hostConnection={hostedConnection(() => undefined)} />,
      { connected: true },
    );

    expect(screen.queryByRole("button", { name: /^Account / })).toBeNull();
  });

  it("asks the host to connect instead of opening widget wallet UI", async () => {
    stubApi({ "/api/capabilities": L1_STEALTH_CAPABILITIES });
    let requests = 0;
    await renderTrade(
      <Trade
        look={look("layout=swap")}
        hostConnection={hostedConnection(() => {
          requests += 1;
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(requests).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the full widget on Claims from the stealth receipt's Claim payment", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    stubApi({
      "/status": {
        body: statusWire({ intent_id: "xi_stealth_l1", status: "completed", terminal: true }),
      },
    });
    seedStealthOrder();
    await renderTrade(<Trade look={look("layout=swap&theme=light")} />, { connected: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);

    fireEvent.click(await screen.findByRole("button", { name: "Claim payment" }, WAIT));
    expect(open).toHaveBeenCalledWith(claimsPath("light"), "_blank", "noopener,noreferrer");
    expect(claimsPath("light")).toBe("/embed?theme=light#claims");
    // The receipt stays behind the tab it opened, and no tab row appeared.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("sends the claims nudge to the full widget too", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    withClaimable();
    await renderTrade(<Trade look={look("layout=swap")} />, { connected: true });

    fireEvent.click(await screen.findByRole("button", { name: /ready to claim/ }, WAIT));
    expect(open).toHaveBeenCalledWith("/embed#claims", "_blank", "noopener,noreferrer");
  });

  /**
   * The panel in stealth mode, as after a stealth swap made in this frame. The
   * frame opens on stealth only once the solver's stealth chains land (the
   * fallback leaves them unknown), and a resume moves the panel off what it
   * opened on, so the wallet connects (and the order resumes) after that.
   */
  async function openStealthFrameThenResume(hostWallet = false): Promise<void> {
    window.history.replaceState(null, "", "/embed?layout=swap&toChain=1&settlement=stealth");
    const { config } = await renderTrade(<Trade look={look("layout=swap")} />, { hostWallet });
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      WAIT,
    );
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
  }

  it("keeps a way to claim after the receipt closes, with no wallet session", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    stubApi({
      "/api/capabilities": L1_STEALTH_CAPABILITIES,
      "/status": {
        body: statusWire({ intent_id: "xi_stealth_l1", status: "completed", terminal: true }),
      },
    });
    seedStealthOrder();
    await openStealthFrameThenResume();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);
    await screen.findByRole("button", { name: "Claim payment" }, WAIT);
    // No copy in a tabless frame points at a tab it does not have.
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Claims tab|Activity/);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    fireEvent.click(
      await screen.findByRole("button", { name: /Claim your private payment/ }, WAIT),
    );
    expect(open).toHaveBeenCalledWith("/embed#claims", "_blank", "noopener,noreferrer");
  });

  it("on the host page's wallet, offers no Claim payment and says to claim in the Xochi app", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    stubApi({
      "/api/capabilities": L1_STEALTH_CAPABILITIES,
      "/status": {
        body: statusWire({ intent_id: "xi_stealth_l1", status: "completed", terminal: true }),
      },
    });
    seedStealthOrder();
    await openStealthFrameThenResume(true);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);
    await waitFor(
      () => expect(screen.getByRole("dialog").textContent).toContain(CLAIM_IN_XOCHI_APP),
      WAIT,
    );
    expect(screen.queryByRole("button", { name: "Claim payment" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    // The row after the card says where to claim and opens nothing.
    const note = await screen.findByRole("note", {}, WAIT);
    expect(note.textContent).toContain(CLAIM_IN_XOCHI_APP);
    expect(screen.queryByRole("button", { name: /Claim your private payment/ })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the full widget at #claims", () => {
  it("lands on Claims once the wallet is there", async () => {
    window.history.replaceState(null, "", "/embed#claims");
    withClaimable();
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });

    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: /^Claims/ }).getAttribute("aria-selected")).toBe(
          "true",
        ),
      WAIT,
    );
  });

  const claimsSelected = (): string | null =>
    screen.getByRole("tab", { name: /^Claims/ }).getAttribute("aria-selected");

  it("waits for a wallet that connects after the first render", async () => {
    window.history.replaceState(null, "", "/embed#claims");
    withClaimable();
    const { config } = await renderTrade(<Trade look={FULL_LOOK} />);
    expect(screen.queryByRole("tab", { name: /^Claims/ })).toBeNull();

    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    await waitFor(() => expect(claimsSelected()).toBe("true"), WAIT);
  });

  it("lets a tab picked before the wallet connects win", async () => {
    window.history.replaceState(null, "", "/embed#claims");
    withClaimable();
    const { config } = await renderTrade(<Trade look={FULL_LOOK} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Activity/ }));

    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    await screen.findByRole("tab", { name: /^Claims/ }, WAIT);
    expect(claimsSelected()).toBe("false");
    expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("stays tabless at #claims in layout=swap", async () => {
    window.history.replaceState(null, "", "/embed#claims");
    withClaimable();
    await renderTrade(<Trade look={look("layout=swap")} />, { connected: true });
    await screen.findByRole("button", { name: /ready to claim/ }, WAIT);
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("howItWorks and height", () => {
  it("drops the How it works disclosure on howItWorks=0 only", async () => {
    stubApi();
    await renderTrade(<Trade look={look("howItWorks=0")} />);
    expect(screen.queryByRole("button", { name: /How it works/ })).toBeNull();
    // The custody and fee facts stay, in one line.
    expect(
      screen.getByText(
        "Self-custody: you sign from your own wallet. Privacy is part of the trading fee, never an extra charge.",
      ),
    ).toBeTruthy();
    cleanup();

    await renderTrade(<Trade look={look("howItWorks=1")} />);
    expect(screen.getByRole("button", { name: /How it works/ })).toBeTruthy();
    expect(screen.queryByText(/^Self-custody: you sign from your own wallet/)).toBeNull();
  });

  it("fixes the widget's height, never past the frame, only when asked", async () => {
    stubApi();
    await renderTrade(<Trade look={look("layout=swap&height=640")} />);
    const main = document.querySelector<HTMLElement>("main.launch-screen");
    expect(main?.classList.contains("launch-screen--fixed")).toBe(true);
    expect(main?.classList.contains("launch-screen--full")).toBe(false);
    // The cap to the frame (max-height 100vh/100dvh) is in launch.css.
    expect(main?.style.height).toBe("640px");
    cleanup();

    await renderTrade(<Trade look={FULL_LOOK} />);
    const free = document.querySelector<HTMLElement>("main.launch-screen");
    expect(free?.classList.contains("launch-screen--fixed")).toBe(false);
    expect(free?.classList.contains("launch-screen--full")).toBe(true);
    expect(free?.style.height).toBe("");
  });
});
