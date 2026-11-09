import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advertisedRoute,
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
