// @vitest-environment jsdom

/**
 * The live zk.money destination and privacy shortcut. Direct Aztec settlement
 * remains gated (#142); the Ethereum DAI deposit is Public.
 *
 * Rendered through the real panel: zk.money pins DAI on Ethereum, keeps the
 * privacy navigation visible, shows one tag field, and every quote request carries
 * the normalized `recipient_tag` and no `recipient_address`. The Worker's
 * lookup failures distinguish missing tags from outages, which retry only on tap.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { QUOTE_DEBOUNCE_MS, QuoteResponseSchema, SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub, type FetchStub, type StubbedRoute } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { findTokenBySymbol } from "./config.js";
import { parseWidgetCapabilities } from "../../hooks/useCapabilities.js";
import { TRUST_FEATURES_OFF } from "@xochi/client";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

const TAG = "memory-rocky";
const BOUND_ADDRESS = "0x2222222222222222222222222222222222222222";
const CAPABILITY_CHAIN_IDS = [8453, 1, 42161] as const;
const capabilityToken = (symbol: string, roles: readonly string[]) => {
  const deployments = CAPABILITY_CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`${symbol} has no configured deployment`);
  return {
    symbol,
    roles,
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};

/** A live matrix that fills DAI on Ethereum from Base USDC. */
const CAPABILITIES = {
  body: {
    source: "live",
    capabilities: {
      cross_chain_only: true,
      stealth_chains: [1],
      chains: [
        { chain_id: 8453, chain_name: "Base", vm_type: "evm" },
        {
          chain_id: 1,
          chain_name: "Ethereum",
          vm_type: "evm",
          stealth_factory_address: SIMPLE_ACCOUNT_FACTORY,
        },
        { chain_id: 42161, chain_name: "Arbitrum", vm_type: "evm" },
      ],
      tokens: [
        capabilityToken("USDC", ["origin", "destination"]),
        capabilityToken("DAI", ["destination"]),
      ],
      routes: [
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "chain", chain_id: 42161, token: "USDC" },
          privacy_modes: ["public"],
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "chain", chain_id: 1, token: "DAI" },
          privacy_modes: ["public", "stealth"],
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "zk_money", token: "DAI" },
          privacy_modes: ["public"],
        },
      ],
    },
  },
} satisfies StubbedRoute;

/**
 * 1000 USDC in, 998 DAI out, as a preview (the panel is disconnected) that
 * echoes the tag and the address the Worker bound for it.
 */
const taggedQuote = QuoteResponseSchema.parse(
  quoteWire({
    preview: true,
    to_amount: "998000000000000000000",
    min_to_amount: "996000000000000000000",
    cost_bps: 22,
    recipient_tag: TAG,
    recipient_address: BOUND_ADDRESS,
  }),
);

/** The Worker's refusal of a tag it could not resolve. */
const unresolved = QuoteResponseSchema.parse(
  quoteWire({
    can_solve: false,
    error: `${TAG}.zk.money did not resolve`,
    error_category: "tag_unresolved",
    settlement_options: [],
  }),
);

const unavailable = quoteWire({
  success: false,
  can_solve: false,
  error: `We can't look up @${TAG} right now. Please try again.`,
  error_category: "tag_resolution_unavailable",
  settlement_options: [],
});

/** Serves `quote` and records every quote request body. */
function recordingStub(
  quote: unknown,
  bodies: Record<string, unknown>[],
  status = 200,
  capabilities: StubbedRoute = CAPABILITIES,
  walletMethods?: string[],
): FetchStub {
  const rest = apiStub(
    {
      "/api/intent/quote": { body: quote, status },
      "/api/capabilities": capabilities,
    },
    { onWalletRpc: (method) => walletMethods?.push(method) },
  );
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/intent/quote") && typeof init?.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (typeof body === "object" && body !== null) bodies.push({ ...body });
    }
    return rest(input, init);
  };
}

const tagField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>("#swap-recipient-tag");

async function offeredZkMoneyShortcut(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const shortcut = screen.getByRole<HTMLButtonElement>("button", {
      name: /^Shielded/,
    });
    if (shortcut.disabled) throw new Error("zk.money route not offered yet");
    return shortcut;
  }, WAIT);
}

/** Open the destination picker and pick zk.money, as a user does. */
async function pickZkMoney(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "On Arbitrum - Change network" }));
  const option = await waitFor(() => {
    const found = Array.from(
      document.querySelectorAll<HTMLElement>(".token-search-chain-item"),
    ).find((el) => (el.textContent ?? "").includes("zk.money"));
    if (!found) throw new Error("zk.money not offered");
    return found;
  }, WAIT);
  fireEvent.click(option);
}

async function quoteToTag(
  quote: unknown,
  connected = false,
  status = 200,
): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", recordingStub(quote, bodies, status));
  await renderTrade(<SwapPanel />, { connected, walletChainId: connected ? 8453 : undefined });
  fireEvent.click(await offeredZkMoneyShortcut());
  const field = await waitFor(() => {
    const input = tagField();
    if (!input) throw new Error("tag field not rendered");
    return input;
  }, WAIT);
  const account = screen.getByRole<HTMLAnchorElement>("link", {
    name: "Need a zk.money account? Create one (opens in new tab)",
  });
  expect(account.href).toBe("https://wallet.zk.money/");
  expect(account.target).toBe("_blank");
  expect(account.rel).toBe("noopener noreferrer");
  fireEvent.change(field, { target: { value: `@${TAG.toUpperCase()}` } });
  fireEvent.change(screen.getByLabelText<HTMLInputElement>("Send"), {
    target: { value: "1000" },
  });
  return bodies;
}

beforeEach(() => {
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
  intentAPI.clearQuoteCache();
});

describe("zk.money destination", () => {
  it("pins DAI on Ethereum through the privacy shortcut and quotes with the tag only", async () => {
    const bodies = await quoteToTag(taggedQuote);

    expect(screen.getByRole("button", { name: "On zk.money - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Shielded/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    expect(bodies.length).toBeGreaterThan(0);
    const dai = findTokenBySymbol(1, "DAI");
    expect(dai).toBeDefined();
    for (const body of bodies) {
      expect(body.recipient_tag).toBe(TAG);
      expect(body).not.toHaveProperty("recipient_address");
      expect(body.to_chain_id).toBe(1);
      expect(String(body.to_token).toLowerCase()).toBe(dai!.address.toLowerCase());
      expect(body.settlement_preference).toBe("public");
    }

    const receipt = document.querySelector(".quote-details")?.textContent ?? "";
    expect(receipt).toContain(`@${TAG} receives ≈ 998`);
    expect(receipt).toContain("DAI");
    expect(receipt).toContain("zk.money charges about $0.35 on arrival");
  });

  it("offers spelling guidance without retry for a confirmed missing tag", async () => {
    await quoteToTag(unresolved, true);

    await waitFor(
      () =>
        expect(document.querySelector(".error-title")?.textContent).toBe(
          `We couldn't find @${TAG}. Check the spelling.`,
        ),
      WAIT,
    );
    // The Worker's verdict is final: no Retry is offered for it.
    expect(document.querySelector(".error-retry-btn")).toBeNull();
    expect(document.querySelector(".error-suggestion")).toBeNull();
    expect(tagField()?.value).toBe(`@${TAG.toUpperCase()}`);
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
  });

  it("retains the tag and route through a 503 and retries lookup only on tap", async () => {
    const bodies = await quoteToTag(unavailable, true, 503);
    const retry = await screen.findByRole<HTMLButtonElement>(
      "button",
      { name: "Retry lookup" },
      WAIT,
    );
    expect(document.querySelector(".error-title")?.textContent).toBe(
      `We can't look up @${TAG} right now. Please try again.`,
    );
    expect(document.querySelector(".error-suggestion")).toBeNull();
    expect(document.querySelector(".error-reason")).toBeNull();
    expect(document.querySelector(".error-countdown")).toBeNull();
    expect(document.querySelector(".quote-details")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
    expect(tagField()?.value).toBe(`@${TAG.toUpperCase()}`);
    expect(screen.getByLabelText<HTMLInputElement>("Send").value).toBe("1000");
    expect(screen.getByRole("button", { name: "On zk.money - Change network" })).toBeTruthy();
    expect(bodies).toHaveLength(1);
    const errorText = document.querySelector(".error-display")?.textContent ?? "";
    expect(errorText).not.toMatch(/HTTP|RPC|provider|stack|network|busy|quote_id/i);

    vi.useFakeTimers();
    try {
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(bodies).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    vi.stubGlobal("fetch", recordingStub({ ...taggedQuote, preview: false }, bodies));
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ ...bodies[0], deadline: bodies[1]?.deadline });
    expect(Number(bodies[1]?.deadline)).toBeGreaterThanOrEqual(Number(bodies[0]?.deadline));
    expect(bodies[1]?.recipient_tag).toBe(TAG);
    expect(bodies[1]).not.toHaveProperty("recipient_address");
    expect(document.querySelector(".error-display")).toBeNull();
    expect(document.querySelector(".quote-details")?.textContent).toContain(`@${TAG} receives`);
  });

  it("guides an invalid tag without requesting a quote", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", recordingStub(taggedQuote, bodies));
    await renderTrade(<SwapPanel />, { connected: true });
    fireEvent.click(await offeredZkMoneyShortcut());
    const field = screen.getByLabelText<HTMLInputElement>("zk.money tag");
    vi.useFakeTimers();
    try {
      fireEvent.change(field, { target: { value: "@invalid.tag" } });
      fireEvent.change(screen.getByLabelText<HTMLInputElement>("Send"), {
        target: { value: "1000" },
      });
      await act(() => vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS * 2));
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(document.querySelector(".recipient-field__error")?.textContent).toBe(
        "Use 1–63 letters, numbers or hyphens.",
      );
      expect(bodies).toHaveLength(0);
      expect(document.querySelector(".error-display")).toBeNull();
      expect(document.querySelector(".quote-details")).toBeNull();
      expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the tag and the pinned pair when the destination moves", async () => {
    await quoteToTag(taggedQuote);
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "On zk.money - Change network" }));
    const option = await waitFor(() => {
      const found = Array.from(
        document.querySelectorAll<HTMLElement>(".token-search-chain-item"),
      ).find((el) => (el.textContent ?? "").includes("Arbitrum"));
      if (!found) throw new Error("Arbitrum not offered");
      return found;
    }, WAIT);
    fireEvent.click(option);

    await waitFor(() => expect(tagField()).toBeNull(), WAIT);
    expect(screen.getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
    expect(document.querySelector('[aria-label="Settlement privacy"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await pickZkMoney();
    await waitFor(() => expect(tagField()?.value).toBe(""), WAIT);
  });

  it("shows zk.money information only for the selected destination and keeps navigation visible", async () => {
    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": CAPABILITIES }));
    await renderTrade(<SwapPanel />);
    expect(document.querySelector(".zkmoney-privacy")).toBeNull();
    expect(screen.queryByRole("link", { name: /Need a zk.money account/ })).toBeNull();

    fireEvent.click(await offeredZkMoneyShortcut());
    expect(document.querySelector(".zkmoney-privacy")).not.toBeNull();
    expect(
      screen.getByRole("group", { name: "Settlement privacy" }).querySelectorAll("button"),
    ).toHaveLength(3);
    expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: /^Public/ }));
    expect(tagField()).toBeNull();
    expect(document.querySelector(".zkmoney-privacy")).toBeNull();
    expect(screen.queryByRole("link", { name: /Need a zk.money account/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("clears the tag and quote when Public is chosen, but not when Shielded is already active", async () => {
    await quoteToTag(taggedQuote);
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: /^Shielded/ }));
    expect(tagField()?.value).toBe(`@${TAG.toUpperCase()}`);
    expect(document.querySelector(".quote-details")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Public/ }));
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(tagField()).toBeNull();
    expect(document.querySelector(".quote-details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Shielded/ }));
    expect(tagField()?.value).toBe("");
  });

  it.each(["token", "network"] as const)(
    "leaves zk.money for Public without changing either leg after %s withdrawal",
    async (withdrawal) => {
      const bodies: Record<string, unknown>[] = [];
      const walletMethods: string[] = [];
      let client: QueryClient | undefined;
      function CapabilityClient() {
        client = useQueryClient();
        return null;
      }
      vi.stubGlobal(
        "fetch",
        recordingStub({ ...taggedQuote, preview: false }, bodies, 200, CAPABILITIES, walletMethods),
      );
      await renderTrade(
        <>
          <CapabilityClient />
          <SwapPanel />
        </>,
        {
          connected: true,
          walletChainId: 8453,
        },
      );
      fireEvent.click(await offeredZkMoneyShortcut());
      fireEvent.change(screen.getByLabelText("zk.money tag"), { target: { value: TAG } });
      fireEvent.change(screen.getByLabelText("Send"), { target: { value: "1000" } });
      await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
      const original = parseWidgetCapabilities(CAPABILITIES.body.capabilities);
      const caps = parseWidgetCapabilities({
        ...CAPABILITIES.body.capabilities,
        chains: CAPABILITIES.body.capabilities.chains.filter(
          (chain) => withdrawal !== "network" || chain.chain_id !== 1,
        ),
        tokens: CAPABILITIES.body.capabilities.tokens.filter(
          (token) => withdrawal !== "token" || token.symbol !== "DAI",
        ),
        routes: [CAPABILITIES.body.capabilities.routes[0]],
      });
      if (!client || !caps || !original) throw new Error("missing withdrawal capabilities");
      const capabilityClient = client;
      act(() =>
        capabilityClient.setQueryData(["capabilities"], {
          caps,
          source: "live",
          features: TRUST_FEATURES_OFF,
        }),
      );
      await waitFor(
        () =>
          expect(
            screen.getByRole<HTMLButtonElement>("button", {
              name: /^Shielded/,
            }).disabled,
          ).toBe(true),
        WAIT,
      );
      const quoteCount = bodies.length;
      fireEvent.click(screen.getByRole("button", { name: /^Public/ }));
      expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(tagField()).toBeNull();
      expect(document.querySelector(".zkmoney-privacy")).toBeNull();
      expect(document.querySelector(".quote-details")).toBeNull();
      expect(screen.getByLabelText<HTMLInputElement>("Send").value).toBe("1000");
      const send = document.getElementById("swap-pay-row")!;
      const receive = document.getElementById("swap-receive-row")!;
      expect(send.querySelector(".token-symbol")?.textContent).toBe("USDC");
      expect(send.querySelector(".chain-badge__name")?.textContent).toBe("Base");
      expect(receive.querySelector(".token-symbol")?.textContent).toBe("DAI");
      expect(receive.querySelector(".chain-badge__name")?.textContent).toBe("Ethereum");
      vi.useFakeTimers();
      try {
        await act(() => vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS * 2));
        expect(bodies).toHaveLength(quoteCount);
      } finally {
        vi.useRealTimers();
      }
      act(() =>
        capabilityClient.setQueryData(["capabilities"], {
          caps: original,
          source: "live",
          features: TRUST_FEATURES_OFF,
        }),
      );
      fireEvent.click(await offeredZkMoneyShortcut());
      expect(tagField()?.value).toBe("");
      expect(
        walletMethods.filter(
          (method) => method === "personal_sign" || method.startsWith("eth_sign"),
        ),
      ).toEqual([]);
    },
  );

  it("leaves a public-only tag quote for Stealth without retaining the tag", async () => {
    const bodies = await quoteToTag(
      QuoteResponseSchema.parse(
        quoteWire({
          preview: false,
          recipient_tag: TAG,
          recipient_address: BOUND_ADDRESS,
          settlement_options: [
            { type: "stealth", available: false, reason: "Tag deposits are public" },
          ],
        }),
      ),
      true,
    );
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    const taggedQuoteCount = bodies.length;
    const stealth = screen.getByRole<HTMLButtonElement>("button", { name: /^Stealth/ });
    expect(stealth.disabled).toBe(false);
    fireEvent.click(stealth);
    await waitFor(() => expect(stealth.getAttribute("aria-pressed")).toBe("true"), WAIT);
    expect(tagField()).toBeNull();
    expect(document.querySelector(".zkmoney-privacy")).toBeNull();
    expect(document.querySelector(".quote-details")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Send").value).toBe("1000");
    expect(screen.getByRole("button", { name: "On Base - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(bodies).toHaveLength(taggedQuoteCount);
    fireEvent.click(screen.getByRole("button", { name: "Set up Stealth" }));
    await waitFor(
      () =>
        expect(
          bodies.some(
            (body) => body.settlement_preference === "stealth" && !("recipient_tag" in body),
          ),
        ).toBe(true),
      WAIT,
    );
  });

  it("leaves the tag rail for Stealth discovery when only a different receive asset is live", async () => {
    const bodies: Record<string, unknown>[] = [];
    const walletMethods: string[] = [];
    const capabilities = {
      body: {
        ...CAPABILITIES.body,
        capabilities: {
          ...CAPABILITIES.body.capabilities,
          routes: CAPABILITIES.body.capabilities.routes.map((route) =>
            route.destination.kind === "chain" && route.destination.chain_id === 1
              ? { ...route, destination: { ...route.destination, token: "USDC" } }
              : route,
          ),
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      recordingStub({ ...taggedQuote, preview: false }, bodies, 200, capabilities, walletMethods),
    );
    await renderTrade(<SwapPanel />, { connected: true, walletChainId: 8453 });
    fireEvent.click(await offeredZkMoneyShortcut());
    fireEvent.change(screen.getByLabelText("zk.money tag"), { target: { value: TAG } });
    fireEvent.change(screen.getByLabelText("Send"), { target: { value: "1000" } });
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    const taggedQuoteCount = bodies.length;

    fireEvent.click(screen.getByRole("button", { name: /^Stealth/ }));
    expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(tagField()).toBeNull();
    expect(document.querySelector(".quote-details")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Send").value).toBe("1000");
    expect(screen.getByRole("button", { name: "On Base - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DAI - Change token" })).toBeTruthy();
    expect(document.querySelector("#stealth-destination-guidance")?.textContent).toContain(
      "isn't a live Stealth",
    );
    vi.useFakeTimers();
    try {
      await act(() => vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS * 2));
      expect(bodies).toHaveLength(taggedQuoteCount);
    } finally {
      vi.useRealTimers();
    }
    expect(
      walletMethods.filter((method) => method === "personal_sign" || method.startsWith("eth_sign")),
    ).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^Shielded/ }));
    expect(tagField()?.value).toBe("");
  });

  it("returns to automatic Stealth after tag navigation without a Public opt-in", async () => {
    const bodies = await quoteToTag(taggedQuote);
    await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
    const tagQuoteCount = bodies.length;
    expect(bodies.every((body) => body.settlement_preference === "public")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "On zk.money - Change network" }));
    const dialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
    const ethereum = within(dialog).getByRole("button", { name: /^Ethereum/ });
    fireEvent.click(ethereum);
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      WAIT,
    );
    expect(tagField()).toBeNull();
    vi.useFakeTimers();
    try {
      await act(() => vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS * 2));
      // The tag's Public wire mode was not an opt-in, and missing Stealth keys
      // must not fall back to another Public quote after leaving the tag rail.
      expect(bodies).toHaveLength(tagQuoteCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["?toChains=42161", "?buyTokens=USDC"])(
    "refuses both zk.money entries when embed policy excludes its fixed pair: %s",
    async (search) => {
      window.history.replaceState({}, "", `/embed${search}`);
      vi.stubGlobal("fetch", apiStub({ "/api/capabilities": CAPABILITIES }));
      await renderTrade(<SwapPanel />);
      const shortcut = screen.getByRole<HTMLButtonElement>("button", { name: /^Shielded/ });
      await waitFor(() => expect(shortcut.disabled).toBe(true), WAIT);
      const reasonId = shortcut.getAttribute("aria-describedby");
      expect(reasonId).toBeTruthy();
      expect(reasonId ? document.getElementById(reasonId)?.textContent?.trim() : "").not.toBe("");
      fireEvent.click(shortcut);
      expect(tagField()).toBeNull();
      expect(screen.getByRole("group", { name: "Settlement privacy" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "On Arbitrum - Change network" }));
      await waitFor(
        () => expect(screen.getByRole("button", { name: /Direct Aztec/ })).toBeTruthy(),
        WAIT,
      );
      expect(
        Array.from(document.querySelectorAll(".token-search-chain-item")).some((option) =>
          option.textContent?.includes("zk.money"),
        ),
      ).toBe(false);
    },
  );
});
