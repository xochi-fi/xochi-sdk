import { describe, expect, it } from "vitest";
import { encodeEmbedParams, parseEmbedParams, type EmbedParams } from "./params.js";

describe("parseEmbedParams", () => {
  it("reads every parameter, with or without the leading ?", () => {
    const search = "fromChain=1&toChain=8453&sell=usdt&buy=USDC&amount=250.5&settlement=stealth";
    const expected: EmbedParams = {
      fromChainId: 1,
      toChainId: 8453,
      sellSymbol: "usdt",
      buySymbol: "USDC",
      amount: "250.5",
      settlement: "stealth",
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

  it("refuses an unknown key rather than dropping it", () => {
    expect(() => encodeEmbedParams({ sell: "USDT" } as EmbedParams)).toThrow(
      /unknown embed parameter "sell"/,
    );
  });
});
