/**
 * Frontend swap-param validation.
 *
 * Focus: the destination leg can be non-EVM (Tron), so `validateToChain` and
 * `validateToToken` must accept a Tron chain id and a base58 TRC-20 token, while
 * the origin leg stays EVM.
 */

import { describe, it, expect } from "vitest";
import { validateSwapParams } from "./validateRequest.js";
import { TRON_CHAIN_ID } from "../shared/index.js";
import type { QuoteRequest } from "./wire.js";

const soon = (): number => Math.floor(Date.now() / 1000) + 600;

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const EVM_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

describe("validateSwapParams", () => {
  it("accepts an all-EVM cross-chain route", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: EVM_USDC,
      toToken: EVM_USDC,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    expect(validateSwapParams(req, Date.now()).isValid).toBe(true);
  });

  it("accepts codes in their stored form and refuses any other", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: EVM_USDC,
      toToken: EVM_USDC,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    const now = Date.now();
    expect(validateSwapParams({ ...req, ref: "PARTNER", promo: "LAUNCH10" }, now).isValid).toBe(
      true,
    );
    expect(validateSwapParams({ ...req, ref: "partner" }, now).errors).toEqual([
      "Invalid referral code: 3 to 32 of A-Z, 0-9, _ or -, starting with a letter or digit",
    ]);
    expect(validateSwapParams({ ...req, promo: "A B" }, now).isValid).toBe(false);
  });

  it("accepts an EVM origin -> Tron destination (base58 token)", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: TRON_CHAIN_ID,
      fromToken: EVM_USDC,
      toToken: TRON_USDC,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    expect(validateSwapParams(req, Date.now()).isValid).toBe(true);
  });

  it("rejects an unsupported destination chain", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 56 as unknown as QuoteRequest["toChainId"],
      fromToken: EVM_USDC,
      toToken: EVM_USDC,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    const result = validateSwapParams(req, Date.now());
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("Invalid destination chain");
  });
});
