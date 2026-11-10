/**
 * Unit tests for the pure pull-method guess in usePermit (detectPermitType).
 *
 * The guess drives the pre-quote display + approval gate before the solver-served
 * pull_authorization lands. The smart-account steer (xochi#291) keeps a Base
 * Account (ERC-4337) signer off the ecrecover-only ERC-3009 path.
 */
import { describe, it, expect } from "vitest";
import { USDC_ADDRESSES } from "@xochi/client";
import { detectPermitType } from "./usePermit.js";
import type { ChainId } from "../types/intent.js";

const BASE: ChainId = 8453;
const USDC_BASE = USDC_ADDRESSES[BASE] as string;
const WETH_BASE = "0x4200000000000000000000000000000000000006";

describe("detectPermitType", () => {
  it("guesses erc3009 for USDC on an EOA", () => {
    expect(detectPermitType(USDC_BASE, BASE)).toBe("erc3009");
    expect(detectPermitType(USDC_BASE, BASE, false)).toBe("erc3009");
  });

  it("guesses permit2 for a non-USDC token regardless of account type", () => {
    expect(detectPermitType(WETH_BASE, BASE)).toBe("permit2");
    expect(detectPermitType(WETH_BASE, BASE, true)).toBe("permit2");
  });

  it("steers USDC to permit2 for a smart account (ERC-3009 is ecrecover-only)", () => {
    expect(detectPermitType(USDC_BASE, BASE, true)).toBe("permit2");
  });

  it("is case-insensitive on the USDC address match", () => {
    expect(detectPermitType(USDC_BASE.toLowerCase(), BASE)).toBe("erc3009");
    expect(detectPermitType(USDC_BASE.toUpperCase().replace("0X", "0x"), BASE)).toBe("erc3009");
  });
});
