import { describe, it, expect } from "vitest";
import { SUPPORTED_CHAIN_IDS, TOKENS } from "@xochi/client";
import { parseCapabilities } from "@xochi/signer";
import {
  aggregateBySymbol,
  toAmount,
  pricingSymbol,
  readBalance,
  showsWalletDestinationBalance,
  publicBalanceTokens,
  erc20Balances,
  type PublicBalance,
} from "./balances.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const balances: PublicBalance[] = [
  {
    chainId: 8453,
    address: USDC_BASE,
    symbol: "USDC",
    decimals: 6,
    balance: 800_000000n,
    isNative: false,
  },
  {
    chainId: 42161,
    address: USDC_ARB,
    symbol: "USDC",
    decimals: 6,
    balance: 400_000000n,
    isNative: false,
  },
  {
    chainId: 8453,
    address: "native",
    symbol: "ETH",
    decimals: 18,
    balance: 10_000000000000000n,
    isNative: true,
  },
  { chainId: 42161, address: "0xweth", symbol: "WETH", decimals: 18, balance: 0n, isNative: false },
];

describe("toAmount", () => {
  it("scales by decimals", () => {
    expect(toAmount(800_000000n, 6)).toBe(800);
    expect(toAmount(10_000000000000000n, 18)).toBeCloseTo(0.01);
  });
});

describe("aggregateBySymbol", () => {
  it("sums a symbol across chains and lists only nonzero chains", () => {
    const agg = aggregateBySymbol(balances);
    const usdc = agg.find((a) => a.symbol === "USDC");
    expect(usdc?.amount).toBe(1200);
    expect(usdc?.perChain).toEqual([
      { chainId: 8453, amount: 800 },
      { chainId: 42161, amount: 400 },
    ]);
  });

  it("omits zero-balance chains from perChain", () => {
    const agg = aggregateBySymbol(balances);
    const weth = agg.find((a) => a.symbol === "WETH");
    expect(weth?.amount).toBe(0);
    expect(weth?.perChain).toEqual([]);
  });

  it("sorts holdings by amount descending", () => {
    const symbols = aggregateBySymbol(balances).map((a) => a.symbol);
    expect(symbols[0]).toBe("USDC");
  });
});

describe("pricingSymbol", () => {
  it("prices WETH as ETH, others unchanged", () => {
    expect(pricingSymbol("WETH")).toBe("ETH");
    expect(pricingSymbol("USDC")).toBe("USDC");
  });
});

/**
 * The receiving leg's balance says "you hold", so it may only appear when the
 * payout lands in the connected wallet.
 *
 * Reporting a chain never read as zero quietly prints "0.00 USDC" where the
 * honest answer is "--". On a non-EVM route it would also attribute a typed
 * stranger's holdings to the user.
 */
describe("showsWalletDestinationBalance", () => {
  const TRON = 728126428;

  it("shows it for a connected wallet on an EVM destination", () => {
    expect(showsWalletDestinationBalance(true, false, 8453)).toBe(true);
    expect(showsWalletDestinationBalance(true, false, 1)).toBe(true);
  });

  it("hides it with no wallet connected, because there is nothing to read", () => {
    expect(showsWalletDestinationBalance(false, false, 8453)).toBe(false);
  });

  // The payout goes to an address the user typed. Its balance belongs under the
  // recipient field, worded as that address's, never in a header that says "you".
  it("hides it on a non-EVM destination, whatever the chain id says", () => {
    expect(showsWalletDestinationBalance(true, true, TRON)).toBe(false);
    expect(showsWalletDestinationBalance(true, true, 8453)).toBe(false);
  });

  // Belt and braces on the same point: a non-EVM chain id has no readable EVM
  // balance even if the caller forgot to set the flag.
  it("hides it for a chain the EVM balance reader does not cover", () => {
    expect(showsWalletDestinationBalance(true, false, TRON)).toBe(false);
    expect(showsWalletDestinationBalance(true, false, 999999)).toBe(false);
  });
});

describe("readBalance (unknown is not empty)", () => {
  it("returns the balance only for a successful read", () => {
    expect(readBalance(balances, 8453, USDC_BASE.toUpperCase())).toBe(800_000000n);
    expect(readBalance(balances, 42161, USDC_ARB)).toBe(400_000000n);
    expect(readBalance(balances, 8453, USDC_BASE.toLowerCase())).toBe(800_000000n);
    const pending: PublicBalance[] = [{ ...balances[0], balance: 0n, unread: true }];
    expect(readBalance(pending, 8453, USDC_BASE)).toBeNull();
    expect(readBalance(balances, 1, USDC_BASE)).toBeNull();
  });
});

describe("public wallet asset discovery", () => {
  it("reads Ethereum DAI with canonical precision and exposes positive holdings to both legs", () => {
    const tokens = publicBalanceTokens();
    const dai = tokens.find((token) => token.chainId === 1 && token.symbol === "DAI");
    expect(dai).toMatchObject({
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      decimals: 18,
    });
    if (!dai) throw new Error("Canonical Ethereum DAI is missing");
    const wallet = erc20Balances([dai], [{ status: "success", result: 25n * 10n ** 18n }]);
    expect(readBalance(wallet, 1, dai.address)).toBe(25n * 10n ** 18n);
    expect(showsWalletDestinationBalance(true, false, 1)).toBe(true);
    expect(aggregateBySymbol(wallet)).toEqual([
      { symbol: "DAI", decimals: 18, amount: 25, perChain: [{ chainId: 1, amount: 25 }] },
    ]);
  });

  it("keeps every canonical deployment even without an executable trade pair", () => {
    const capabilities = parseCapabilities({ chains: [], tokens: [], conversion_pairs: [] });
    if (!capabilities) throw new Error("Capability fixture is invalid");
    const tokens = publicBalanceTokens(capabilities);
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const token of TOKENS[chainId]) {
        expect(tokens).toContainEqual(expect.objectContaining({ chainId, ...token }));
      }
    }
    expect(
      tokens
        .filter((token) => token.symbol === "DAI")
        .map((token) => token.chainId)
        .sort((a, b) => a - b),
    ).toEqual([1, 10, 8453, 42161]);
  });

  it("adds advertised public metadata without duplicates or changing known per-chain decimals", () => {
    const usdc = TOKENS[8453].find((token) => token.symbol === "USDC");
    if (!usdc) throw new Error("Canonical Base USDC is missing");
    const address = "0x1111111111111111111111111111111111111111";
    const capabilities = parseCapabilities({
      tokens: [
        { symbol: "USDC", decimals: 18, addresses: { 8453: usdc.address.toLowerCase() } },
        { symbol: "NEW", decimals: 8, roles: ["destination"], addresses: { 1: address } },
        { symbol: "UNREADABLE", addresses: { 1: address.replace(/1/g, "2") } },
        {
          symbol: "NON_EVM",
          decimals: 6,
          addresses: { 728126428: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
        },
      ],
      conversion_pairs: [],
    });
    if (!capabilities) throw new Error("Capability fixture is invalid");
    const tokens = publicBalanceTokens(capabilities);
    expect(
      tokens.filter(
        (token) =>
          token.chainId === 8453 && token.address.toLowerCase() === usdc.address.toLowerCase(),
      ),
    ).toEqual([expect.objectContaining({ decimals: 6 })]);
    expect(tokens).toContainEqual({ chainId: 1, address, symbol: "NEW", decimals: 8 });
    expect(
      tokens.some((token) => token.symbol === "UNREADABLE" || token.symbol === "NON_EVM"),
    ).toBe(false);
    expect(tokens.filter((token) => token.chainId === 5042)).toEqual([
      expect.objectContaining({ symbol: "USDC", decimals: 6 }),
    ]);
    expect(tokens.some((token) => token.address === "native")).toBe(false);
  });

  it("preserves successful chains and true zero while failed and unconfigured reads stay unknown", () => {
    const tokens = publicBalanceTokens();
    const dai = tokens.find((token) => token.chainId === 1 && token.symbol === "DAI");
    const base = tokens.find((token) => token.chainId === 8453 && token.symbol === "USDC");
    const arb = tokens.find((token) => token.chainId === 42161 && token.symbol === "USDC");
    const op = tokens.find((token) => token.chainId === 10 && token.symbol === "USDC");
    if (!dai || !base || !arb || !op) throw new Error("Canonical balance fixtures are missing");
    const wallet = [
      ...erc20Balances([dai], [{ status: "success", result: 5n * 10n ** 18n }]),
      ...erc20Balances([base], [{ status: "success", result: 0n }]),
      ...erc20Balances([arb], [{ status: "failure", error: new Error("RPC unavailable") }]),
      ...erc20Balances([op], undefined),
    ];
    expect(readBalance(wallet, 1, dai.address)).toBe(5n * 10n ** 18n);
    expect(readBalance(wallet, 8453, base.address)).toBe(0n);
    expect(readBalance(wallet, 42161, arb.address)).toBeNull();
    expect(readBalance(wallet, 10, op.address)).toBeNull();
    expect(aggregateBySymbol(wallet)).toEqual([
      { symbol: "DAI", decimals: 18, amount: 5, perChain: [{ chainId: 1, amount: 5 }] },
      { symbol: "USDC", decimals: 6, amount: 0, perChain: [] },
    ]);
    expect(aggregateBySymbol(erc20Balances([dai], undefined))).toEqual([]);
  });
});
