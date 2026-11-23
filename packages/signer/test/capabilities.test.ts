import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advertisedRoute,
  originPullMethod,
  parseCapabilities,
  routeSupportsPrivacyMode,
  type AdvertisedRouteQuery,
} from "@xochi/signer";

const vector = JSON.parse(
  readFileSync(new URL("../../spec/conformance/capability-routes.json", import.meta.url), "utf8"),
) as { routes: unknown[] };

const baseDai: AdvertisedRouteQuery = {
  origin: { chainId: 8453, token: "USDC" },
  destination: { kind: "chain", chainId: 8453, token: "DAI" },
};

const baseToEthereumUsdc: AdvertisedRouteQuery = {
  origin: { chainId: 8453, token: "USDC" },
  destination: { kind: "chain", chainId: 1, token: "USDC" },
};

const baseToArbitrumDai: AdvertisedRouteQuery = {
  origin: { chainId: 8453, token: "USDC" },
  destination: { kind: "chain", chainId: 42161, token: "DAI" },
};

describe("typed capability routes", () => {
  it("parses the published producer vector in served order", () => {
    const capabilities = parseCapabilities({ routes: vector.routes });

    expect(capabilities?.routes).toHaveLength(24);
    expect(capabilities?.routes?.[0]).toEqual({
      origin: { chainId: 8453, token: "USDC" },
      destination: { kind: "chain", chainId: 1, token: "USDC" },
      privacyModes: ["public", "stealth"],
    });
    expect(capabilities?.routes?.[19]).toEqual({
      origin: { chainId: 137, token: "USDC" },
      destination: { kind: "chain", chainId: 10, token: "USDC" },
      privacyModes: ["public"],
    });
    expect(capabilities?.routes?.[20]).toEqual({
      origin: { chainId: 8453, token: "USDC" },
      destination: { kind: "chain", chainId: 8453, token: "DAI" },
      privacyModes: ["public", "stealth"],
    });
  });

  it("drops malformed entries atomically while ignoring additive keys", () => {
    const capabilities = parseCapabilities({
      routes: [
        {
          origin: { chain_id: 8453, token: "USDC", additive: true },
          destination: {
            kind: "chain",
            chain_id: 8453,
            token: "DAI",
            additive: true,
          },
          privacy_modes: ["public"],
          additive: true,
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "chain", chain_id: 8453, token: "DAI" },
          privacy_modes: ["public", "future_mode"],
        },
        {
          origin: { chain_id: "8453", token: "USDC" },
          destination: { kind: "chain", chain_id: 8453, token: "DAI" },
          privacy_modes: ["public"],
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: { kind: "future_destination", token: "DAI" },
          privacy_modes: ["public"],
        },
        {
          origin: { chain_id: 8453, token: "USDC" },
          destination: {
            kind: "zk_money",
            token: "DAI",
            chain_id: 1,
            additive: true,
          },
          privacy_modes: ["public"],
        },
      ],
    });

    expect(capabilities?.routes).toEqual([
      {
        origin: { chainId: 8453, token: "USDC" },
        destination: { kind: "chain", chainId: 8453, token: "DAI" },
        privacyModes: ["public"],
      },
      {
        origin: { chainId: 8453, token: "USDC" },
        destination: { kind: "zk_money", token: "DAI" },
        privacyModes: ["public"],
      },
    ]);
  });

  it("distinguishes an absent contract from present empty or malformed fields", () => {
    expect(parseCapabilities({})?.routes).toBeNull();
    expect(parseCapabilities({ routes: {} })?.routes).toEqual([]);
    expect(parseCapabilities({ routes: [] })?.routes).toEqual([]);
  });

  it("queries every exact endpoint without inferring missing corridors", () => {
    const capabilities = parseCapabilities({ routes: vector.routes })!;

    expect(advertisedRoute(capabilities, baseToEthereumUsdc)).not.toBeNull();
    expect(advertisedRoute(capabilities, baseDai)).not.toBeNull();
    expect(routeSupportsPrivacyMode(capabilities, baseDai, "stealth")).toBe(true);
    expect(routeSupportsPrivacyMode(capabilities, baseDai, "shielded")).toBe(false);
    expect(advertisedRoute(capabilities, baseToArbitrumDai)).toBeNull();
  });

  it("fails closed when duplicate endpoint entries conflict", () => {
    const capabilities = parseCapabilities({
      routes: [vector.routes[20], vector.routes[20]],
    })!;

    expect(advertisedRoute(capabilities, baseDai)).toBeNull();
    expect(routeSupportsPrivacyMode(capabilities, baseDai, "public")).toBe(false);
  });
});

describe("destination-only token with no pull method", () => {
  // Riddler lists Canton Coin destination-only: `pull_method: null`, empty `pull_methods`.
  const caps = parseCapabilities({
    chains: [
      { chain_id: 8453, chain_name: "Base", vm_type: "evm" },
      { chain_id: 253340876, chain_name: "Canton", vm_type: "cvm", roles: ["destination"] },
    ],
    tokens: [
      {
        symbol: "USDC",
        decimals: 6,
        pull_method: "erc3009",
        gasless_origin: true,
        roles: ["origin"],
        addresses: { 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      },
      {
        symbol: "CC",
        decimals: 10,
        pull_method: null,
        pull_methods: [],
        gasless_origin: false,
        roles: ["destination"],
        addresses: {
          253340876: "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
        },
      },
    ],
    routes: [
      {
        origin: { chain_id: 8453, token: "USDC" },
        destination: { kind: "chain", chain_id: 253340876, token: "CC" },
        privacy_modes: ["public"],
      },
    ],
  });

  it("parses the token and leaves the origin token's pull method intact", () => {
    if (caps === null) throw new Error("matrix did not parse");
    const cc = caps.tokens.find((token) => token.symbol === "CC");
    expect(cc?.pullMethod).toBeNull();
    expect(cc?.pullMethods).toEqual({});
    expect(originPullMethod(caps, "CC", 253340876)).toBeNull();
    expect(originPullMethod(caps, "USDC", 8453)).toBe("erc3009");
    expect(
      advertisedRoute(caps, {
        origin: { chainId: 8453, token: "USDC" },
        destination: { kind: "chain", chainId: 253340876, token: "CC" },
      }),
    ).not.toBeNull();
  });
});
