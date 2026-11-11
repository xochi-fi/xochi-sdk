import { describe, expect, it } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { stealthFactoryFor } from "@xochi/signer";
import { parseWidgetCapabilities } from "./useCapabilities.js";

const matrix = (over: Record<string, unknown> = {}) => ({
  cross_chain_only: true,
  stealth_chains: [8453, 1],
  chains: [
    {
      chain_id: 8453,
      chain_name: "Base",
      vm_type: "evm",
      stealth_factory_address: SIMPLE_ACCOUNT_FACTORY,
    },
    { chain_id: 1, chain_name: "Ethereum", vm_type: "evm" },
  ],
  tokens: [{ symbol: "USDC", roles: ["origin", "destination"] }],
  conversion_pairs: [],
  ...over,
});

describe("parseWidgetCapabilities", () => {
  it("serves the signer's parse, with the stealth fields in solver order", () => {
    const parsed = parseWidgetCapabilities(matrix());
    expect(parsed?.stealthChains).toEqual([8453, 1]);
    expect(parsed && stealthFactoryFor(parsed, 8453)).toBe(SIMPLE_ACCOUNT_FACTORY);
  });

  it("ignores malformed chain entries and keeps the rest", () => {
    const parsed = parseWidgetCapabilities(
      matrix({ chains: [null, 42, "Base", ...matrix().chains] }),
    );
    expect(parsed?.chains.map((chain) => chain.chainId)).toEqual([8453, 1]);
  });

  it("degrades to the fallback on a body the trade UI cannot render", () => {
    expect(parseWidgetCapabilities(null)).toBeNull();
    expect(parseWidgetCapabilities("capabilities")).toBeNull();
    expect(parseWidgetCapabilities({})).toBeNull();
    expect(parseWidgetCapabilities(matrix({ tokens: undefined }))).toBeNull();
    expect(parseWidgetCapabilities(matrix({ tokens: "USDC" }))).toBeNull();
    expect(parseWidgetCapabilities(matrix({ chains: [] }))).toBeNull();
  });

  it("degrades when no chain is in a VM this widget handles", () => {
    expect(
      parseWidgetCapabilities(
        matrix({
          chains: [
            { chain_id: 253340876, chain_name: "Canton", vm_type: "cvm" },
            { chain_id: 8453, chain_name: "Base", vm_type: "zkvm" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("keeps a live matrix with an empty token list", () => {
    expect(parseWidgetCapabilities(matrix({ tokens: [] }))?.tokens).toEqual([]);
  });
});
