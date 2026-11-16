// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  CANTON_COIN_MAINNET,
  CANTON_MAINNET_CHAIN_ID,
  parseCapabilities,
  type SolverCapabilities,
} from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY } from "./shared/stealth.js";
import { TRON_CHAIN_ID, type SelectableChainId } from "./shared/chains.js";
import { CANTON_COIN, TOKENS as EVM_TOKENS, TRON_TOKENS_BY_ADDRESS } from "./shared/tokens.js";
import {
  resolveRouteModel as resolveExecutableRouteModel,
  type CapabilityState,
  type RouteToken,
  type ChainDestination,
  type ResolvedRouteModel,
  type RouteLeg,
} from "./routeModel.js";

const TOKENS: Partial<Record<SelectableChainId, readonly RouteToken[]>> = Object.fromEntries([
  ...Object.entries(EVM_TOKENS).map(([chainId, tokens]) => [
    Number(chainId),
    tokens.map((token) => ({ ...token, chainId: Number(chainId) as SelectableChainId })),
  ]),
  [
    TRON_CHAIN_ID,
    Object.values(TRON_TOKENS_BY_ADDRESS).flatMap((token) =>
      token ? [{ ...token, chainId: TRON_CHAIN_ID }] : [],
    ),
  ],
]);
function resolveRouteModel(
  capabilities: SolverCapabilities,
  state: CapabilityState,
): ResolvedRouteModel {
  return resolveExecutableRouteModel(capabilities, state, {
    chainEnabledForRole: () => true,
    presentationTokens: TOKENS,
  });
}

const ETHEREUM: SelectableChainId = 1;
const BASE: SelectableChainId = 8453;
const ARBITRUM: SelectableChainId = 42161;
const POLYGON: SelectableChainId = 137;
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function parsed(body: Record<string, unknown>): SolverCapabilities {
  const capabilities = parseCapabilities(body);
  if (capabilities === null) throw new Error("capability fixture did not parse");
  return capabilities;
}

function configuredToken(chainId: SelectableChainId, symbol: string) {
  const found = TOKENS[chainId]?.find((token) => token.symbol === symbol);
  if (!found) throw new Error(`missing ${symbol} on ${chainId}`);
  return found;
}

function wireToken(symbol: string, chainIds: readonly SelectableChainId[]) {
  const first = configuredToken(chainIds[0], symbol);
  return {
    symbol,
    decimals: first.decimals,
    roles: ["origin", "destination"],
    addresses: Object.fromEntries(
      chainIds.map((chainId) => [chainId, configuredToken(chainId, symbol).address]),
    ),
  };
}

function chainRow(chainId: SelectableChainId) {
  return {
    chain_id: chainId,
    chain_name: String(chainId),
    vm_type: chainId === TRON_CHAIN_ID ? "tvm" : "evm",
    ...([ETHEREUM, BASE].includes(chainId)
      ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
      : {}),
  };
}

function chainRoute(
  fromChainId: SelectableChainId,
  from: string,
  toChainId: SelectableChainId,
  to: string,
  privacyModes: readonly string[] = ["public"],
) {
  return {
    origin: { chain_id: fromChainId, token: from },
    destination: { kind: "chain", chain_id: toChainId, token: to },
    privacy_modes: privacyModes,
  };
}

function capabilities(
  routes: readonly unknown[],
  options: {
    chainIds?: readonly SelectableChainId[];
    symbols?: readonly string[];
    tokens?: readonly unknown[];
    stealthChains?: readonly number[];
  } = {},
): SolverCapabilities {
  const chainIds = options.chainIds ?? [BASE, ETHEREUM, ARBITRUM];
  const symbols = options.symbols ?? ["USDC", "DAI"];
  return parsed({
    chains: chainIds.map(chainRow),
    tokens: options.tokens ?? symbols.map((symbol) => wireToken(symbol, chainIds)),
    routes,
    stealth_chains: options.stealthChains ?? [BASE, ETHEREUM],
  });
}

function selectedRoute(
  model: ResolvedRouteModel,
  fromChainId: SelectableChainId,
  from: string,
  toChainId: SelectableChainId,
  to: string,
): { origin: RouteLeg; destination: ChainDestination } {
  const origin = model.originTokens.get(fromChainId)?.find((token) => token.symbol === from);
  const destination = model.destinationTokens.get(toChainId)?.find((token) => token.symbol === to);
  if (!origin || !destination) throw new Error(`route inventory missing ${from} -> ${to}`);
  return {
    origin: { chainId: fromChainId, token: origin },
    destination: { kind: "chain", chainId: toChainId, token: destination },
  };
}

describe("resolveRouteModel", () => {
  it("indexes and resolves every production-sized typed route generically", () => {
    const chainIds = [ETHEREUM, 10, POLYGON, ARBITRUM, BASE, 4663] as const;
    const symbols = ["USDC", "USDT", "USDG", "RAXOL", "EURe", "ZCHF", "DAI"] as const;
    const addresses = new Map<string, string>();
    let addressIndex = 1;
    for (const symbol of symbols) {
      for (const chainId of chainIds) {
        addresses.set(`${chainId}:${symbol}`, `0x${addressIndex.toString(16).padStart(40, "0")}`);
        addressIndex += 1;
      }
    }
    const tokens = symbols.map((symbol) => ({
      symbol,
      decimals: symbol === "USDC" || symbol === "USDT" || symbol === "USDG" ? 6 : 18,
      roles: ["origin", "destination"],
      addresses: Object.fromEntries(
        chainIds.map((chainId) => [chainId, addresses.get(`${chainId}:${symbol}`)]),
      ),
    }));
    const allRoutes = chainIds.flatMap((fromChainId) =>
      symbols.flatMap((from) =>
        chainIds.flatMap((toChainId) =>
          symbols.map((to) => chainRoute(fromChainId, from, toChainId, to)),
        ),
      ),
    );
    const routes = allRoutes.slice(0, 641);
    const model = resolveRouteModel(
      parsed({ chains: chainIds.map(chainRow), tokens, routes, stealth_chains: [] }),
      "live",
    );

    expect(routes).toHaveLength(641);
    for (const route of routes) {
      const origin = model.originTokens
        .get(route.origin.chain_id)
        ?.find((token) => token.symbol === route.origin.token);
      const destination = model.destinationTokens
        .get(route.destination.chain_id)
        ?.find((token) => token.symbol === route.destination.token);
      if (!origin || !destination) throw new Error("advertised route absent from inventory");
      expect(
        model.resolve(
          { chainId: route.origin.chain_id, token: origin },
          { kind: "chain", chainId: route.destination.chain_id, token: destination },
        ),
      ).toEqual({ status: "available", privacyModes: ["public"] });
    }
  });

  it("accepts bridged USDC as payment but rejects its advertised reverse payout", () => {
    const caps = capabilities(
      [
        chainRoute(ARBITRUM, "USDC_E", BASE, "USDC"),
        chainRoute(BASE, "USDC", ARBITRUM, "USDC_E"),
        chainRoute(BASE, "USDC", ETHEREUM, "USDC"),
      ],
      {
        tokens: [
          wireToken("USDC", [BASE, ETHEREUM]),
          {
            symbol: "USDC_E",
            decimals: 6,
            roles: ["origin", "destination"],
            addresses: { [ARBITRUM]: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" },
          },
        ],
      },
    );
    const model = resolveRouteModel(caps, "live");
    const payment = selectedRoute(model, ARBITRUM, "USDC_E", BASE, "USDC");
    expect(model.resolve(payment.origin, payment.destination)).toEqual({
      status: "available",
      privacyModes: ["public"],
    });
    expect(model.destinationTokens.get(ARBITRUM)).toBeUndefined();

    const native = selectedRoute(model, BASE, "USDC", ETHEREUM, "USDC");
    expect(model.resolve(native.origin, native.destination).status).toBe("available");
    expect(
      model.resolve(native.origin, {
        kind: "chain",
        chainId: ARBITRUM,
        token: payment.origin.token,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "USDC_E cannot be received on this chain.",
    });

    const offline = resolveRouteModel({ ...caps, routes: null }, "fallback");
    expect(offline.originTokens.get(ARBITRUM)?.[0].symbol).toBe("USDC_E");
    expect(
      [...offline.destinationTokens.values()].flat().some((token) => token.symbol === "USDC_E"),
    ).toBe(false);
  });

  it("only exposes validated tokens that participate in a typed route", () => {
    const model = resolveRouteModel(
      capabilities([chainRoute(BASE, "USDC", ARBITRUM, "DAI")], {
        symbols: ["USDC", "DAI", "WETH"],
      }),
      "live",
    );

    expect(model.originTokens.get(BASE)?.map((token) => token.symbol)).toEqual(["USDC"]);
    expect(model.destinationTokens.get(ARBITRUM)?.map((token) => token.symbol)).toEqual(["DAI"]);
    expect([...model.originTokens.values()].flat().some((token) => token.symbol === "WETH")).toBe(
      false,
    );
    expect(
      [...model.destinationTokens.values()].flat().some((token) => token.symbol === "WETH"),
    ).toBe(false);
  });

  it("keeps typed zk.money separate from Ethereum chain destinations", () => {
    const model = resolveRouteModel(
      capabilities([
        {
          origin: { chain_id: BASE, token: "USDC" },
          destination: { kind: "zk_money", token: "DAI" },
          privacy_modes: ["public"],
        },
      ]),
      "live",
    );
    if (!model.zkMoneyDestination) throw new Error("zk.money route not exposed");
    const origin = model.originTokens.get(BASE)?.[0];
    if (!origin) throw new Error("zk.money origin missing");

    expect(model.zkMoneyDestination.token).toMatchObject({ chainId: ETHEREUM, symbol: "DAI" });
    expect(model.destinationTokens.get(ETHEREUM)).toBeUndefined();
    expect(model.resolve({ chainId: BASE, token: origin }, model.zkMoneyDestination)).toEqual({
      status: "available",
      privacyModes: ["public"],
    });
  });

  it("requires public mode on the exact zk.money route", () => {
    const model = resolveRouteModel(
      capabilities([
        {
          origin: { chain_id: BASE, token: "USDC" },
          destination: { kind: "zk_money", token: "DAI" },
          privacy_modes: ["stealth"],
        },
      ]),
      "live",
    );
    expect(model.zkMoneyDestination).toBeNull();
    expect(model.originChainIds).toEqual([]);
  });

  it("fails closed on duplicate token, duplicate route, and malformed rows", () => {
    const exact = chainRoute(BASE, "USDC", ARBITRUM, "DAI");
    const base = capabilities([exact]);
    const usdc = base.tokens.find((token) => token.symbol === "USDC");
    if (!usdc) throw new Error("USDC fixture missing");
    const variants = [
      { ...base, tokens: [...base.tokens, usdc] },
      { ...base, routes: [...(base.routes ?? []), ...(base.routes ?? [])] },
      {
        ...base,
        tokens: base.tokens.map((token) =>
          token.symbol === "USDC"
            ? { ...token, addresses: { ...token.addresses, [BASE]: "malformed" } }
            : token,
        ),
      },
      capabilities([exact, { origin: null, destination: "bad", privacy_modes: ["public"] }], {
        symbols: ["USDC", "DAI"],
      }),
    ];

    expect(resolveRouteModel(variants[0], "live").originChainIds).toEqual([]);
    expect(resolveRouteModel(variants[1], "live").originChainIds).toEqual([]);
    expect(resolveRouteModel(variants[2], "live").originChainIds).toEqual([]);
    expect(resolveRouteModel(variants[3], "live").originChainIds).toEqual([BASE]);
  });

  it("matches EVM contracts case-insensitively while preserving Tron base58 casing", () => {
    const evmModel = resolveRouteModel(
      capabilities([chainRoute(BASE, "USDC", ARBITRUM, "DAI")]),
      "live",
    );
    const selected = selectedRoute(evmModel, BASE, "USDC", ARBITRUM, "DAI");
    expect(
      evmModel.resolve(
        {
          ...selected.origin,
          token: {
            ...selected.origin.token,
            address: selected.origin.token.address.toLowerCase(),
          },
        },
        selected.destination,
      ).status,
    ).toBe("available");

    {
      const tronModel = resolveRouteModel(
        capabilities([chainRoute(BASE, "USDC", TRON_CHAIN_ID, "USDT")], {
          chainIds: [BASE, TRON_CHAIN_ID],
          tokens: [wireToken("USDC", [BASE]), wireToken("USDT", [TRON_CHAIN_ID])],
        }),
        "live",
      );
      const tronRoute = selectedRoute(tronModel, BASE, "USDC", TRON_CHAIN_ID, "USDT");
      expect(
        tronModel.resolve(tronRoute.origin, {
          ...tronRoute.destination,
          token: { ...tronRoute.destination.token, address: TRON_USDT.toLowerCase() },
        }).status,
      ).toBe("unavailable");
    }
  });

  it("returns only exact route privacy modes and filters untrusted stealth", () => {
    const model = resolveRouteModel(
      capabilities(
        [
          chainRoute(ETHEREUM, "USDC", BASE, "DAI", ["public", "stealth"]),
          chainRoute(BASE, "USDC", ARBITRUM, "DAI", ["public", "stealth"]),
          chainRoute(BASE, "USDC", POLYGON, "USDC", ["stealth"]),
        ],
        {
          chainIds: [ETHEREUM, BASE, ARBITRUM, POLYGON],
          tokens: [
            wireToken("USDC", [ETHEREUM, BASE, ARBITRUM, POLYGON]),
            wireToken("DAI", [BASE, ARBITRUM]),
          ],
          symbols: [],
        },
      ),
      "live",
    );
    const base = selectedRoute(model, ETHEREUM, "USDC", BASE, "DAI");
    const arbitrum = selectedRoute(model, BASE, "USDC", ARBITRUM, "DAI");

    expect(model.resolve(base.origin, base.destination)).toEqual({
      status: "available",
      privacyModes: ["public", "stealth"],
    });
    expect(model.resolve(arbitrum.origin, arbitrum.destination)).toEqual({
      status: "available",
      privacyModes: ["public"],
    });
    expect(model.destinationChainIds).not.toContain(POLYGON);
  });

  it("keeps stale, fallback, and failed snapshots unknown", () => {
    const caps = capabilities([chainRoute(BASE, "USDC", ARBITRUM, "DAI")]);
    for (const state of ["stale", "fallback", "failed"] as const) {
      const model = resolveRouteModel(caps, state);
      const selected = selectedRoute(model, BASE, "USDC", ARBITRUM, "DAI");
      expect(model.resolve(selected.origin, selected.destination)).toEqual({
        status: "unknown",
        reason: "Routes could not be loaded",
      });
    }
  });
});

describe("resolveRouteModel: Canton destination", () => {
  const CANTON: SelectableChainId = CANTON_MAINNET_CHAIN_ID;
  const CBTC = `CBTC::1220${"ab".repeat(32)}`;
  const presentation = { ...TOKENS, [CANTON]: [{ ...CANTON_COIN, chainId: CANTON }] };
  const matrix = parsed({
    chains: [
      chainRow(BASE),
      { chain_id: CANTON, chain_name: "Canton", vm_type: "cvm", address_format: "canton_party" },
    ],
    tokens: [
      wireToken("USDC", [BASE]),
      {
        symbol: "CC",
        decimals: 10,
        roles: ["origin", "destination"],
        addresses: { [CANTON]: CANTON_COIN_MAINNET },
      },
      { symbol: "CBTC", decimals: 8, roles: ["destination"], addresses: { [CANTON]: CBTC } },
    ],
    routes: [
      chainRoute(BASE, "USDC", CANTON, "CC", ["public", "stealth", "shielded"]),
      chainRoute(BASE, "USDC", CANTON, "CBTC"),
      chainRoute(CANTON, "CC", BASE, "USDC"),
    ],
    stealth_chains: [BASE, CANTON],
  });
  const model = (cantonLive: boolean): ResolvedRouteModel =>
    resolveExecutableRouteModel(matrix, "live", {
      chainEnabledForRole: (chainId) => chainId !== CANTON || cantonLive,
      presentationTokens: presentation,
    });

  it("is offered only when the caller's gate enables it", () => {
    expect(model(true).destinationChainIds).toContain(CANTON);
    expect(model(false).destinationChainIds).not.toContain(CANTON);
  });

  it("is never an origin, whatever the matrix and the gate say", () => {
    expect(model(true).originChainIds).not.toContain(CANTON);
  });

  it("offers Canton Coin only, by its verbatim instrument id", () => {
    expect(model(true).destinationTokens.get(CANTON)).toEqual([
      { ...CANTON_COIN, chainId: CANTON },
    ]);
  });

  it("resolves Base USDC to Canton Coin as public only", () => {
    const live = model(true);
    const selected = selectedRoute(live, BASE, "USDC", CANTON, "CC");
    expect(live.resolve(selected.origin, selected.destination)).toEqual({
      status: "available",
      privacyModes: ["public"],
    });
  });

  it("compares the instrument id case-exactly", () => {
    const live = model(true);
    const selected = selectedRoute(live, BASE, "USDC", CANTON, "CC");
    const folded = { ...selected.destination.token, address: CANTON_COIN_MAINNET.toLowerCase() };
    expect(live.resolve(selected.origin, { ...selected.destination, token: folded }).status).toBe(
      "unavailable",
    );
  });
});
