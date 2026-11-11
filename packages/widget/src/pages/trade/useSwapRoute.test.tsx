// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseWidgetCapabilities } from "../../hooks/useCapabilities.js";
import { TRUST_FEATURES_OFF } from "@xochi/client";
import { TOKENS, findTokenBySymbol } from "./config.js";
import { OPEN_POLICY, type EmbedPolicy } from "./embedParams.js";
import { useSwapRoute, type SwapRouteLegs } from "./useSwapRoute.js";
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

const baseStealthMatrix = {
  chains: matrix.chains.map((chain) =>
    chain.chain_id === 8453 ? { ...chain, stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : chain,
  ),
  stealth_chains: [1, 8453],
  routes: [
    ...matrix.routes.map((route) =>
      route.origin.chain_id === 1 &&
      "chain_id" in route.destination &&
      route.destination.chain_id === 8453 &&
      route.destination.token === "USDC"
        ? { ...route, privacy_modes: ["public", "stealth"] }
        : route,
    ),
    {
      origin: { chain_id: 8453, token: "USDC" },
      destination: { kind: "chain", chain_id: 8453, token: "USDT" },
      privacy_modes: ["public", "stealth"],
    },
  ],
};

const baseSelfPair: SwapRouteLegs = {
  fromChainId: 8453,
  fromToken: token(8453, "USDC"),
  toChainId: 8453,
  toToken: token(8453, "USDC"),
};

function routeHook(
  over: Record<string, unknown> = {},
  policy: EmbedPolicy = OPEN_POLICY,
  capabilitiesAvailable = true,
  initial?: SwapRouteLegs,
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
    ({ policy: currentPolicy }) =>
      useSwapRoute({
        policy: currentPolicy,
        initial,
        onOriginChange: () => {
          originChanges += 1;
        },
        onDestinationChainChange: () => {},
        onDestinationTokenChange: () => {},
        onFlip: () => {},
      }),
    { wrapper, initialProps: { policy } },
  );
  return { ...rendered, client, originChanges: () => originChanges };
}

afterEach(cleanup);

describe("live route discovery", () => {
  it("changes only the Stealth origin while Public keeps incumbent opposite-leg repair", () => {
    const initial = {
      fromChainId: 1 as const,
      fromToken: token(1, "USDC"),
      toChainId: 8453 as const,
      toToken: token(8453, "USDC"),
    };
    const { result, originChanges } = routeHook(baseStealthMatrix, OPEN_POLICY, true, initial);
    act(() => result.current.stealthOrigins.handleTokenChange(token(8453, "USDC")));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.toChainId).toBe(8453);
    expect(result.current.routeBlocked).toBe(true);
    expect(result.current.liveStealthDestinations.selectedPairSupported).toBe(false);
    expect(originChanges()).toBe(1);
    act(() => result.current.applyRoute(initial));
    act(() => result.current.handleFromTokenChange(token(8453, "USDC")));
    expect(result.current.toToken).toEqual(token(8453, "USDT"));
    expect(result.current.routeBlocked).toBe(false);
  });

  it("revalidates retained Stealth origin handlers against locks and withdrawn deployments", async () => {
    const { result, client, rerender, originChanges } = routeHook(baseStealthMatrix);
    const retained = result.current.stealthOrigins;
    rerender({ policy: { ...OPEN_POLICY, locks: ["fromChain", "sell"] } });
    act(() => {
      retained.handleTokenChange(token(1, "USDC"));
      retained.handleChainChange(1);
    });
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(originChanges()).toBe(0);
    rerender({ policy: OPEN_POLICY });
    const caps = parseWidgetCapabilities({
      ...matrix,
      ...baseStealthMatrix,
      tokens: matrix.tokens.filter((entry) => entry.symbol !== "USDC"),
      routes: [],
    });
    if (!caps) throw new Error("withdrawn source did not parse");
    act(() =>
      client.setQueryData(["capabilities"], {
        caps,
        source: "live",
        features: TRUST_FEATURES_OFF,
      }),
    );
    await waitFor(() =>
      expect(
        result.current.originTokensByChain.get(1)?.some((entry) => entry.symbol === "USDC") ??
          false,
      ).toBe(false),
    );
    act(() => retained.handleTokenChange(token(1, "USDC")));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.toToken).toEqual(token(42161, "USDC"));
    expect(originChanges()).toBe(0);
  });

  it.each(["stale", "failed", "refreshing"] as const)(
    "refuses retained Stealth origin choices while capabilities are %s",
    async (state) => {
      const { result, client, originChanges } = routeHook(baseStealthMatrix);
      const retained = result.current.stealthOrigins;
      const query = client.getQueryCache().find({ queryKey: ["capabilities"] });
      if (!query) throw new Error("missing capabilities query");
      act(() => {
        if (state === "stale") {
          const caps = parseWidgetCapabilities({ ...matrix, ...baseStealthMatrix });
          if (!caps) throw new Error("invalid stale capabilities");
          client.setQueryData(["capabilities"], {
            caps,
            source: "stale",
            features: TRUST_FEATURES_OFF,
          });
        } else {
          query.setState(
            state === "failed"
              ? {
                  status: "error",
                  error: new Error("capabilities unavailable"),
                  fetchStatus: "idle",
                }
              : { fetchStatus: "fetching" },
          );
        }
      });
      await waitFor(() =>
        expect(result.current.stealthOrigins.classifyToken(token(1, "USDC")).state).toBe(
          "unsupported",
        ),
      );
      act(() => {
        retained.handleTokenChange(token(1, "USDC"));
        retained.handleChainChange(1);
      });
      expect(result.current.fromToken).toEqual(token(8453, "USDC"));
      expect(result.current.toToken).toEqual(token(42161, "USDC"));
      expect(originChanges()).toBe(0);
    },
  );

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

  it("discovers all exact live Stealth assets before any amount or quote without repairing Base USDC", () => {
    const { result, originChanges } = routeHook(baseStealthMatrix, OPEN_POLICY, true, baseSelfPair);
    const picker = result.current.liveStealthDestinations;

    expect(picker.status).toBe("live");
    expect(picker.chainIds).toEqual([1, 8453]);
    expect(picker.tokensByChain.get(8453)?.map((entry) => entry.symbol)).toEqual(["USDT"]);
    expect(picker.selectedPairSupported).toBe(false);
    expect(picker.classifyToken(token(8453, "USDC")).state).toBe("unsupported");
    expect(picker.classifyToken(token(8453, "USDT")).state).toBe("available");
    expect(picker.chainBlockedReason(8453)).toBeNull();
    expect(result.current.stealthDestinationChainIds).toEqual([1]);
    expect(result.current.destinationTokensByChain.get(8453)?.map((entry) => entry.symbol)).toEqual(
      ["USDC", "USDT"],
    );

    act(() => {
      picker.handleTokenChange(token(8453, "USDC"));
      picker.handleTokenChange({ ...token(8453, "USDT"), address: token(8453, "USDC").address });
      picker.handleChainChange(8453);
    });
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(originChanges()).toBe(0);

    act(() => picker.handleTokenChange(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(8453, "USDT"));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.fromChainId).toBe(8453);
    expect(result.current.liveStealthDestinations.selectedPairSupported).toBe(true);
    expect(originChanges()).toBe(0);
  });

  it("offers Base USDC for an exact Ethereum origin instead of globally excluding Base", () => {
    const { result, originChanges } = routeHook(baseStealthMatrix, OPEN_POLICY, true, {
      ...baseSelfPair,
      fromChainId: 1,
      fromToken: token(1, "USDC"),
    });
    expect(result.current.liveStealthDestinations.chainIds).toEqual([8453]);
    expect(result.current.liveStealthDestinations.selectedPairSupported).toBe(true);
    expect(result.current.liveStealthDestinations.classifyToken(token(8453, "USDC")).state).toBe(
      "available",
    );
    act(() => result.current.liveStealthDestinations.handleChainChange(8453));
    expect(result.current.fromToken).toEqual(token(1, "USDC"));
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(originChanges()).toBe(0);
  });

  it.each([
    { name: "missing factory", factory: undefined, chains: [1, 8453] },
    {
      name: "untrusted factory",
      factory: "0x9999999999999999999999999999999999999999",
      chains: [1, 8453],
    },
    { name: "unadvertised Stealth chain", factory: SIMPLE_ACCOUNT_FACTORY, chains: [1] },
  ])("refuses Base destinations with $name", ({ factory, chains }) => {
    const { result } = routeHook({
      ...baseStealthMatrix,
      stealth_chains: chains,
      chains: baseStealthMatrix.chains.map((chain) =>
        chain.chain_id === 8453 ? { ...chain, stealth_factory_address: factory } : chain,
      ),
    });
    expect(result.current.liveStealthDestinations.chainIds).toEqual([1]);
    act(() => result.current.liveStealthDestinations.handleTokenChange(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(42161, "USDC"));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
  });

  it("does not invent Stealth choices from fallback metadata or an absent route matrix", () => {
    const fallback = routeHook({}, OPEN_POLICY, false);
    expect(fallback.result.current.liveStealthDestinations.chainIds).toEqual([]);
    expect(fallback.result.current.liveStealthDestinations.status).toBe("unavailable");
    const absent = routeHook({ ...baseStealthMatrix, routes: undefined });
    expect(absent.result.current.liveStealthDestinations.status).toBe("unavailable");
    expect(absent.result.current.liveStealthDestinations.chainIds).toEqual([]);
    const empty = routeHook({ ...baseStealthMatrix, routes: [] });
    expect(empty.result.current.liveStealthDestinations.status).toBe("live");
    expect(empty.result.current.liveStealthDestinations.chainIds).toEqual([]);
  });

  it.each(["stale", "failed", "refreshing"] as const)(
    "withdraws choices and retained handlers while capabilities are %s",
    async (state) => {
      const { result, client, originChanges } = routeHook(baseStealthMatrix);
      const retained = result.current.liveStealthDestinations;
      expect(retained.classifyToken(token(8453, "USDT")).state).toBe("available");
      const query = client.getQueryCache().find({ queryKey: ["capabilities"] });
      if (!query) throw new Error("missing capabilities query");
      act(() => {
        if (state === "stale") {
          const caps = parseWidgetCapabilities({ ...matrix, ...baseStealthMatrix });
          if (!caps) throw new Error("invalid stale capabilities");
          client.setQueryData(["capabilities"], {
            caps,
            source: "stale",
            features: TRUST_FEATURES_OFF,
          });
        } else {
          query.setState(
            state === "failed"
              ? {
                  status: "error",
                  error: new Error("capabilities unavailable"),
                  fetchStatus: "idle",
                }
              : { fetchStatus: "fetching" },
          );
        }
      });
      await waitFor(() => {
        expect(result.current.liveStealthDestinations.status).toBe(
          state === "refreshing" ? "checking" : "unavailable",
        );
        expect(result.current.liveStealthDestinations.chainIds).toEqual([]);
      });
      act(() => {
        retained.handleTokenChange(token(8453, "USDT"));
        retained.handleChainChange(1);
      });
      expect(result.current.toToken).toEqual(token(42161, "USDC"));
      expect(result.current.fromToken).toEqual(token(8453, "USDC"));
      expect(originChanges()).toBe(0);
    },
  );

  it("revalidates retained handlers against the current origin, exact routes and host policy", async () => {
    const { result, client, rerender, originChanges } = routeHook(baseStealthMatrix);
    const retained = result.current.liveStealthDestinations;
    act(() =>
      result.current.applyRoute({ ...baseSelfPair, fromChainId: 1, fromToken: token(1, "USDC") }),
    );
    act(() => retained.handleTokenChange(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.fromToken).toEqual(token(1, "USDC"));

    act(() => result.current.applyRoute(baseSelfPair));
    rerender({ policy: { ...OPEN_POLICY, locks: ["buy"], toChains: [8453] } });
    expect(result.current.liveStealthDestinations.chainIds).toEqual([]);
    act(() => retained.handleTokenChange(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(8453, "USDC"));

    rerender({
      policy: { ...OPEN_POLICY, locks: ["fromChain", "sell", "toChain"], buyTokens: ["USDT"] },
    });
    expect(result.current.liveStealthDestinations.chainIds).toEqual([8453]);
    const removed = parseWidgetCapabilities({
      ...matrix,
      ...baseStealthMatrix,
      routes: matrix.routes,
    });
    if (!removed) throw new Error("invalid refreshed capabilities");
    act(() =>
      client.setQueryData(["capabilities"], {
        caps: removed,
        source: "live",
        features: TRUST_FEATURES_OFF,
      }),
    );
    await waitFor(() => expect(result.current.liveStealthDestinations.chainIds).toEqual([]));
    act(() => retained.handleTokenChange(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(originChanges()).toBe(0);
  });

  it.each<{ policy: EmbedPolicy; chains: readonly SelectableChainId[] }>([
    { policy: { ...OPEN_POLICY, buyTokens: ["USDC"] }, chains: [1] },
    { policy: { ...OPEN_POLICY, buyTokens: ["USDT"] }, chains: [8453] },
    { policy: { ...OPEN_POLICY, locks: ["buy"] as const }, chains: [1] },
    { policy: { ...OPEN_POLICY, locks: ["toChain"] as const }, chains: [] },
    { policy: { ...OPEN_POLICY, fromChains: [1] }, chains: [] },
    { policy: { ...OPEN_POLICY, sellTokens: ["USDT"] }, chains: [] },
  ])("narrows live discovery by host policy $policy", ({ policy, chains }) => {
    const { result } = routeHook(baseStealthMatrix, policy);
    expect(result.current.liveStealthDestinations.chainIds).toEqual(chains);
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.toToken).toEqual(token(42161, "USDC"));
  });

  it("refuses a retained Base choice after its independently pinned factory is withdrawn", async () => {
    const { result, client } = routeHook(baseStealthMatrix);
    const retained = result.current.liveStealthDestinations.handleTokenChange;
    const caps = parseWidgetCapabilities({
      ...matrix,
      ...baseStealthMatrix,
      chains: baseStealthMatrix.chains.map((chain) =>
        chain.chain_id === 8453 ? { ...chain, stealth_factory_address: null } : chain,
      ),
    });
    if (!caps) throw new Error("invalid factory refresh");
    act(() =>
      client.setQueryData(["capabilities"], { caps, source: "live", features: TRUST_FEATURES_OFF }),
    );
    await waitFor(() => expect(result.current.liveStealthDestinations.chainIds).toEqual([1]));
    act(() => retained(token(8453, "USDT")));
    expect(result.current.toToken).toEqual(token(42161, "USDC"));
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
  });

  it("keeps bridged USDC on the send leg and refuses destination picks and flips", () => {
    const bridged = {
      chainId: 42161 as const,
      address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      symbol: "USDC_E",
      name: "Bridged USDC",
      decimals: 6,
    };
    const { result } = routeHook({
      tokens: [
        ...matrix.tokens,
        {
          symbol: bridged.symbol,
          decimals: bridged.decimals,
          roles: ["origin", "destination"],
          addresses: { [bridged.chainId]: bridged.address },
        },
      ],
      routes: [
        ...matrix.routes,
        {
          origin: { chain_id: 42161, token: "USDC_E" },
          destination: { kind: "chain", chain_id: 8453, token: "USDC" },
          privacy_modes: ["public"],
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "chain", chain_id: 42161, token: "USDC_E" },
          privacy_modes: ["public"],
        },
      ],
    });

    act(() => result.current.handleFromTokenChange(bridged));
    expect(result.current.fromToken).toMatchObject(bridged);
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.routeCheck.status).toBe("supported");
    expect(result.current.classifyDestinationToken(bridged).state).toBe("unsupported");

    act(() => {
      result.current.handleToTokenChange(bridged);
      result.current.handleSwapTokens();
    });
    expect(result.current.fromToken).toMatchObject(bridged);
    expect(result.current.toToken).toEqual(token(8453, "USDC"));
    expect(result.current.routeCheck.status).toBe("supported");
  });

  it("commits a same-symbol live Stealth destination from the tag rail", () => {
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

    act(() => result.current.liveStealthDestinations.handleChainChange(1));
    expect(result.current.zkMoneyDestination).toBe(false);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.selectedPrivacyModes).toEqual(["public", "stealth"]);
  });

  it("reports Stealth unavailable when only another receive symbol supports it", () => {
    const { result } = routeHook();

    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(true);

    expect(result.current.stealthDestinationChainIds).toEqual([]);
    act(() => result.current.liveStealthDestinations.handleChainChange(1));
    expect(result.current.zkMoneyDestination).toBe(true);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.selectedPrivacyModes).toEqual(["public"]);
  });

  it("leaves zk.money without a same-symbol Stealth route or opposite-leg repair", () => {
    const { result, originChanges } = routeHook();
    act(() => result.current.selectZkMoneyDestination());
    expect(result.current.stealthDestinationChainIds).toEqual([]);

    act(() => result.current.leaveZkMoneyDestination());
    expect(result.current.zkMoneyDestination).toBe(false);
    expect(result.current.fromChainId).toBe(8453);
    expect(result.current.fromToken).toEqual(token(8453, "USDC"));
    expect(result.current.toChainId).toBe(1);
    expect(result.current.toToken).toEqual(token(1, "DAI"));
    expect(result.current.selectedPrivacyModes).toEqual(["public"]);
    expect(result.current.liveStealthDestinations.selectedPairSupported).toBe(false);
    expect(
      result.current.liveStealthDestinations.tokensByChain.get(1)?.map((entry) => entry.symbol),
    ).toEqual(["USDC"]);
    expect(originChanges()).toBe(0);
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
