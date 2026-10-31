import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMBED_CODE_PATTERN,
  encodeEmbedParams,
  normalizeEmbedCode,
  parseEmbedHeight,
  parseEmbedParams,
  type EmbedParams,
} from "./params.js";

/** `n` distinct chain ids, 1 to n. */
const chainIds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
/** `n` distinct token symbols. */
const symbols = (n: number): string[] => Array.from({ length: n }, (_, i) => `T${i}`);

/** What `parseEmbedParams` reads from `key=value` alone (`value` URL-encoded here). */
const read = (key: string, value: string): EmbedParams =>
  parseEmbedParams(`${key}=${encodeURIComponent(value)}`);

describe("parseEmbedParams", () => {
  it("reads every parameter, with or without the leading ?", () => {
    const search =
      "fromChain=1&toChain=8453&sell=usdt&buy=USDC&amount=250.5&settlement=stealth" +
      "&theme=contrast&layout=swap&howItWorks=0&height=640&lock=buy,sell" +
      "&fromChains=8453,10&toChains=1&sellTokens=USDC,usdt&buyTokens=USDC" +
      "&ref=partner&promo=Launch10";
    const expected: EmbedParams = {
      fromChainId: 1,
      toChainId: 8453,
      sellSymbol: "usdt",
      buySymbol: "USDC",
      amount: "250.5",
      settlement: "stealth",
      theme: "contrast",
      layout: "swap",
      howItWorks: false,
      height: 640,
      locks: ["sell", "buy"],
      fromChains: [8453, 10],
      toChains: [1],
      sellTokens: ["USDC", "usdt"],
      buyTokens: ["USDC"],
      ref: "PARTNER",
      promo: "LAUNCH10",
    };
    expect(parseEmbedParams(search)).toEqual(expected);
    expect(parseEmbedParams(`?${search}`)).toEqual(expected);
  });

  it("drops malformed values and ignores unknown keys", () => {
    expect(
      parseEmbedParams(
        "fromChain=0&toChain=1e3&sell=US-DT&buy=&amount=-1&settlement=shielded&theme=dark",
      ),
    ).toEqual({});
    expect(parseEmbedParams("amount=1.&fromChain=0123")).toEqual({});
    expect(parseEmbedParams("")).toEqual({});
  });

  it("reads each theme exactly and drops any other", () => {
    for (const theme of ["auto", "light", "dim", "contrast"] as const) {
      expect(read("theme", theme)).toEqual({ theme });
    }
    for (const bad of ["dark", "Light", "AUTO", ""]) expect(read("theme", bad)).toEqual({});
  });

  it("reads the layout exactly and drops any other", () => {
    expect(read("layout", "full")).toEqual({ layout: "full" });
    expect(read("layout", "swap")).toEqual({ layout: "swap" });
    for (const bad of ["Swap", "compact", ""]) expect(read("layout", bad)).toEqual({});
  });

  it("reads howItWorks only as 0 or 1", () => {
    expect(read("howItWorks", "0")).toEqual({ howItWorks: false });
    expect(read("howItWorks", "1")).toEqual({ howItWorks: true });
    for (const bad of ["false", "true", "00", "2", ""]) expect(read("howItWorks", bad)).toEqual({});
  });

  it("reads a height in whole pixels from 480 to 1600", () => {
    for (const px of [480, 640, 1600]) expect(read("height", String(px))).toEqual({ height: px });
    for (const bad of ["479", "1601", "9999", "0640", "640.0", "640px", "+640", " 640", ""]) {
      expect(read("height", bad)).toEqual({});
    }
  });

  it("reads locks in their fixed order, or none when any entry is unknown or repeated", () => {
    expect(read("lock", "sell,buy,amount")).toEqual({ locks: ["sell", "amount", "buy"] });
    expect(read("lock", "buy,toChain,amount,sell,fromChain")).toEqual({
      locks: ["fromChain", "sell", "amount", "toChain", "buy"],
    });
    for (const bad of ["SELL", "sell,Sell", "sell,sell", "sell,price", "sell,,buy", "sell,", ""]) {
      expect(read("lock", bad)).toEqual({});
    }
  });

  it("reads the chain lists as numbers, up to 32 distinct ids", () => {
    for (const key of ["fromChains", "toChains"] as const) {
      expect(read(key, "8453,10")).toEqual({ [key]: [8453, 10] });
      expect(read(key, "999999999999")).toEqual({ [key]: [999999999999] });
      expect(read(key, chainIds(32).join(","))).toEqual({ [key]: chainIds(32) });
      for (const bad of [
        chainIds(33).join(","),
        "8453,8453",
        "0",
        "01",
        "1e3",
        "1000000000000",
        "8453,abc",
        "8453,",
        "",
      ]) {
        expect(read(key, bad)).toEqual({});
      }
    }
  });

  it("reads the token lists as typed, up to 32 symbols distinct in any case", () => {
    for (const key of ["sellTokens", "buyTokens"] as const) {
      expect(read(key, "USDC,usdt")).toEqual({ [key]: ["USDC", "usdt"] });
      expect(read(key, "A".repeat(16))).toEqual({ [key]: ["A".repeat(16)] });
      expect(read(key, symbols(32).join(","))).toEqual({ [key]: symbols(32) });
      for (const bad of [
        symbols(33).join(","),
        "USDC,usdc",
        "US-DC",
        "A".repeat(17),
        "USDC,",
        "USDC USDT",
        "",
      ]) {
        expect(read(key, bad)).toEqual({});
      }
    }
  });

  it("reads codes trimmed and uppercase, 3 to 32 characters starting with a letter or digit", () => {
    for (const key of ["ref", "promo"] as const) {
      expect(read(key, "partner")).toEqual({ [key]: "PARTNER" });
      expect(read(key, " summer_2-x ")).toEqual({ [key]: "SUMMER_2-X" });
      expect(read(key, "abc")).toEqual({ [key]: "ABC" });
      expect(read(key, "9".repeat(32))).toEqual({ [key]: "9".repeat(32) });
      for (const bad of ["ab", "A".repeat(33), "_ABC", "-ABC", "AB.C", "AB C", "ÄBC", ""]) {
        expect(read(key, bad)).toEqual({});
      }
    }
    // `+` is a space in a query string, trimmed like any other.
    expect(parseEmbedParams("ref=+partner+")).toEqual({ ref: "PARTNER" });
  });
});

describe("encodeEmbedParams", () => {
  it("writes nothing for no parameters", () => {
    expect(encodeEmbedParams({})).toBe("");
    expect(encodeEmbedParams({ amount: undefined })).toBe("");
  });

  it("writes keys in a fixed order whatever the object's order", () => {
    expect(
      encodeEmbedParams({
        settlement: "stealth",
        amount: "250",
        buySymbol: "USDC",
        sellSymbol: "USDT",
        toChainId: 1,
        fromChainId: 8453,
      }),
    ).toBe("?fromChain=8453&toChain=1&sell=USDT&buy=USDC&amount=250&settlement=stealth");
  });

  it("writes the route keys first, then the frame's keys in table order", () => {
    expect(
      encodeEmbedParams({
        promo: "LAUNCH10",
        ref: "PARTNER",
        buyTokens: ["USDC"],
        sellTokens: ["USDC", "usdt"],
        toChains: [1],
        fromChains: [8453, 10],
        locks: ["amount", "sell", "fromChain"],
        height: 640,
        howItWorks: false,
        layout: "swap",
        theme: "dim",
        settlement: "public",
        sellSymbol: "USDC",
      }),
    ).toBe(
      "?sell=USDC&settlement=public&theme=dim&layout=swap&howItWorks=0&height=640" +
        "&lock=fromChain,sell,amount&fromChains=8453,10&toChains=1&sellTokens=USDC,usdt" +
        "&buyTokens=USDC&ref=PARTNER&promo=LAUNCH10",
    );
    expect(encodeEmbedParams({ howItWorks: true })).toBe("?howItWorks=1");
  });

  it("round-trips through parseEmbedParams", () => {
    const cases: EmbedParams[] = [
      { fromChainId: 1 },
      { toChainId: 42161, buySymbol: "weth" },
      { sellSymbol: "USDG", amount: "0.000001", settlement: "public" },
      {
        fromChainId: 999999999999,
        toChainId: 10,
        sellSymbol: "A1",
        buySymbol: "Z9",
        amount: "123456789012345678901234567890.5",
        settlement: "stealth",
      },
      { theme: "auto", layout: "full", howItWorks: true, height: 480 },
      { theme: "contrast", howItWorks: false, height: 1600 },
      { locks: ["fromChain", "sell", "amount", "toChain", "buy"] },
      { fromChains: chainIds(32), toChains: [999999999999], sellTokens: symbols(32) },
      { buyTokens: ["usdc", "WETH"], ref: "ABC", promo: "9".repeat(32) },
      { ref: "SUMMER_2-X", promo: "LAUNCH10", toChains: [1] },
    ];
    for (const params of cases) expect(parseEmbedParams(encodeEmbedParams(params))).toEqual(params);
  });

  it("refuses a value the frame would drop, naming the field", () => {
    const bad: [EmbedParams, RegExp][] = [
      [{ fromChainId: 0 }, /fromChainId/],
      [{ toChainId: 1.5 }, /toChainId/],
      [{ toChainId: 1e12 }, /toChainId/],
      [{ fromChainId: Number.NaN }, /fromChainId/],
      [{ sellSymbol: "US DT" }, /sellSymbol/],
      [{ buySymbol: "" }, /buySymbol/],
      [{ amount: "1,000" }, /amount/],
      [{ amount: "1e3" }, /amount/],
      [{ settlement: "shielded" as "public" }, /settlement/],
      [{ fromChainId: "1" as unknown as number }, /fromChainId/],
    ];
    for (const [params, field] of bad) {
      expect(() => encodeEmbedParams(params)).toThrow(TypeError);
      expect(() => encodeEmbedParams(params)).toThrow(field);
    }
  });

  it("refuses a frame key the frame would drop, naming the field", () => {
    const cast = <T>(value: unknown) => value as T;
    const bad: EmbedParams[] = [
      { theme: cast("dark") },
      { theme: cast("Light") },
      { layout: cast("compact") },
      { howItWorks: cast("0") },
      { howItWorks: cast(0) },
      { height: 479 },
      { height: 1601 },
      { height: 640.5 },
      { height: Number.NaN },
      { height: cast("640") },
      { locks: [] },
      { locks: ["sell", "sell"] },
      { locks: cast(["price"]) },
      { locks: cast(["Sell"]) },
      { locks: cast("sell") },
      { fromChains: [] },
      { fromChains: [0] },
      { fromChains: [1.5] },
      { fromChains: [1e12] },
      { fromChains: [8453, 8453] },
      { fromChains: chainIds(33) },
      { fromChains: cast(["8453"]) },
      { toChains: [] },
      { toChains: [-1] },
      { toChains: chainIds(33) },
      { sellTokens: [] },
      { sellTokens: ["US-DC"] },
      { sellTokens: ["A".repeat(17)] },
      { sellTokens: ["USDC", "usdc"] },
      { sellTokens: ["USDC,USDT"] },
      { sellTokens: symbols(33) },
      { buyTokens: [""] },
      { buyTokens: cast("USDC") },
      { buyTokens: symbols(33) },
      { ref: "partner" },
      { ref: " PARTNER" },
      { ref: "AB" },
      { ref: "_ABC" },
      { ref: "A".repeat(33) },
      { ref: cast(123) },
      { promo: "launch10" },
      { promo: "LAUNCH 10" },
      { promo: "A".repeat(33) },
    ];
    for (const params of bad) {
      const [field] = Object.keys(params);
      expect(() => encodeEmbedParams(params), field).toThrow(TypeError);
      expect(() => encodeEmbedParams(params), field).toThrow(`embed parameter ${field} `);
    }
  });

  it("refuses an unknown key rather than dropping it", () => {
    expect(() => encodeEmbedParams({ sell: "USDT" } as EmbedParams)).toThrow(
      /unknown embed parameter "sell"/,
    );
    // The query key is `lock`; the field is `locks`.
    expect(() => encodeEmbedParams({ lock: ["sell"] } as EmbedParams)).toThrow(
      /unknown embed parameter "lock"/,
    );
  });
});

describe("helpers", () => {
  it("parseEmbedHeight applies the height rule to typed text", () => {
    expect(parseEmbedHeight("480")).toBe(480);
    expect(parseEmbedHeight("1600")).toBe(1600);
    expect(parseEmbedHeight("1601")).toBeUndefined();
    expect(parseEmbedHeight("640 ")).toBeUndefined();
  });

  it("normalizeEmbedCode gives a code's stored form, or null", () => {
    expect(normalizeEmbedCode("  partner ")).toBe("PARTNER");
    expect(normalizeEmbedCode("p")).toBeNull();
  });

  it("matches @xochi/client's referral and promo code patterns", () => {
    // The Worker re-checks every code against these; a frame that accepted
    // a different shape would send codes the server refuses, or drop ones
    // it takes. Read from source: this package has no dependencies.
    const schemas = readFileSync(
      resolve(import.meta.dirname, "../../client/src/shared/schemas.ts"),
      "utf8",
    );
    for (const name of ["REFERRAL_CODE_REGEX", "PROMO_CODE_REGEX"]) {
      const literal = new RegExp(`export const ${name} = /(.+)/([a-z]*);`).exec(schemas);
      expect(literal, name).not.toBeNull();
      expect(literal?.[1], name).toBe(EMBED_CODE_PATTERN.source);
      expect(literal?.[2], name).toBe(EMBED_CODE_PATTERN.flags);
    }
  });
});
