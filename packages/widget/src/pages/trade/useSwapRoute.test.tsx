// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseWidgetCapabilities } from "../../hooks/useCapabilities.js";
import { TRUST_FEATURES_OFF } from "@xochi/client";
import { TOKENS, findTokenBySymbol } from "./config.js";
import { OPEN_POLICY, type EmbedPolicy } from "./embedParams.js";
import { useSwapRoute } from "./useSwapRoute.js";
import { SIMPLE_ACCOUNT_FACTORY, type SelectableChainId } from "@xochi/client";

const token = (chainId: SelectableChainId, symbol: string) => {
  const found = findTokenBySymbol(chainId, symbol);
  if (!found) throw new Error(`${symbol} missing on ${chainId}`);
  return found;
};

const matrix = {
  cross_chain_only: false,
  chains: [1, 10, 8453, 42161].map((chain_id) => ({
    chain_id,
    vm_type: "evm",
    ...(chain_id === 1 ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : {}),
  })),
  tokens: ["USDC", "USDT", "DAI", "EURe", "ZCHF"].map((symbol) => {
    const deployments = [1, 10, 8453, 42161].flatMap((chainId) => {
      const deployment = TOKENS[chainId as SelectableChainId].find(
        (entry) => entry.symbol === symbol,
      );
      return deployment ? [deployment] : [];
    });
    const first = deployments[0];
    if (!first) throw new Error(`${symbol} has no configured deployment`);
    return {
      symbol,
      roles: ["origin", "destination"],
      decimals: first.decimals,
      addresses: Object.fromEntries(
        deployments.map((deployment) => [deployment.chainId, deployment.address]),
      ),
    };
  }),
  conversion_pairs: [
    { from: "USDC", to: "DAI", same_chain: true },
    { from: "USDC", to: "EURe", same_chain: true },
    { from: "USDC", to: "ZCHF", same_chain: true },
    { from: "ZCHF", to: "USDC", same_chain: true },
  ],
  stealth_chains: [1],
  routes: [
    {
      origin: { chain_id: 8453, token: "USDC" },
      destination: { kind: "chain", chain_id: 42161, token: "USDC" },
      privacy_modes: ["public"],
    },
    {
      origin: { chain_id: 42161, token: "USDC" },
      destination: { kind: "chain", chain_id: 8453, token: "USDC" },
      privacy_modes: ["public"],
    },
    {
      origin: { chain_id: 8453, token: "USDC" },
      destination: { kind: "chain", chain_id: 1, token: "USDC" },
      privacy_modes: ["public", "stealth"],
    },
    ...["DAI", "EURe", "ZCHF"].map((symbol) => ({
      origin: { chain_id: 8453, token: "USDC" },
      destination: { kind: "chain" as const, chain_id: 1, token: symbol },
      privacy_modes: ["public"],
    })),
    {
      origin: { chain_id: 1, token: "USDC" },
      destination: { kind: "chain", chain_id: 8453, token: "USDC" },
      privacy_modes: ["public"],
    },
    {
      origin: { chain_id: 8453, token: "USDC" },
      destination: { kind: "zk_money", token: "DAI" },
      privacy_modes: ["public"],
    },
    {
      origin: { chain_id: 1, token: "USDC" },
      destination: { kind: "zk_money", token: "DAI" },
      privacy_modes: ["public"],
    },
  ],
};

function routeHook(
  over: Record<string, unknown> = {},
  policy: EmbedPolicy = OPEN_POLICY,
  capabilitiesAvailable = true,
) {
  const caps = parseWidgetCapabilities({ ...matrix, ...over });
  if (!caps) throw new Error("invalid test capabilities");
  const client = new QueryClient();
  if (capabilitiesAvailable) {
    client.setQueryData(["capabilities"], { caps, source: "live", features: TRUST_FEATURES_OFF });
  } else {
    client.setQueryDefaults(["capabilities"], { enabled: false });
  }
  let originChanges = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () =>
      useSwapRoute({
        policy,
        onOriginChange: () => {
          originChanges += 1;
        },
        onDestinationChainChange: () => {},
        onDestinationTokenChange: () => {},
        onFlip: () => {},
      }),
    { wrapper },
  );
  return { ...rendered, client, originChanges: () => originChanges };
}

afterEach(cleanup);

describe("live route discovery", () => {
  it("blocks route selection and quoting until exact capabilities are available", () => {
    const { result } = routeHook({}, OPEN_POLICY, false);
    expect(result.current.capabilityState).toBe("fallback");
    expect(result.current.routeCheck.status).not.toBe("supported");
    expect(result.current.routeBlocked).toBe(true);
    expect(result.current.sourceChainIds).toContain(8453);
    expect(result.current.destinationChainIds).toContain(42161);
    expect(
      [...result.current.originTokensByChain.values()]
        .flat()
        .some((entry) => entry.symbol === "WETH"),
    ).toBe(false);
    expect(result.current.zkMoneyOffered).toBe(false);
  });

  it("does not infer same-chain support while capabilities are unavailable", () => {
    const { result } = routeHook({}, OPEN_POLICY, false);
    act(() =>
      result.current.applyRoute({
        fromChainId: 1,
        toChainId: 1,
        fromToken: token(1, "DAI"),
        toToken: token(1, "DAI"),
      }),
    );
    expect(result.current.routeCheck.status).not.toBe("supported");
    expect(result.current.routeBlocked).toBe(true);
  });

  it("exposes only typed-route inventories and route-scoped privacy", () => {
    const { result } = routeHook();

    expect(result.current.sourceChainIds).toEqual([1, 8453, 42161]);
    expect(result.current.destinationChainIds).toEqual([1, 8453, 42161]);
    expect(
      [...result.current.originTokensByChain.values()]
        .flat()
        .some((entry) => entry.symbol === "WETH"),
    ).toBe(false);
    expect(
      [...result.current.destinationTokensByChain.values()]
        .flat()
        .some((entry) => entry.symbol === "WETH"),
    ).toBe(false);
    expect(result.current.selectedPrivacyModes).toEqual(["public"]);
    expect(result.current.stealthDestinationChainIds).toEqual([1]);
  });

  it("repairs Stealth destinations only to the selected receive symbol", () => {
    const routes = matrix.routes.map((route) =>
      "chain_id" in route.destination &&
      route.destination.chain_id === 1 &&
      route.destination.token === "DAI"
        ? { ...route, privacy_modes: ["public", "stealth"] }
        : route,
    );
    const { result } = routeHook({ routes });

    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(true);
    expect(result.current.stealthDestinationChainIds).toEqual([1]);

    act(() => result.current.handleStealthDestinationChange(1));
    expect(result.current.zkMoneyDestination).toBe(false);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.selectedPrivacyModes).toEqual(["public", "stealth"]);
  });

  it("reports Stealth unavailable when only another receive symbol supports it", () => {
    const { result } = routeHook();

    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(true);

    expect(result.current.stealthDestinationChainIds).toEqual([]);
    act(() => result.current.handleStealthDestinationChange(1));
    expect(result.current.zkMoneyDestination).toBe(true);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.selectedPrivacyModes).toEqual(["public"]);
  });

  it.each([
    {
      field: "address",
      address: "0x9999999999999999999999999999999999999999",
      decimals: token(42161, "USDC").decimals,
    },
    {
      field: "decimals",
      address: token(42161, "USDC").address,
      decimals: 8,
    },
  ])(
    "recanonicalizes a selected deployment when its $field changes on the same chain",
    async ({ address, decimals }) => {
      const { result, client } = routeHook();
      const refreshed = parseWidgetCapabilities({
        ...matrix,
        tokens: matrix.tokens.map((capability) =>
          capability.symbol === "USDC"
            ? {
                ...capability,
                decimals,
                addresses: {
                  ...capability.addresses,
                  [42161]: address,
                },
              }
            : capability,
        ),
      });
      if (!refreshed) throw new Error("invalid refreshed capabilities");

      act(() => {
        client.setQueryData(["capabilities"], {
          caps: refreshed,
          source: "live",
          features: TRUST_FEATURES_OFF,
        });
      });

      await waitFor(() => {
        expect(result.current.toChainId).toBe(42161);
        expect(result.current.toToken).toMatchObject({
          symbol: "USDC",
          chainId: 42161,
          address,
          decimals,
        });
        expect(result.current.routeCheck).toEqual({ status: "supported" });
      });
    },
  );

  it("repairs the opposite leg to the nearest exact route", () => {
    const { result } = routeHook();

    act(() => result.current.handleToTokenChange(token(8453, "USDC")));

    expect(result.current.fromChainId).toBe(1);
    expect(result.current.fromToken).toEqual(token(1, "USDC"));
    expect(result.current.toChainId).toBe(8453);
    expect(result.current.routeCheck).toEqual({ status: "supported" });
  });

  it("reverses only when the reversed exact route is advertised", () => {
    const { result } = routeHook();
    expect(result.current.flipBlockedReason).toBeNull();

    act(() => result.current.handleSwapTokens());

    expect(result.current.fromChainId).toBe(42161);
    expect(result.current.toChainId).toBe(8453);
    expect(result.current.routeCheck).toEqual({ status: "supported" });
  });

  it("keeps Base USDC as the origin of the advertised zk.money DAI deposit", () => {
    const { result, originChanges } = routeHook();
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(true);
    expect(result.current.fromChainId).toBe(8453);
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.toChainId).toBe(1);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.routeCheck).toEqual({ status: "supported" });
    expect(originChanges()).toBe(0);
  });

  it("keeps the tag destination when selecting another supported source deployment", () => {
    const { result } = routeHook();
    act(() => result.current.selectZkMoneyDestination());
    act(() => {
      result.current.handleFromChainChange(1);
      result.current.handleFromTokenChange(token(1, "USDC"));
    });
    expect(result.current.zkMoneyDestination).toBe(true);
    expect(result.current.fromToken).toEqual(token(1, "USDC"));
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.routeCheck).toEqual({ status: "supported" });
  });

  it("does not advertise unallowlisted source conversions to the tag rail", () => {
    const { result } = routeHook();
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.classifyOriginToken(token(8453, "USDT")).state).toBe("unsupported");
    act(() => result.current.handleFromTokenChange(token(8453, "USDT")));
    expect(result.current.fromToken.symbol).toBe("USDC");
    expect(result.current.zkMoneyDestination).toBe(true);
  });

  it("does not mistake DAI metadata for same-chain identity support", () => {
    const { result } = routeHook();
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.classifyOriginToken(token(1, "DAI")).state).toBe("unsupported");
  });

  it("keeps cross-chain DAI, EURe and ZCHF destinations available", () => {
    const { result } = routeHook();
    for (const symbol of ["DAI", "EURe", "ZCHF"]) {
      expect(result.current.classifyDestinationToken(token(1, symbol)).state).toBe("available");
    }
    act(() => {
      result.current.handleToChainChange(1);
      result.current.handleToTokenChange(token(1, "DAI"));
    });
    expect(result.current.fromChainId).toBe(8453);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.routeCheck).toEqual({ status: "supported" });
  });

  it("honors exact zk.money routes instead of inferring them from chain routes", () => {
    const { result } = routeHook({
      routes: [
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "chain", chain_id: 1, token: "DAI" },
          privacy_modes: ["public"],
        },
      ],
    });
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.routeCheck.status).toBe("unsupported");
  });

  it("preserves host origin locks and destination allowlists", () => {
    const { result } = routeHook(
      {},
      {
        ...OPEN_POLICY,
        locks: ["fromChain"],
        fromChains: [8453],
        buyTokens: ["DAI"],
        toChains: [1],
      },
    );
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.routeCheck).toEqual({ status: "supported" });
    act(() => result.current.handleFromChainChange(1));
    expect(result.current.fromChainId).toBe(8453);
    expect(result.current.classifyOriginToken(token(1, "USDC")).state).toBe("unsupported");
  });

  it("does not select zk.money outside a host's buy policy", () => {
    const { result } = routeHook({}, { ...OPEN_POLICY, buyTokens: ["USDC"] });
    expect(result.current.zkMoneyOffered).toBe(false);
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(false);
  });
});
