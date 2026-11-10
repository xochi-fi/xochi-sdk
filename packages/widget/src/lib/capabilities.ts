import {
  CHAIN_NAMES,
  SUPPORTED_CHAIN_IDS,
  TOKENS,
  parseCapabilities,
  type SolverCapabilities,
} from "@xochi/client";
import { FALLBACK_DESTINATION_TOKENS, FALLBACK_ORIGIN_TOKENS } from "./displayFallbacks.js";

/** Display continuity only: no exact routes, live authority or advertised Stealth factories. */
export const FALLBACK_CAPABILITIES: SolverCapabilities = (() => {
  const symbols = [...new Set([...FALLBACK_ORIGIN_TOKENS, ...FALLBACK_DESTINATION_TOKENS])];
  const tokens = symbols.flatMap((symbol) => {
    const entries = SUPPORTED_CHAIN_IDS.flatMap((chainId) =>
      TOKENS[chainId]
        .filter((token) => token.symbol === symbol)
        .map((token) => ({ chainId, token })),
    );
    const decimals = new Set(entries.map(({ token }) => token.decimals));
    if (entries.length === 0 || decimals.size !== 1) return [];
    return [
      {
        symbol,
        decimals: entries[0]!.token.decimals,
        roles: ["origin", "destination"].filter((role) =>
          (role === "origin" ? FALLBACK_ORIGIN_TOKENS : FALLBACK_DESTINATION_TOKENS).includes(
            symbol,
          ),
        ),
        addresses: Object.fromEntries(
          entries.map(({ chainId, token }) => [chainId, token.address]),
        ),
      },
    ];
  });
  const caps = parseCapabilities({
    cross_chain_only: true,
    chains: SUPPORTED_CHAIN_IDS.map((chain_id) => ({
      chain_id,
      chain_name: CHAIN_NAMES[chain_id],
      vm_type: "evm",
    })),
    tokens,
  });
  if (caps === null) throw new Error("fallback capabilities failed to parse");
  return caps;
})();
