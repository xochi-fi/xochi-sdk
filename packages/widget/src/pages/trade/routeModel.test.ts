import { describe, expect, it } from "vitest";
import { parseCapabilities } from "@xochi/signer";
import { resolveRouteModel, TRON_CHAIN_ID, type SelectableChainId } from "@xochi/client";
import {
  ARC_LIVE,
  GNOSIS_LIVE,
  TOKENS,
  TRON_DESTINATION_LIVE,
  TRON_ORIGIN_LIVE,
  chainEnabledForRole,
} from "./config.js";

const BASE: SelectableChainId = 8453;
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

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

function chainRoute(
  fromChainId: SelectableChainId,
  from: string,
  toChainId: SelectableChainId,
  to: string,
) {
  return {
    origin: { chain_id: fromChainId, token: from },
    destination: { kind: "chain", chain_id: toChainId, token: to },
    privacy_modes: ["public"],
  };
}

describe("widget route launch gates", () => {
  it("preserves directional Tron, Arc, and Gnosis launch gates", () => {
    const gatedChains = [TRON_CHAIN_ID, 5042, 100] as const;
    const symbols = ["USDT", "USDC", "EURe"] as const;
    const tokens = [
      wireToken("USDT", [TRON_CHAIN_ID]),
      wireToken("USDC", [BASE, 5042]),
      wireToken("EURe", [100]),
    ];
    const routes = gatedChains.flatMap((chainId, index) => [
      chainRoute(BASE, "USDC", chainId, symbols[index]),
      chainRoute(chainId, symbols[index], BASE, "USDC"),
    ]);
    const capabilities = parseCapabilities({
      chains: [BASE, ...gatedChains].map((chainId) => ({
        chain_id: chainId,
        chain_name: String(chainId),
        vm_type: chainId === TRON_CHAIN_ID ? "tvm" : "evm",
      })),
      tokens,
      routes,
      stealth_chains: [],
    });
    if (capabilities === null) throw new Error("capability fixture did not parse");
    const model = resolveRouteModel(capabilities, "live", {
      chainEnabledForRole,
      presentationTokens: TOKENS,
    });

    expect(model.originChainIds.includes(TRON_CHAIN_ID)).toBe(TRON_ORIGIN_LIVE);
    expect(model.destinationChainIds.includes(TRON_CHAIN_ID)).toBe(TRON_DESTINATION_LIVE);
    expect(model.originChainIds.includes(5042)).toBe(ARC_LIVE);
    expect(model.destinationChainIds.includes(5042)).toBe(true);
    expect(model.originChainIds.includes(100)).toBe(GNOSIS_LIVE);
    expect(model.destinationChainIds.includes(100)).toBe(GNOSIS_LIVE);
    if (TRON_DESTINATION_LIVE) {
      expect(model.destinationTokens.get(TRON_CHAIN_ID)?.[0]).toMatchObject({
        symbol: "USDT",
        address: TRON_USDT,
      });
    }
  });
});
