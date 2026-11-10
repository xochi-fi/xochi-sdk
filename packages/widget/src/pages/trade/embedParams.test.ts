/**
 * Frame URL parameters (xochi-widget#21): what /embed accepts, and that it
 * falls back to today's defaults for anything it cannot honour instead of
 * failing. The frame wiring is covered by embedDefaults.test.tsx; this file
 * pins the rules themselves.
 */

import { describe, it, expect } from "vitest";
import { PROMO_CODE_REGEX, REFERRAL_CODE_REGEX, SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import type { SolverCapabilities } from "@xochi/signer";
import { FALLBACK_CAPABILITIES } from "../../lib/capabilities.js";
import { parseWidgetCapabilities } from "../../hooks/useCapabilities.js";
import { findTokenBySymbol } from "./config.js";
import {
  EMBED_CODE_PATTERN,
  EMBED_HEIGHT,
  EMBED_THEMES,
  encodeEmbedParams,
  parseEmbedHeight,
  parseEmbedParams,
} from "@xochi/widget-lib";
import {
  FRAME_DEFAULTS,
  embedOffer,
  embedOverrides,
  explainEmbedDefaults,
  legTokens,
  resolveEmbedDefaults,
  routeFills,
  stealthOffered,
  type EmbedDefaults,
  type EmbedOffer,
  type FrameField,
  CLAIMS_HASH,
  claimsPath,
  embedLook,
  policyAdmits,
  policyHolds,
  legChainAllowed,
  legTokenAllowed,
  heightProblem,
  codeProblem,
  embedCodes,
} from "./embedParams.js";
import { EMBED_THEME_APP } from "./embedTheme.js";

const ETHEREUM = 1;
const BASE = 8453;
const ARBITRUM = 42161;
const OPTIMISM = 10;

/** A live matrix: four EVM chains, three stables, one advertised conversion. */
function liveCapabilities(
  pairs: { from: string; to: string }[],
  stealthChains?: unknown,
  routePrivacy?: (route: {
    fromChainId: number;
    toChainId: number;
    from: string;
    to: string;
  }) => readonly ("public" | "stealth")[] | null | undefined,
): SolverCapabilities {
  const chainIds = [ETHEREUM, BASE, ARBITRUM, OPTIMISM] as const;
  const symbols = ["USDC", "USDT", "USDG"] as const;
  const stealthDestinations = new Set(
    Array.isArray(stealthChains)
      ? stealthChains.filter((chainId): chainId is number => typeof chainId === "number")
      : [],
  );
  const caps = parseWidgetCapabilities({
    cross_chain_only: true,
    chains: chainIds.map((chain_id) => ({
      chain_id,
      chain_name: String(chain_id),
      vm_type: "evm",
      ...(stealthDestinations.has(chain_id)
        ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
        : {}),
    })),
    tokens: symbols.map((symbol) => {
      const deployments = chainIds.flatMap((chainId) => {
        const token = findTokenBySymbol(chainId, symbol);
        return token ? [[chainId, token] as const] : [];
      });
      const first = deployments[0]?.[1];
      if (!first) {
        return {
          symbol,
          roles: ["origin", "destination"],
          decimals: 6,
          addresses: { [ETHEREUM]: "0x0000000000000000000000000000000000000003" },
        };
      }
      return {
        symbol,
        roles: ["origin", "destination"],
        decimals: first.decimals,
        addresses: Object.fromEntries(
          deployments.map(([chainId, token]) => [chainId, token.address]),
        ),
      };
    }),
    conversion_pairs: pairs,
    routes: chainIds.flatMap((fromChainId) =>
      chainIds.flatMap((toChainId) =>
        fromChainId === toChainId
          ? []
          : [...symbols.map((symbol) => ({ from: symbol, to: symbol })), ...pairs].flatMap(
              ({ from, to }) => {
                const configured = routePrivacy?.({ fromChainId, toChainId, from, to });
                if (configured === null) return [];
                return [
                  {
                    origin: { chain_id: fromChainId, token: from },
                    destination: { kind: "chain", chain_id: toChainId, token: to },
                    privacy_modes: configured ?? [
                      "public",
                      ...(stealthDestinations.has(toChainId) ? (["stealth"] as const) : []),
                    ],
                  },
                ];
              },
            ),
      ),
    ),
    ...(stealthChains === undefined ? {} : { stealth_chains: stealthChains }),
  });
  if (caps === null) throw new Error("test matrix did not parse");
  return caps;
}

const PAIRS = [{ from: "USDT", to: "USDC" }];
const LIVE = embedOffer(liveCapabilities(PAIRS, [BASE, ETHEREUM]), true);
const LIVE_NO_PAIRS = embedOffer(liveCapabilities([], [BASE, ETHEREUM]), true);
const FALLBACK = embedOffer(FALLBACK_CAPABILITIES, false);

const resolve = (search: string, offer: EmbedOffer = LIVE): EmbedDefaults =>
  resolveEmbedDefaults(parseEmbedParams(search), offer);
/** The query string the configurator writes for `defaults`. */
const embedSearch = (defaults: EmbedDefaults): string =>
  encodeEmbedParams(embedOverrides(defaults));
const BASE_STEALTH_URL = "fromChain=1&toChain=8453&settlement=stealth";

/** The four route fields as plain values, for readable expectations. */
const shape = (d: EmbedDefaults) => ({
  fromChainId: d.fromChainId,
  toChainId: d.toChainId,
  sell: d.fromToken.symbol,
  buy: d.toToken.symbol,
  amount: d.amount,
  settlement: d.settlement,
});

describe("themes", () => {
  it("default to auto, apply a shipped app theme each, and are never ignored", () => {
    expect(FRAME_DEFAULTS.theme).toBe("auto");
    expect(resolve("").theme).toBe("auto");
    expect(EMBED_THEME_APP).toEqual({
      auto: null,
      light: "light",
      dim: "dim",
      contrast: "dark",
    });
    for (const theme of EMBED_THEMES) {
      for (const offer of [LIVE, FALLBACK]) {
        const { defaults, ignored } = explainEmbedDefaults({ theme, toChainId: 999 }, offer);
        expect(defaults.theme).toBe(theme);
        expect(ignored.theme).toBeUndefined();
      }
      const written = embedSearch({ ...FRAME_DEFAULTS, theme });
      expect(resolve(written).theme).toBe(theme);
    }
  });
});

describe("layout", () => {
  it("gives the configurator's typed height the frame's own rule", () => {
    expect(parseEmbedHeight("640")).toBe(640);
    expect(parseEmbedHeight(" 640")).toBeUndefined();
    for (const ok of [
      "",
      "   ",
      "640",
      " 640 ",
      String(EMBED_HEIGHT.min),
      String(EMBED_HEIGHT.max),
    ]) {
      expect(heightProblem(ok), ok).toBeNull();
    }
    for (const bad of ["640px", "640.5", "0640", "-640", String(EMBED_HEIGHT.min - 1), "abc"]) {
      expect(parseEmbedHeight(bad), bad).toBeUndefined();
      expect(heightProblem(bad), bad).toBe(
        `Use a whole number of pixels from ${EMBED_HEIGHT.min} to ${EMBED_HEIGHT.max}.`,
      );
    }
  });

  it("defaults to today's frame, is never ignored, and round-trips", () => {
    expect(embedLook({})).toEqual({
      theme: "auto",
      layout: "full",
      howItWorks: true,
      height: null,
    });
    const cases: [string, Partial<EmbedDefaults>][] = [
      ["", {}],
      ["?layout=swap", { layout: "swap" }],
      ["?howItWorks=0", { howItWorks: false }],
      ["?height=640", { height: 640 }],
      ["?layout=swap&howItWorks=0&height=900", { layout: "swap", howItWorks: false, height: 900 }],
    ];
    for (const [search, look] of cases) {
      const config = { ...FRAME_DEFAULTS, ...look };
      expect(resolve(embedSearch(config))).toEqual(config);
      const { defaults, ignored } = explainEmbedDefaults(parseEmbedParams(search), LIVE);
      expect(defaults, search).toMatchObject(look);
      expect(ignored, search).toEqual({});
    }
  });

  it("sends a tabless frame's claims to the full widget, in its theme", () => {
    expect(claimsPath("auto")).toBe(`/embed${CLAIMS_HASH}`);
    expect(claimsPath("contrast")).toBe(`/embed?theme=contrast${CLAIMS_HASH}`);
    // The full widget opened from it: no layout parameter survives.
    expect(
      embedLook(parseEmbedParams(new URL(claimsPath("dim"), "https://x.invalid").search)),
    ).toEqual({ theme: "dim", layout: "full", howItWorks: true, height: null });
  });
});

describe("locks and allow-lists", () => {
  it("opens inside the allow-lists, and names what they push out", () => {
    const listed = explainEmbedDefaults(parseEmbedParams("sellTokens=USDT&fromChains=1"), LIVE);
    expect(shape(listed.defaults)).toMatchObject({ fromChainId: ETHEREUM, sell: "USDT" });
    expect(listed.defaults.fromChains).toEqual([ETHEREUM]);
    expect(listed.defaults.sellTokens).toEqual(["USDT"]);
    expect(listed.ignored).toEqual({});

    const pushed = explainEmbedDefaults(parseEmbedParams("sell=USDC&sellTokens=USDT"), LIVE);
    expect(pushed.defaults.fromToken.symbol).toBe("USDT");
    expect(pushed.ignored.sellSymbol).toBe("it is outside the allow-lists");
  });

  it("ignores a list that keeps nothing, and all of them when no route is left", () => {
    const none = explainEmbedDefaults(parseEmbedParams("fromChains=999"), LIVE);
    expect(none.defaults.fromChains).toBeNull();
    expect(none.ignored.fromChains).toMatch(/sends from none of/);

    // Cross-chain only: Base to Base fills nothing, so both lists go.
    const stuck = explainEmbedDefaults(parseEmbedParams("fromChains=8453&toChains=8453"), LIVE);
    expect(stuck.defaults.fromChains).toBeNull();
    expect(stuck.defaults.toChains).toBeNull();
    expect(shape(stuck.defaults)).toEqual(shape(FRAME_DEFAULTS));
    expect(stuck.ignored.fromChains).toMatch(/leave no route the solver fills/);
    expect(stuck.ignored.toChains).toMatch(/leave no route the solver fills/);
  });

  it("never offers Canton TestNet, a chain id past 2^31 the widget does not serve", () => {
    const CANTON_TESTNET = 4149314359;
    const parsed = parseEmbedParams(
      `toChain=${CANTON_TESTNET}&fromChains=${CANTON_TESTNET}&toChains=${CANTON_TESTNET}`,
    );
    // Well-formed (twelve digits at most), so it reaches the resolver whole.
    expect(parsed.toChains).toEqual([CANTON_TESTNET]);
    const { defaults, ignored } = explainEmbedDefaults(parsed, LIVE);
    expect(defaults.toChainId).toBe(FRAME_DEFAULTS.toChainId);
    expect(defaults.fromChains).toBeNull();
    expect(defaults.toChains).toBeNull();
    expect(ignored.fromChains).toMatch(/sends from none of/);
    expect(ignored.toChains).toMatch(/delivers to none of/);
  });

  it("locks what the frame opens on; the amount lock takes its leg and needs an amount", () => {
    expect(resolve("lock=buy,toChain").locks).toEqual(["toChain", "buy"]);
    const amountless = explainEmbedDefaults(parseEmbedParams("lock=amount"), LIVE);
    expect(amountless.defaults.locks).toEqual([]);
    expect(amountless.ignored.locks).toMatch(/only be locked/);
    expect(resolve("lock=amount&amount=5").locks).toEqual(["fromChain", "sell", "amount"]);
  });

  it("writes lists with plain commas and reads them back unchanged", () => {
    const config = resolve("lock=sell,buy&fromChains=1,10&sellTokens=USDC&toChains=42161");
    const written = embedSearch(config);
    // Base is outside fromChains, so the frame opens on the first listed chain.
    expect(resolve(written)).toEqual(config);
  });

  it("admits a route only inside every list", () => {
    const policy = resolve("fromChains=1&buyTokens=USDC");
    const route = { fromChainId: 1, toChainId: 42161, fromSymbol: "USDT", toSymbol: "USDC" };
    expect(policyAdmits(policy, route)).toBe(true);
    expect(policyAdmits(policy, { ...route, fromChainId: 8453 })).toBe(false);
    expect(policyAdmits(policy, { ...route, toSymbol: "USDT" })).toBe(false);
  });

  it("lets a leg move only where its locks and lists allow", () => {
    const sellLocked = resolve("sell=USDT&lock=sell");
    const onBase = { chainId: BASE, symbol: "USDT" };
    expect(legChainAllowed(sellLocked, "sell", ARBITRUM, onBase)).toBe(true);
    // A chain without the locked token is refused (no USDT in an empty registry).
    expect(legChainAllowed(sellLocked, "sell", 999, onBase)).toBe(false);
    expect(legTokenAllowed(sellLocked, "sell", { chainId: BASE, symbol: "USDC" }, BASE)).toBe(
      false,
    );

    const chainLocked = resolve("toChain=1&lock=toChain&buyTokens=USDC");
    const onEthereum = { chainId: ETHEREUM, symbol: "USDC" };
    expect(legChainAllowed(chainLocked, "buy", ETHEREUM, onEthereum)).toBe(true);
    expect(legChainAllowed(chainLocked, "buy", ARBITRUM, onEthereum)).toBe(false);
    expect(
      legTokenAllowed(chainLocked, "buy", { chainId: ETHEREUM, symbol: "USDT" }, ETHEREUM),
    ).toBe(false);
    expect(
      legTokenAllowed(chainLocked, "buy", { chainId: ARBITRUM, symbol: "USDC" }, ETHEREUM),
    ).toBe(false);
  });

  it("holds a route and amount to every lock, refusing any amount a lock cannot accept", () => {
    const checkout = resolve("fromChain=10&sell=USDT&amount=25&lock=amount");
    const route = {
      fromChainId: OPTIMISM,
      toChainId: ARBITRUM,
      fromSymbol: "USDT",
      toSymbol: "USDC",
    };
    expect(policyHolds(checkout, route, "25")).toBe(true);
    expect(policyHolds(checkout, route, "30")).toBe(false);
    expect(policyHolds(checkout, route, null)).toBe(false);
    expect(policyHolds(checkout, { ...route, fromChainId: BASE }, "25")).toBe(false);
    // The receive leg is not locked.
    expect(policyHolds(checkout, { ...route, toChainId: ETHEREUM }, "25")).toBe(true);
  });

  it("writes the amount lock without the send-leg locks it implies", () => {
    const config = resolve("fromChain=10&sell=USDT&amount=25&lock=amount,buy");
    expect(config.locks).toEqual(["fromChain", "sell", "amount", "buy"]);
    const written = embedSearch(config);
    expect(new URLSearchParams(written).get("lock")).toBe("amount,buy");
    expect(resolve(written)).toEqual(config);
  });
});

describe("resolveEmbedDefaults", () => {
  it("honours a valid route, amount and settlement", () => {
    expect(
      shape(resolve("fromChain=10&toChain=1&sell=usdt&buy=USDC&amount=0250&settlement=stealth")),
    ).toEqual({
      fromChainId: OPTIMISM,
      toChainId: ETHEREUM,
      sell: "USDT",
      buy: "USDC",
      amount: "250",
      settlement: "stealth",
    });
  });

  it("ignores an unknown chain or token, keeping the rest", () => {
    // 999 is no chain; Gnosis is not offered by this matrix; DOGE is no token.
    expect(shape(resolve("fromChain=999&toChain=100&sell=USDT"))).toMatchObject({
      fromChainId: BASE,
      toChainId: ARBITRUM,
      sell: "USDT",
    });
    expect(shape(resolve("sell=USDT&buy=DOGE"))).toMatchObject({ sell: "USDT", buy: "USDC" });
    // USDG is a token, but not one Arbitrum carries.
    expect(shape(resolve("sell=USDT&buy=USDG"))).toMatchObject({ sell: "USDT", buy: "USDC" });
    // WETH is in the registry on Base but the solver does not take it.
    expect(shape(resolve("sell=WETH"))).toMatchObject({ sell: "USDC" });
  });

  it("uses the sole exact live route when the standard defaults are absent", () => {
    const soleRoute = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], ({ fromChainId, toChainId, from, to }) =>
        fromChainId === ETHEREUM && toChainId === OPTIMISM && from === "USDT" && to === "USDC"
          ? ["public"]
          : null,
      ),
      true,
    );

    expect(shape(resolve("", soleRoute))).toEqual({
      fromChainId: ETHEREUM,
      toChainId: OPTIMISM,
      sell: "USDT",
      buy: "USDC",
      amount: "",
      settlement: "public",
    });
  });

  it("keeps a valid explicit Stealth amount as display-only when no routes remain", () => {
    const empty = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], () => null),
      true,
    );
    const resolved = explainEmbedDefaults(
      parseEmbedParams("amount=5&settlement=stealth&theme=light"),
      empty,
    );

    expect(shape(resolved.defaults)).toEqual({
      ...shape(FRAME_DEFAULTS),
      amount: "5",
      settlement: "stealth",
    });
    expect(resolved.defaults.theme).toBe("light");
    expect(resolved.ignored.amount).toBeUndefined();
    expect(stealthOffered(resolved.defaults, empty.capabilities, "live")).toBe(false);
    expect(resolved.ignored.settlement).toBeUndefined();
  });

  it.each(["deployment", "chain", "empty"] as const)(
    "preserves an explicit Stealth deployment and amount after %s inventory withdrawal",
    (withdrawal) => {
      const capabilities = parseWidgetCapabilities({
        ...LIVE.capabilities.raw,
        ...(withdrawal === "empty" ? { chains: [] } : {}),
        tokens:
          withdrawal === "empty"
            ? []
            : [
                {
                  symbol: "USDC",
                  roles: ["origin", "destination"],
                  decimals: 6,
                  addresses: { [ETHEREUM]: findTokenBySymbol(ETHEREUM, "USDC")!.address },
                },
                ...(withdrawal === "chain"
                  ? []
                  : [
                      {
                        symbol: "USDT",
                        roles: ["destination"],
                        decimals: 6,
                        addresses: { [BASE]: findTokenBySymbol(BASE, "USDT")!.address },
                      },
                    ]),
              ],
        routes:
          withdrawal === "deployment"
            ? [
                {
                  origin: { chain_id: ETHEREUM, token: "USDC" },
                  destination: { kind: "chain", chain_id: BASE, token: "USDT" },
                  privacy_modes: ["public", "stealth"],
                },
              ]
            : [],
      });
      if (withdrawal === "empty") expect(capabilities).toBeNull();
      const effectiveCapabilities = withdrawal === "empty" ? FALLBACK_CAPABILITIES : capabilities;
      if (!effectiveCapabilities) throw new Error("withdrawn inventory did not parse");
      const capabilityState = withdrawal === "empty" ? "fallback" : "live";
      const offer = embedOffer(effectiveCapabilities, capabilityState);
      const { defaults, ignored } = explainEmbedDefaults(
        parseEmbedParams(
          "fromChain=1&sell=USDC&toChain=8453&buy=USDC&amount=12.5&settlement=stealth&lock=toChain,buy,amount",
        ),
        offer,
      );
      expect(shape(defaults)).toEqual({
        fromChainId: ETHEREUM,
        toChainId: BASE,
        sell: "USDC",
        buy: "USDC",
        amount: "12.5",
        settlement: "stealth",
      });
      expect(defaults.toToken).toEqual(findTokenBySymbol(BASE, "USDC"));
      expect([...defaults.locks].sort()).toEqual(["amount", "buy", "fromChain", "sell", "toChain"]);
      expect(ignored).toEqual({});
      if (capabilityState === "live") {
        expect(legTokens(offer, BASE, "buy").some((token) => token.symbol === "USDC")).toBe(false);
        expect(routeFills(offer, defaults)).toBe(false);
      }
      expect(stealthOffered(defaults, effectiveCapabilities, capabilityState)).toBe(false);
    },
  );

  it("keeps display continuity inside host lists and refuses unknown Stealth deployments", () => {
    const empty = embedOffer(
      liveCapabilities([], [], () => null),
      "live",
    );
    const constrained = resolve(
      "fromChain=1&sell=USDC&toChain=8453&buy=USDC&settlement=stealth&toChains=42161&buyTokens=USDT",
      empty,
    );
    expect(constrained.toChainId).toBe(ARBITRUM);
    expect(constrained.toToken.symbol).toBe("USDT");
    expect(constrained.toChains).toEqual([ARBITRUM]);
    expect(constrained.buyTokens).toEqual(["USDT"]);
    const invalid = explainEmbedDefaults(
      parseEmbedParams("fromChain=999&sell=DOGE&toChain=999&buy=DOGE&amount=20&settlement=stealth"),
      empty,
    );
    expect(invalid.defaults.fromChainId).not.toBe(999);
    expect(invalid.defaults.toChainId).not.toBe(999);
    expect(invalid.defaults.fromToken.symbol).not.toBe("DOGE");
    expect(invalid.defaults.toToken.symbol).not.toBe("DOGE");
    expect(invalid.defaults.amount).toBe("");
    expect(invalid.ignored).toMatchObject({
      fromChainId: expect.any(String),
      toChainId: expect.any(String),
      sellSymbol: expect.any(String),
      buySymbol: expect.any(String),
      amount: expect.any(String),
    });
  });

  it("falls back from a pair the live matrix does not fill", () => {
    // Only USDT -> USDC converts; USDC -> USDT is not advertised.
    expect(shape(resolve("fromChain=1&sell=USDC&buy=USDT&amount=40"))).toEqual({
      fromChainId: ETHEREUM,
      toChainId: ARBITRUM,
      sell: "USDC",
      buy: "USDC",
      amount: "40",
      settlement: "public",
    });
    // Same chain is never filled. With no valid requested route, the frame
    // opens on the first exact route the live matrix advertises.
    expect(shape(resolve("fromChain=42161&toChain=42161&amount=40"))).toEqual({
      fromChainId: ETHEREUM,
      toChainId: BASE,
      sell: "USDC",
      buy: "USDC",
      amount: "",
      settlement: "stealth",
    });
  });

  it("keeps a cross-coin pair the fallback cannot judge, and refuses it once live says no", () => {
    expect(shape(resolve("sell=USDT", FALLBACK))).toMatchObject({ sell: "USDT", buy: "USDC" });
    expect(shape(resolve("sell=USDT", LIVE_NO_PAIRS))).toMatchObject({
      sell: "USDC",
      buy: "USDC",
    });
  });

  it("defaults eligible routes to Stealth, but honors explicit Public", () => {
    expect(resolve("").settlement).toBe("stealth");
    expect(resolve("").fromChainId).toBe(BASE);
    expect(resolve("").toChainId).toBe(ETHEREUM);
    expect(resolve("fromChain=1&toChain=8453").settlement).toBe("stealth");
    expect(resolve("toChain=1").settlement).toBe("stealth");
    expect(resolve("toChain=1&settlement=public").settlement).toBe("public");
    expect(resolve("toChain=42161").settlement).toBe("public");
    expect(resolve("toChain=1", FALLBACK).settlement).toBe("public");
  });

  it("does not send an explicit Public opening to a Stealth-only route", () => {
    const offer = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], ({ fromChainId, toChainId, from, to }) => {
        if (fromChainId !== BASE || from !== "USDC" || to !== "USDC") return null;
        if (toChainId === ETHEREUM) return ["stealth"];
        if (toChainId === ARBITRUM) return ["public"];
        return null;
      }),
      true,
    );

    expect(shape(resolve("settlement=public", offer))).toMatchObject({
      toChainId: ARBITRUM,
      settlement: "public",
    });
  });

  it.each(["toChain=42161", "lock=toChain,buy", "toChains=42161&buyTokens=USDC", "amount=25"])(
    "does not move the opening route outside a host preset: %s",
    (search) => {
      expect(shape(resolve(search))).toMatchObject({
        fromChainId: BASE,
        toChainId: ARBITRUM,
        sell: "USDC",
        buy: "USDC",
        settlement: "public",
      });
    },
  );

  it("keeps the opening asset when a same-chain conversion is also advertised first", () => {
    const capabilities = parseWidgetCapabilities({
      ...LIVE.capabilities.raw,
      cross_chain_only: false,
      conversion_pairs: [{ from: "USDC", to: "USDT", same_chain: true }],
      routes: [
        {
          origin: { chain_id: BASE, token: "USDC" },
          destination: { kind: "chain", chain_id: BASE, token: "USDT" },
          privacy_modes: ["public", "stealth"],
        },
        {
          origin: { chain_id: BASE, token: "USDC" },
          destination: { kind: "chain", chain_id: ETHEREUM, token: "USDC" },
          privacy_modes: ["public", "stealth"],
        },
      ],
    });
    if (!capabilities) throw new Error("test graph did not parse");
    expect(shape(resolve("", embedOffer(capabilities, true)))).toMatchObject({
      fromChainId: BASE,
      toChainId: ETHEREUM,
      sell: "USDC",
      buy: "USDC",
      settlement: "stealth",
    });
  });

  it("preserves explicit Stealth even when it needs a route or capability fix", () => {
    expect(resolve("settlement=stealth").settlement).toBe("stealth");
    expect(resolve(BASE_STEALTH_URL, FALLBACK).settlement).toBe("stealth");
    expect(resolve("toChain=999&settlement=stealth").settlement).toBe("stealth");
  });

  it("does not infer automatic Stealth without trusted served destinations", () => {
    for (const advertised of [undefined, [], null, "8453", { chain: BASE }]) {
      const offer = embedOffer(liveCapabilities(PAIRS, advertised), true);
      expect(resolve("fromChain=1&toChain=8453", offer).settlement).toBe("public");
      expect(resolve("toChain=1", offer).settlement).toBe("public");
    }
    const baseOnly = embedOffer(liveCapabilities(PAIRS, [BASE]), true);
    expect(resolve("fromChain=1&toChain=8453", baseOnly).settlement).toBe("stealth");
    expect(resolve("toChain=1", baseOnly).settlement).toBe("public");
  });

  it("uses exact route privacy modes rather than trusted chain membership alone", () => {
    const capabilities = (privacyModes: string[]): SolverCapabilities => {
      const parsed = parseWidgetCapabilities({
        ...LIVE.capabilities.raw,
        routes: [
          {
            origin: { chain_id: BASE, token: "USDC" },
            destination: { kind: "chain", chain_id: ETHEREUM, token: "USDC" },
            privacy_modes: privacyModes,
          },
        ],
      });
      if (!parsed) throw new Error("test graph did not parse");
      return parsed;
    };
    const publicOnly = embedOffer(capabilities(["public"]), true);
    const privateRoute = embedOffer(capabilities(["public", "stealth"]), true);
    expect(resolve("", publicOnly).settlement).toBe("public");
    expect(resolve("toChain=1", publicOnly).settlement).toBe("public");
    expect(resolve("", privateRoute).settlement).toBe("stealth");
    const publicChoice = resolve("toChain=1&settlement=public", privateRoute);
    expect(resolve(embedSearch(publicChoice), privateRoute)).toEqual(publicChoice);
    expect(resolve("toChain=42161", privateRoute).toChainId).toBe(ETHEREUM);
  });

  it("does not let a global stealth chain grant Stealth to a Public-only exact route", () => {
    const publicOnly = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], ({ fromChainId, toChainId, from, to }) =>
        fromChainId === BASE && toChainId === ETHEREUM && from === "USDC" && to === "USDC"
          ? ["public"]
          : undefined,
      ),
      true,
    );

    const route = resolve("toChain=1", publicOnly);
    expect(stealthOffered(route, publicOnly.capabilities, "live")).toBe(false);
    const resolved = explainEmbedDefaults(
      parseEmbedParams("toChain=1&settlement=stealth"),
      publicOnly,
    );
    expect(shape(resolved.defaults)).toMatchObject({
      fromChainId: BASE,
      toChainId: ETHEREUM,
      settlement: "stealth",
    });
    expect(resolved.ignored.settlement).toBeUndefined();
  });
  it("opens a Stealth-only fallback route on its authorized mode", () => {
    const stealthOnly = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], ({ fromChainId, toChainId, from, to }) =>
        fromChainId === BASE && toChainId === ETHEREUM && from === "USDC" && to === "USDC"
          ? ["stealth"]
          : null,
      ),
      true,
    );

    expect(shape(resolve("", stealthOnly))).toMatchObject({
      fromChainId: BASE,
      toChainId: ETHEREUM,
      settlement: "stealth",
    });
  });

  it("keeps explicit Public selected even when only Stealth is authorized", () => {
    const stealthOnly = embedOffer(
      liveCapabilities(PAIRS, [ETHEREUM], ({ fromChainId, toChainId, from, to }) =>
        fromChainId === BASE && toChainId === ETHEREUM && from === "USDC" && to === "USDC"
          ? ["stealth"]
          : null,
      ),
      "live",
    );
    const resolved = explainEmbedDefaults(
      { toChainId: ETHEREUM, settlement: "public" },
      stealthOnly,
    );
    expect(shape(resolved.defaults)).toMatchObject({
      fromChainId: BASE,
      toChainId: ETHEREUM,
      settlement: "public",
    });
    expect(resolved.ignored.settlement).toBeUndefined();
    expect(resolve(embedSearch(resolved.defaults), stealthOnly)).toEqual(resolved.defaults);
  });

  it("authorizes Stealth only for live exact tokens and an advertised route", () => {
    const route = resolve("toChain=1");
    expect(stealthOffered(route, LIVE.capabilities, "live")).toBe(true);
    for (const state of ["stale", "fallback", "failed"] as const) {
      expect(stealthOffered(route, LIVE.capabilities, state)).toBe(false);
      expect(resolve("", embedOffer(LIVE.capabilities, state)).settlement).toBe("public");
    }
    for (const leg of ["fromToken", "toToken"] as const) {
      for (const token of [
        { ...route[leg], address: "0x0000000000000000000000000000000000000001" },
        { ...route[leg], decimals: route[leg].decimals + 1 },
      ]) {
        expect(stealthOffered({ ...route, [leg]: token }, LIVE.capabilities, "live")).toBe(false);
      }
    }
    const absentRoute = liveCapabilities(
      PAIRS,
      [ETHEREUM],
      ({ fromChainId, toChainId, from, to }) =>
        fromChainId === BASE && toChainId === ETHEREUM && from === "USDC" && to === "USDC"
          ? null
          : undefined,
    );
    expect(stealthOffered(route, absentRoute, "live")).toBe(false);
    expect(stealthOffered(route, FALLBACK_CAPABILITIES, "fallback")).toBe(false);
  });

  it("drops an amount it cannot honour", () => {
    // More decimals than USDC has.
    expect(resolve("amount=1.1234567").amount).toBe("");
    expect(resolve("amount=0.000").amount).toBe("");
    // Denominated in a sell token that was ignored.
    expect(resolve("sell=DOGE&amount=5").amount).toBe("");
    // Denominated in the default coin of a chain that was ignored.
    expect(resolve("fromChain=999&amount=5").amount).toBe("");
    expect(resolve("amount=12.5").amount).toBe("12.5");
  });
});

describe("embedOverrides + encodeEmbedParams", () => {
  it("reproduces every configuration it can write", () => {
    // Every honourable route on the live matrix, with and without an amount and
    // stealth: writing it and reading it back opens the same frame.
    let checked = 0;
    for (const fromChainId of LIVE.sourceChainIds) {
      for (const toChainId of LIVE.destinationChainIds) {
        for (const fromToken of legTokens(LIVE, fromChainId, "sell")) {
          for (const toToken of legTokens(LIVE, toChainId, "buy")) {
            if (!routeFills(LIVE, { fromChainId, toChainId, fromToken, toToken })) continue;
            for (const amount of ["", "7.25"]) {
              for (const settlement of ["public", "stealth"] as const) {
                if (
                  settlement === "stealth" &&
                  !stealthOffered(
                    { fromChainId, toChainId, fromToken, toToken },
                    LIVE.capabilities,
                    LIVE.routeModel.state,
                  )
                ) {
                  continue;
                }
                const look = checked % 2 === 0 ? {} : ({ theme: "light", layout: "swap" } as const);
                const config = {
                  ...FRAME_DEFAULTS,
                  ...look,
                  fromChainId,
                  toChainId,
                  fromToken,
                  toToken,
                  amount,
                  settlement,
                };
                const written = embedSearch(config);
                expect(resolve(written), written).toEqual(config);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("explainEmbedDefaults", () => {
  it("names a reason for exactly the requested values the frame does not open on", () => {
    const pick = <T>(values: T[]) => values;
    let checked = 0;
    for (const fromChainId of pick([undefined, ETHEREUM, BASE, 999]))
      for (const toChainId of pick([undefined, ETHEREUM, OPTIMISM, BASE]))
        for (const sellSymbol of pick([undefined, "usdt", "DOGE"]))
          for (const buySymbol of pick([undefined, "USDC", "USDT"]))
            for (const amount of pick([undefined, "250", "1.1234567"]))
              for (const settlement of pick([undefined, "stealth" as const])) {
                const params = {
                  fromChainId,
                  toChainId,
                  sellSymbol,
                  buySymbol,
                  amount,
                  settlement,
                };
                const { defaults, ignored } = explainEmbedDefaults(params, LIVE);
                // Every field the frame resolves, so a new one fails to compile until covered.
                const dropped: Record<FrameField, boolean> = {
                  fromChainId: fromChainId !== undefined && defaults.fromChainId !== fromChainId,
                  toChainId: toChainId !== undefined && defaults.toChainId !== toChainId,
                  sellSymbol:
                    sellSymbol !== undefined &&
                    defaults.fromToken.symbol !== sellSymbol.toUpperCase(),
                  buySymbol:
                    buySymbol !== undefined && defaults.toToken.symbol !== buySymbol.toUpperCase(),
                  amount: amount !== undefined && defaults.amount === "",
                  settlement: settlement !== undefined && defaults.settlement !== settlement,
                  // The look and layout are honoured whenever well-formed.
                  theme: false,
                  layout: false,
                  howItWorks: false,
                  height: false,
                  locks: false,
                  fromChains: false,
                  toChains: false,
                  sellTokens: false,
                  buyTokens: false,
                  // Codes are the server's to judge: always sent, never ignored.
                  ref: false,
                  promo: false,
                };
                for (const field of Object.keys(dropped) as (keyof typeof dropped)[]) {
                  expect(
                    ignored[field] !== undefined,
                    `${field} in ${JSON.stringify(params)}`,
                  ).toBe(dropped[field]);
                }
                checked++;
              }
    expect(checked).toBe(864);
  });
});

describe("referral and promo codes (xochi-widget#48)", () => {
  it("names what a typed code takes, and accepts none", () => {
    expect(codeProblem("")).toBeNull();
    expect(codeProblem("Launch10")).toBeNull();
    expect(codeProblem("a b")).toMatch(/^Use 3 to 32 letters, digits, _ or -/);
  });

  it("passes codes through unjudged and opens the frame exactly as without them", () => {
    const { defaults, ignored } = explainEmbedDefaults(
      parseEmbedParams("?ref=PARTNER&promo=LAUNCH10"),
      LIVE,
    );
    expect(ignored).toEqual({});
    expect(defaults).toEqual({
      ...resolveEmbedDefaults({}, LIVE),
      ref: "PARTNER",
      promo: "LAUNCH10",
    });
    expect(embedCodes(parseEmbedParams("?promo=x9z"))).toEqual({ ref: null, promo: "X9Z" });
  });

  it("writes both, and reads them back", () => {
    const config = {
      ...FRAME_DEFAULTS,
      theme: "light" as const,
      ref: "PARTNER",
      promo: "LAUNCH10",
    };
    const written = embedSearch(config);
    expect(resolve(written)).toEqual(config);
  });

  it("checks codes by @xochi/client's pattern, the one widget-lib parses with", () => {
    expect(EMBED_CODE_PATTERN.source).toBe(REFERRAL_CODE_REGEX.source);
    expect(EMBED_CODE_PATTERN.source).toBe(PROMO_CODE_REGEX.source);
  });
});
