import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { findTokenBySymbol } from "../trade/config.js";
import {
  checkAddressSend,
  defaultSendToken,
  sendChainIds,
  type AddressSendDraft,
} from "./addressSend.js";

const USDC_BASE = findTokenBySymbol(8453, "USDC")!;
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const CHAINS = [1, 8453];

const draft = (over: Partial<AddressSendDraft> = {}): AddressSendDraft => ({
  chainId: 8453,
  tokenAddress: USDC_BASE.address,
  amount: "1.5",
  recipient: RECIPIENT,
  ...over,
});

const errorsOf = (d: AddressSendDraft, balance: bigint | null = null) => {
  const check = checkAddressSend(d, { chainIds: CHAINS, balance });
  return check.ok ? {} : check.errors;
};

describe("checkAddressSend", () => {
  it("passes a valid draft as an atomic-unit order with a checksummed recipient", () => {
    const check = checkAddressSend(draft({ recipient: ` ${RECIPIENT} ` }), {
      chainIds: CHAINS,
      balance: 2_000_000n,
    });
    expect(check).toEqual({
      ok: true,
      order: {
        chainId: 8453,
        token: expect.objectContaining({ address: USDC_BASE.address, decimals: 6 }),
        amount: 1_500_000n,
        recipient: getAddress(RECIPIENT),
      },
    });
  });

  it.each([
    ["empty", ""],
    ["not hex", "0xnothex"],
    ["too short", "0x1234"],
    ["a bad EIP-55 checksum", "0xaBcdef0123456789abcdef0123456789abcdef01"],
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["a Tron address", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
    ["the token's own contract", USDC_BASE.address],
  ])("refuses a recipient that is %s", (_, recipient) => {
    expect(errorsOf(draft({ recipient }))).toHaveProperty("recipient");
  });

  it.each([
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["not a number", "1e3"],
    ["finer than the token's decimals", "0.0000001"],
  ])("refuses an amount that is %s", (_, amount) => {
    expect(errorsOf(draft({ amount }))).toHaveProperty("amount");
  });

  it("refuses more than a known balance, and defers to the wallet while it is unknown", () => {
    expect(errorsOf(draft({ amount: "1.500001" }), 1_500_000n)).toHaveProperty("amount");
    expect(errorsOf(draft({ amount: "1.5" }), 1_500_000n)).toEqual({});
    expect(errorsOf(draft({ amount: "1000000" }), null)).toEqual({});
  });

  it("refuses an asset that is not on the chosen chain, or a chain not offered", () => {
    expect(errorsOf(draft({ chainId: 1 }))).toHaveProperty("asset");
    expect(errorsOf(draft({ chainId: 42161 }))).toHaveProperty("asset");
  });

  it("reports every bad field at once", () => {
    expect(Object.keys(errorsOf(draft({ amount: "", recipient: "" }))).sort()).toEqual([
      "amount",
      "recipient",
    ]);
  });
});

describe("send chains and assets", () => {
  it("offers only configured chains that have token metadata, in their order", () => {
    expect(sendChainIds([8453, 999_999, 1])).toEqual([8453, 1]);
  });

  it("starts on USDC where the chain has it", () => {
    expect(defaultSendToken(1)?.symbol).toBe("USDC");
    expect(defaultSendToken(999_999)).toBeUndefined();
  });
});
