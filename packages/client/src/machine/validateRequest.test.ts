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
import { USDC_BASE } from "./test/session.js";

const soon = (): number => Math.floor(Date.now() / 1000) + 600;

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

describe("validateSwapParams", () => {
  it("accepts an all-EVM cross-chain route", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: USDC_BASE,
      toToken: USDC_BASE,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    expect(validateSwapParams(req, Date.now()).isValid).toBe(true);
  });

  it("accepts any code up to the Worker's 64 characters and refuses a longer one", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: USDC_BASE,
      toToken: USDC_BASE,
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    const now = Date.now();
    expect(
      validateSwapParams({ ...req, ref: "has space", promo: "X".repeat(64) }, now).isValid,
    ).toBe(true);
    expect(validateSwapParams({ ...req, ref: "X".repeat(65) }, now).errors).toEqual([
      "Invalid referral code: at most 64 characters",
    ]);
    expect(validateSwapParams({ ...req, promo: "X".repeat(65) }, now).errors).toEqual([
      "Invalid promo code: at most 64 characters",
    ]);
  });

  it("accepts a normalised recipient tag, refuses a malformed one or one beside an address", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: 1,
      fromToken: USDC_BASE,
      toToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      fromAmount: "1000000",
      deadline: soon(),
      slippageBps: 50,
      settlementPreference: "public",
    };
    const now = Date.now();
    expect(validateSwapParams({ ...req, recipientTag: "foo-bar9" }, now).isValid).toBe(true);
    expect(validateSwapParams({ ...req, recipientTag: "a".repeat(63) }, now).isValid).toBe(true);
    for (const bad of ["@foo", "Foo", "foo.bar", "foo bar", "", "a".repeat(64)]) {
      expect(validateSwapParams({ ...req, recipientTag: bad }, now).errors).toEqual([
        "Invalid recipient tag: use 1-63 letters, digits or hyphens",
      ]);
    }
    expect(
      validateSwapParams({ ...req, recipientTag: "foo", recipientAddress: EVM_WALLET }, now).errors,
    ).toEqual(["Choose a recipient address or a recipient tag, not both"]);
  });

  it("accepts an EVM origin -> Tron destination (base58 token)", () => {
    const req: Partial<QuoteRequest> = {
      wallet: EVM_WALLET,
      fromChainId: 8453,
      toChainId: TRON_CHAIN_ID,
      fromToken: USDC_BASE,
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
      fromToken: USDC_BASE,
      toToken: USDC_BASE,
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
