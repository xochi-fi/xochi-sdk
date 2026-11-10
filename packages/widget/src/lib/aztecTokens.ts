/**
 * Aztec tokens the activity feed can name.
 *
 * An Aztec payout's `to_token` is a 32-byte Aztec address, which no EVM token
 * list knows. Keyed by that full address alone, never by a chain id: the
 * tracer stores the Aztec network's L1 chain id as `to_chain_id`, so a lookup by
 * chain would land in that EVM chain's list, and a 20-byte EVM address can never
 * match a 32-byte key. Values follow the shielded corridor manifest.
 */

export interface AztecTokenInfo {
  symbol: string;
  decimals: number;
}

const AZTEC_TOKENS: ReadonlyMap<string, AztecTokenInfo> = new Map([
  // Oxide DAI ("Oxide DAI" in the corridor manifest).
  [
    "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3",
    { symbol: "OXDAI", decimals: 18 },
  ],
]);

/** Display metadata for a known Aztec token address, or null. Hex, so case-insensitive. */
export function getAztecTokenInfo(address: string): AztecTokenInfo | null {
  return AZTEC_TOKENS.get(address.toLowerCase()) ?? null;
}
