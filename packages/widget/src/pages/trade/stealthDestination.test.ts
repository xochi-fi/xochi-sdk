import { describe, expect, it } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY, stealthDestinationChains } from "@xochi/client";
import { parseCapabilities, type SolverCapabilities } from "@xochi/signer";
import { joinChainNames } from "./config.js";

const TRUSTED: Readonly<Record<number, readonly string[]>> = {
  1: [SIMPLE_ACCOUNT_FACTORY],
  8453: [SIMPLE_ACCOUNT_FACTORY],
};

/** A served matrix carrying only `stealth_chains`, or omitting it. */
function served(...stealthChains: [] | [unknown]): SolverCapabilities {
  const advertised = Array.isArray(stealthChains[0])
    ? [...new Set(stealthChains[0])].filter(
        (chainId): chainId is number => typeof chainId === "number",
      )
    : [];
  const caps = parseCapabilities(
    stealthChains.length === 0
      ? {}
      : {
          stealth_chains: stealthChains[0],
          chains: advertised.map((chain_id) => ({
            chain_id,
            vm_type: "evm",
            ...(TRUSTED[chain_id] ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : {}),
          })),
        },
  );
  if (caps === null) throw new Error("test matrix did not parse");
  return caps;
}

describe("stealthDestinationChains", () => {
  it("is empty -- stealth unknown -- when no stealth chain list is advertised", () => {
    expect(stealthDestinationChains(served(), TRUSTED)).toEqual([]);
    expect(stealthDestinationChains(served())).toEqual([]);
  });

  it("preserves solver order and drops chains the client does not trust", () => {
    expect(stealthDestinationChains(served([8453, 999999, 1]), TRUSTED)).toEqual([8453, 1]);
    expect(stealthDestinationChains(served([8453, 8453, 1]), TRUSTED)).toEqual([8453, 1]);
  });

  it("fails closed when nothing advertised is trusted", () => {
    expect(stealthDestinationChains(served([999999]), TRUSTED)).toEqual([]);
    expect(stealthDestinationChains(served([]), TRUSTED)).toEqual([]);
  });

  it("reads a present stealth_chains that is not a list as no chains, not legacy L1", () => {
    for (const malformed of [null, "8453", { 1: true }]) {
      expect(stealthDestinationChains(served(malformed), TRUSTED)).toEqual([]);
    }
  });
});

describe("joinChainNames", () => {
  it("joins one, two or more names", () => {
    expect(joinChainNames(["Base"])).toBe("Base");
    expect(joinChainNames(["Base", "Ethereum"])).toBe("Base or Ethereum");
    expect(joinChainNames(["Base", "Ethereum", "Arbitrum"])).toBe("Base, Ethereum or Arbitrum");
  });
});
