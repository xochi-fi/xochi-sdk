// @vitest-environment jsdom

/**
 * The frame opens on its URL parameters (xochi-widget#21).
 *
 * Rendered through the real panel and provider stack: the parameters are read
 * from `window.location` at mount, exactly as on /embed. What must stay true:
 *   - valid parameters set the opening chains, tokens, amount and settlement;
 *   - parameters the frame cannot honour are ignored, with no error on screen;
 *   - a pair the fallback matrix could not judge, refused once the live matrix
 *     answers, goes back to the default route instead of opening on a refusal.
 * The parsing and resolution rules themselves are pinned in embedParams.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { connect, disconnect } from "@wagmi/core";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { SIMPLE_ACCOUNT_FACTORY, TRON_CHAIN_ID, type SelectableChainId } from "@xochi/client";
import { findTokenBySymbol } from "./config.js";
import { quoteWire } from "../../test/intentHarness.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 5 }) });

/** The worker's `/api/capabilities` envelope for a live matrix. */
const LIVE_CHAIN_IDS = [1, 10, 8453, 42161] as const;
const capabilityToken = (
  symbol: string,
  chainIds: readonly SelectableChainId[] = LIVE_CHAIN_IDS,
  roles: readonly string[] = ["origin", "destination"],
) => {
  const deployments = chainIds.flatMap((chainId) => {
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

const liveCapabilities = (pairs: { from: string; to: string }[]) => {
  const tokenPairs = [{ from: "USDC", to: "USDC" }, ...pairs];
  return {
    source: "live",
    capabilities: {
      cross_chain_only: true,
      chains: LIVE_CHAIN_IDS.map((chain_id) => ({
        chain_id,
        chain_name:
          chain_id === 1
            ? "Ethereum"
            : chain_id === 10
              ? "Optimism"
              : chain_id === 8453
                ? "Base"
                : "Arbitrum",
        vm_type: "evm",
        ...(chain_id === 1 || chain_id === 8453
          ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
          : {}),
      })),
      tokens: [capabilityToken("USDC"), capabilityToken("USDT")],
      routes: tokenPairs.flatMap(({ from, to }) =>
        LIVE_CHAIN_IDS.flatMap((fromChainId) =>
          LIVE_CHAIN_IDS.filter((toChainId) => toChainId !== fromChainId).map((toChainId) => ({
            origin: { chain_id: fromChainId, token: from },
            destination: { kind: "chain", chain_id: toChainId, token: to },
            privacy_modes:
              toChainId === 1 || toChainId === 8453 ? ["public", "stealth"] : ["public"],
          })),
        ),
      ),
      stealth_chains: [8453, 1],
    },
  };
};

const SELECTOR_CAPABILITIES = {
  source: "live",
  capabilities: {
    cross_chain_only: true,
    chains: [
      { chain_id: 1, chain_name: "Ethereum", vm_type: "evm" },
      { chain_id: 8453, chain_name: "Base", vm_type: "evm" },
      { chain_id: 42161, chain_name: "Arbitrum", vm_type: "evm" },
      { chain_id: TRON_CHAIN_ID, chain_name: "Tron", vm_type: "tvm" },
    ],
    tokens: [
      capabilityToken("USDC", [8453, 42161]),
      capabilityToken("DAI", [1], ["destination"]),
      capabilityToken("USDT", [TRON_CHAIN_ID], ["destination"]),
      capabilityToken("WETH", [8453, 42161], ["destination"]),
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
        privacy_modes: ["public"],
      },
      {
        origin: { chain_id: 8453, token: "USDC" },
        destination: { kind: "chain", chain_id: TRON_CHAIN_ID, token: "USDT" },
        privacy_modes: ["public"],
      },
    ],
  },
};

/** Load the frame URL the way a host would, then mount the panel. */
async function openFrame(
  search: string,
  pairs: { from: string; to: string }[],
  connected = false,
  onWalletRpc?: (method: string) => void,
) {
  window.history.replaceState({}, "", `/embed${search}`);
  vi.stubGlobal(
    "fetch",
    apiStub({ "/api/capabilities": { body: liveCapabilities(pairs) } }, { onWalletRpc }),
  );
  return renderTrade(<SwapPanel />, {
    connected,
    automaticRoute: true,
    walletChainId: connected ? 8453 : undefined,
  });
}

/** [send, receive] token symbols, read off the selector buttons. */
const tokens = (): string[] =>
  screen
    .getAllByRole("button", { name: / - Change token$/ })
    .map((b) => b.getAttribute("aria-label")?.replace(" - Change token", "") ?? "");

/** [send, receive] chain names, read off the chain badges. */
const chains = (): string[] =>
  screen
    .getAllByRole("button", { name: /^On .* - Change network$/ })
    .map((b) => b.getAttribute("aria-label")?.replace(/^On (.*) - Change network$/, "$1") ?? "");

const payAmount = (): string =>
  (document.getElementById("swap-pay-amount") as HTMLInputElement | null)?.value ?? "";

const pressed = (name: RegExp): string | null =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
  window.history.replaceState({}, "", "/");
});

describe("frame URL parameters", () => {
  it("open the panel on the requested route, amount and settlement", async () => {
    await openFrame("?fromChain=10&toChain=1&sell=usdt&amount=250&settlement=stealth", [
      { from: "USDT", to: "USDC" },
    ]);

    await waitFor(() => expect(tokens()).toEqual(["USDT", "USDC"]), WAIT);
    expect(chains()).toEqual(["Optimism", "Ethereum"]);
    expect(payAmount()).toBe("250");
    // Explicit Stealth remains selected while capability/setup fixes are pending.
    await waitFor(() => expect(pressed(/^Stealth/)).toBe("true"), WAIT);
    expect(pressed(/^Public/)).toBe("false");
  });

  it("opens Base stealth once the live matrix answers", async () => {
    await openFrame("?fromChain=1&toChain=8453&settlement=stealth", []);

    await waitFor(() => expect(pressed(/^Stealth/)).toBe("true"), WAIT);
    expect(chains()).toEqual(["Ethereum", "Base"]);
    expect(pressed(/^Public/)).toBe("false");
  });

  it("ignores invalid route fields without downgrading explicit Stealth", async () => {
    await openFrame("?fromChain=999&toChain=10&sell=DOGE&amount=abc&settlement=stealth", []);

    await waitFor(() => expect(tokens()).toEqual(["USDC", "USDC"]), WAIT);
    // The destination is kept and Stealth stays selected with its destination fix.
    expect(chains()).toEqual(["Base", "Optimism"]);
    expect(payAmount()).toBe("");
    expect(pressed(/^Stealth/)).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drop a pair the live matrix refuses once it answers", async () => {
    // The static fallback carries no typed routes, so USDT -> USDC cannot be
    // judged at mount; the live route list then omits it.
    await openFrame("?sell=USDT&amount=40", []);

    await waitFor(() => expect(tokens()).toEqual(["USDC", "USDC"]), WAIT);
    expect(chains()).toEqual(["Base", "Arbitrum"]);
    // The amount was 40 USDT; it does not carry over to a different coin.
    expect(payAmount()).toBe("");
    expect(screen.queryByText("Route not supported")).toBeNull();
  });

  it("honors a cold-load buy preset when the fallback route offers different privacy", async () => {
    window.history.replaceState({}, "", "/embed?toChain=1&buy=DAI");
    const live = liveCapabilities([]);
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/capabilities": {
          body: {
            ...live,
            capabilities: {
              ...live.capabilities,
              tokens: [...live.capabilities.tokens, capabilityToken("DAI", [1], ["destination"])],
              routes: [
                ...live.capabilities.routes,
                {
                  origin: { chain_id: 8453, token: "USDC" },
                  destination: { kind: "chain", chain_id: 1, token: "DAI" },
                  privacy_modes: ["public"],
                },
              ],
            },
          },
        },
      }),
    );
    await renderTrade(<SwapPanel />, { automaticRoute: true });
    await waitFor(() => expect(tokens()[1]).toBe("DAI"), WAIT);
    expect(pressed(/^Public/)).toBe("true");
  });

  it.each([false, true])(
    "defaults an eligible route to Stealth without a prompt (connected: %s)",
    async (connected) => {
      const prompts: string[] = [];
      await openFrame("", [], connected, (method) => prompts.push(method));
      await waitFor(() => expect(pressed(/^Stealth/)).toBe("true"), WAIT);
      expect(window.location.search).toBe("");
      expect(chains()).toEqual(["Base", "Ethereum"]);
      expect(
        prompts.filter((method) => method === "personal_sign" || method === "eth_sign"),
      ).toEqual([]);
      if (connected) {
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "Set up Stealth" }).disabled,
        ).toBe(false);
      }
    },
  );

  it("preserves an explicit Public preference on an eligible route", async () => {
    const { config } = await openFrame("?toChain=1&settlement=public", []);
    await waitFor(
      () =>
        expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Stealth/ }).disabled).toBe(
          false,
        ),
      WAIT,
    );
    expect(pressed(/^Public/)).toBe("true");
    expect(chains()).toEqual(["Base", "Ethereum"]);
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    expect(pressed(/^Public/)).toBe("true");
    await act(async () => {
      await disconnect(config);
    });
    expect(pressed(/^Public/)).toBe("true");
  });

  it("defaults a newly selected eligible route to Stealth until Public is chosen", async () => {
    await openFrame("?toChain=42161", []);
    const chooseDestination = async (current: string, next: string): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: `On ${current} - Change network` }));
      const dialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
      const option = await waitFor(() => {
        const row = within(dialog).getByRole("button", { name: new RegExp(`^${next}\\b`) });
        expect(row.getAttribute("aria-disabled")).not.toBe("true");
        return row;
      }, WAIT);
      fireEvent.click(option);
    };
    await chooseDestination("Arbitrum", "Ethereum");
    await waitFor(() => expect(pressed(/^Stealth/)).toBe("true"), WAIT);
    fireEvent.click(screen.getByRole("button", { name: /^Public/ }));
    await chooseDestination("Ethereum", "Arbitrum");
    await chooseDestination("Arbitrum", "Ethereum");
    expect(pressed(/^Public/)).toBe("true");
  });

  it("switches to the origin chain before asking for Stealth key setup", async () => {
    window.history.replaceState({}, "", "/embed?toChain=1");
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      apiStub(
        { "/api/capabilities": { body: liveCapabilities([]) } },
        { onWalletRpc: (method) => prompts.push(method) },
      ),
    );
    await renderTrade(<SwapPanel />, { connected: true, walletChainId: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Base" }, WAIT));
    const setup = await screen.findByRole<HTMLButtonElement>(
      "button",
      { name: "Set up Stealth" },
      WAIT,
    );
    expect(setup.disabled).toBe(false);
    expect(pressed(/^Stealth/)).toBe("true");
    expect(prompts.filter((method) => method === "personal_sign" || method === "eth_sign")).toEqual(
      [],
    );
  });

  it("keeps Stealth after rejected setup and quotes only after an explicit retry provides keys", async () => {
    window.history.replaceState({}, "", "/embed?toChain=1");
    const bodies: Record<string, unknown>[] = [];
    let rejectSetup = true;
    vi.stubGlobal(
      "fetch",
      apiStub(
        {
          "/api/capabilities": { body: liveCapabilities([]) },
          "/api/intent/quote": {
            answer: (request) => {
              if (typeof request !== "object" || request === null)
                throw new Error("quote body missing");
              bodies.push({ ...request });
              return quoteWire({
                can_solve: false,
                error: "No fill available",
                error_category: "no_liquidity",
              });
            },
          },
        },
        {
          onWalletRpc: (method) => {
            if (rejectSetup && (method === "personal_sign" || method === "eth_sign")) {
              throw new Error("User rejected Stealth setup");
            }
          },
        },
      ),
    );
    await renderTrade(<SwapPanel />, { connected: true, walletChainId: 8453 });
    await waitFor(() => expect(pressed(/^Stealth/)).toBe("true"), WAIT);
    fireEvent.change(document.getElementById("swap-pay-amount") as HTMLInputElement, {
      target: { value: "25" },
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Set up Stealth" }).disabled).toBe(
      false,
    );
    expect(bodies).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Set up Stealth" }));
    const retry = await waitFor(
      () => screen.getByRole<HTMLButtonElement>("button", { name: "Retry Stealth setup" }),
      WAIT,
    );
    expect(retry.disabled).toBe(false);
    expect(pressed(/^Stealth/)).toBe("true");
    expect(bodies).toEqual([]);
    rejectSetup = false;
    fireEvent.click(retry);
    await waitFor(
      () =>
        expect(
          bodies.some(
            (body) =>
              body.settlement_preference === "stealth" && body.stealth_meta_address !== undefined,
          ),
        ).toBe(true),
      WAIT,
    );
    expect(pressed(/^Stealth/)).toBe("true");
    expect(bodies.every((body) => body.settlement_preference === "stealth")).toBe(true);
  });
});

describe("capability-driven trade selectors", () => {
  it("selects DAI and Tron from typed routes without inventing WETH or duplicate trade UI", async () => {
    vi.stubGlobal("fetch", apiStub({ "/api/capabilities": { body: SELECTOR_CAPABILITIES } }));
    await renderTrade(<SwapPanel />);
    await waitFor(() => expect(tokens()).toEqual(["USDC", "USDC"]), WAIT);

    fireEvent.click(screen.getAllByRole("button", { name: "USDC - Change token" })[1]!);
    const tokenDialog = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    await within(tokenDialog).findByRole("button", { name: "Tron" }, WAIT);
    await waitFor(() => {
      const currentToken = within(tokenDialog)
        .getAllByRole("button", { name: /^USDC/ })
        .find((button) => button.hasAttribute("aria-disabled"));
      expect(currentToken?.getAttribute("aria-disabled")).toBe("false");
    }, WAIT);
    expect(tokenDialog.textContent).not.toContain("WETH");
    const allChains = Array.from(tokenDialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "All",
    );
    if (!allChains) throw new Error("All networks option missing");
    fireEvent.click(allChains);
    const daiButtons = await within(tokenDialog).findAllByRole("button", { name: /^DAI/ }, WAIT);
    fireEvent.click(daiButtons[0]!);

    await waitFor(() => expect(tokens()).toEqual(["USDC", "DAI"]), WAIT);
    expect(chains()).toEqual(["Base", "Ethereum"]);

    fireEvent.click(screen.getByRole("button", { name: "On Ethereum - Change network" }));
    const chainDialog = await screen.findByRole("dialog", { name: "Select network" }, WAIT);
    const tron = Array.from(chainDialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Tron",
    );
    if (!tron) throw new Error("Tron option missing");
    fireEvent.click(tron);

    await waitFor(() => expect(tokens()).toEqual(["USDC", "USDT"]), WAIT);
    expect(chains()).toEqual(["Base", "Tron"]);
    expect(screen.getAllByRole("group", { name: "Settlement privacy" })).toHaveLength(1);
    expect(document.querySelectorAll("#swap-pay-amount")).toHaveLength(1);
    expect(document.querySelectorAll("#swap-receive-amount")).toHaveLength(1);
  });
});
