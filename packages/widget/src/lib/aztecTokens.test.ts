import { describe, it, expect } from "vitest";
import { getAztecTokenInfo } from "./aztecTokens.js";

const OXDAI = "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3";

describe("getAztecTokenInfo", () => {
  it("names Oxide DAI by its 32-byte Aztec address", () => {
    expect(getAztecTokenInfo(OXDAI)).toEqual({ symbol: "OXDAI", decimals: 18 });
    expect(getAztecTokenInfo(OXDAI.toUpperCase().replace("0X", "0x"))).toEqual({
      symbol: "OXDAI",
      decimals: 18,
    });
  });

  // Keyed by the 32-byte address alone, so no EVM token (20 bytes) can match.
  it("never resolves an EVM address or an unknown Aztec token", () => {
    expect(getAztecTokenInfo("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBeNull();
    expect(getAztecTokenInfo(`0x${OXDAI.slice(-40)}`)).toBeNull();
    expect(getAztecTokenInfo(`0x${"ab".repeat(32)}`)).toBeNull();
  });
});
