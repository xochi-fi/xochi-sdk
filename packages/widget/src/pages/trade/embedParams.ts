/**
 * Frame URL parameters: the defaults a host sets on `/embed` (xochi-widget#21).
 *
 * The configurator at `/` writes them (`embedOverrides` + `encodeEmbedParams`),
 * the frame reads them once at load: the route, amount and settlement through
 * `parseEmbedParams` + `resolveEmbedDefaults` (wired in useSwapPanel), the look
 * through `embedLook` (wired in EmbedApp; the entry script applies a fixed
 * theme even earlier, from embedTheme.ts). The host can then override only the
 * theme with `XochiWidget.updateTheme`, without reloading or resetting the
 * route, form or wallet. Every key, its syntax and encoding live in
 * `@xochi/widget-lib`; capability resolution stays here.
 *
 *   fromChain   origin chain, decimal chain id           fromChain=1
 *   toChain     destination chain, decimal chain id      toChain=1
 *   sell        token sent, symbol (any case)            sell=USDT
 *   buy         token received, symbol (any case)        buy=USDC
 *   amount      amount sent, a plain decimal in `sell`   amount=250
 *   settlement  `public` or `stealth`                    settlement=stealth
 *   theme       `light`, `dim`, `contrast` or `auto`     theme=light
 *   layout      `full` or `swap` (no Activity, Claims)   layout=swap
 *   howItWorks  `0` hides the How it works disclosure    howItWorks=0
 *   height      fixed frame height in px, 480 to 1600    height=640
 *   lock        fields the user cannot change            lock=sell,buy,amount
 *   fromChains  chains the user may send from            fromChains=8453,10
 *   toChains    chains the user may receive on           toChains=1
 *   sellTokens  tokens the user may send                 sellTokens=USDC,USDT
 *   buyTokens   tokens the user may receive              buyTokens=USDC
 *   ref         referral code (xochi#583)                ref=PARTNER
 *   promo       promo code (xochi#584)                   promo=LAUNCH10
 *
 * The route, amount and settlement are DEFAULTS: the user can change every one
 * of them in the frame, unless `lock` names it (`fromChain`, `toChain`, `sell`,
 * `buy`, `amount`), and only within the allow-lists. Each is checked against
 * what the frame can honour right now, and anything it cannot is ignored in
 * favour of today's default, silently:
 *
 *   - a chain the frame does not offer in that direction (unknown, not
 *     renderable, or not served by the solver's capability matrix);
 *   - a token that is not on that chain, or that the solver does not take
 *     (`sell`) or deliver (`buy`) there;
 *   - a pair the solver cannot fill: unless Stealth was explicitly requested,
 *     the two tokens fall back to the chains' default coins, then the default
 *     route. Explicit Stealth keeps known, host-permitted deployments and amounts
 *     for display even if inventory is empty; only live exact routes authorize execution;
 *   - an amount that is not a plain positive decimal, has more decimals than
 *     the sell token, or belongs to a `sell` token that was itself ignored;
 *   - settlement is Stealth on supported routes unless explicitly Public.
 *     An explicit Stealth preference stays selected when blocked.
 *
 * The theme is the frame's look (src/styles/themes.css): `contrast` is the
 * high-contrast theme, and `auto`, the default, follows the OS as the frame
 * always has. The layout removes parts of the frame: `swap` drops the tab row
 * (the account chip stays), `howItWorks=0` drops the disclosure under the
 * card, and `height` lays the frame out at that height, scrolling inside it,
 * for a host iframe of the same height. Every well-formed look and layout is
 * honoured; any other value is ignored.
 *
 * Locks and allow-lists (xochi-widget#39) are client-side conveniences, not
 * policy: a user who edits the URL or calls the API is not bound by them
 * (publishable keys, xochi-fi/xochi#579, will carry them server-side). Each
 * allow-list is intersected with what the frame offers on its leg; one that
 * keeps nothing is ignored, and if together they leave no route the solver
 * fills, all of them are ignored and the frame opens as if they were absent.
 * A lock fixes the value the frame opens on, so locking an ignored value
 * locks the default. Locking the amount locks the send token and chain too
 * (the amount is denominated in them), and needs an amount to lock.
 *
 * With no route preset, prefer an executable trusted Stealth route when served.
 *
 * A cross-coin pair can only be confirmed by the LIVE matrix: the fallback
 * served while it loads (or after it fails) lists no conversion pairs, and its
 * silence is not the solver's verdict. Off the live matrix such a pair is kept,
 * exactly as if the user had picked it, and the frame's own route check says
 * it is still being checked.
 *
 * `ref` and `promo` are not defaults the user sees: the frame sends them on
 * every quote (`@xochi/client` 0.1.8's `QuoteRequest.ref` / `.promo`) and the
 * Worker decides. Each is 3 to 32 of `A-Z 0-9 _ -`, starting with a letter or
 * digit, read in any case and sent uppercase; one of any other shape is
 * ignored silently. A well-formed code the Worker cannot use never blocks a
 * quote: it prices as if absent and carries a note, which the configurator
 * shows and the frame does not.
 */

import {
  CANTON_MAINNET_CHAIN_ID,
  isCantonDestinationChainId,
  isSelectableChainId,
  EXTENDED_CHAIN_NAMES,
  originTokenSymbols,
  destinationTokenSymbols,
  resolveRouteModel,
  stealthDestinationChains,
  type CapabilityState,
  type ResolvedRouteModel,
  type SelectableChainId,
} from "@xochi/client";
import type { SolverCapabilities as WidgetCapabilities } from "@xochi/signer";
import {
  EMBED_ALLOW_FIELDS,
  EMBED_HEIGHT,
  EMBED_LOCKS,
  EMBED_PATH,
  encodeEmbedParams,
  normalizeEmbedCode,
  parseEmbedHeight,
  type EMBED_PARAM,
  type EmbedAllowField,
  type EmbedLayout,
  type EmbedLock,
  type EmbedParams,
  type EmbedSettlement,
  type EmbedTheme,
} from "@xochi/widget-lib";
import type { Token } from "../../types/intent.js";
import {
  TOKENS,
  DEFAULT_CHAIN_ID,
  DEFAULT_TO_CHAIN_ID,
  DEFAULT_FROM_TOKEN,
  DEFAULT_TO_TOKEN,
  STEALTH_SETTLEMENT_LIVE,
  chainEnabledForRole,
} from "./config.js";
import { pickDefaultToken } from "./useSwapRoute.js";

/**
 * The `EMBED_PARAM` fields this frame resolves (`explainEmbedDefaults`), and
 * so the ones the configurator reads, writes and explains. `@xochi/widget-lib`
 * defines more (look, locks, lists, codes); the frame ignores those until it
 * resolves them, as it ignores any key it does not read.
 */
export const FRAME_FIELDS = [
  "fromChainId",
  "toChainId",
  "sellSymbol",
  "buySymbol",
  "amount",
  "settlement",
  "theme",
  "layout",
  "howItWorks",
  "height",
  "locks",
  "fromChains",
  "toChains",
  "sellTokens",
  "buyTokens",
  "ref",
  "promo",
] as const satisfies readonly (keyof typeof EMBED_PARAM)[];
export type FrameField = (typeof FRAME_FIELDS)[number];

/** The parameters this frame resolves. */
export type FrameParams = Pick<EmbedParams, FrameField>;

/** What a referral or promo code takes, for messages (`EMBED_CODE_PATTERN`). */
const CODE_TAKES = "3 to 32 letters, digits, _ or -, starting with a letter or digit";

/** Why typed `text` cannot be a code, or null when it can (or is empty, no code). */
export function codeProblem(text: string): string | null {
  return text.trim() === "" || normalizeEmbedCode(text) !== null ? null : `Use ${CODE_TAKES}.`;
}

/**
 * What each parameter takes, for messages: `takes` ends a sentence, and
 * `example` is a whole `key=value` that the frame honours when typed on its own
 * against the default route (tested), so following the advice never fails.
 */
export const EMBED_PARAM_HINT: Record<FrameField, { takes: string; example: string }> = {
  fromChainId: { takes: "a chain id", example: "fromChain=8453" },
  toChainId: { takes: "a chain id", example: "toChain=1" },
  sellSymbol: { takes: "a token symbol", example: "sell=USDC" },
  buySymbol: { takes: "a token symbol", example: "buy=USDC" },
  amount: { takes: "a plain number", example: "amount=250" },
  settlement: { takes: "public or stealth", example: "settlement=public" },
  theme: { takes: "light, dim, contrast or auto", example: "theme=light" },
  layout: { takes: "full or swap", example: "layout=swap" },
  howItWorks: { takes: "0 or 1", example: "howItWorks=0" },
  height: {
    takes: `a whole number of pixels from ${EMBED_HEIGHT.min} to ${EMBED_HEIGHT.max}`,
    example: "height=640",
  },
  locks: { takes: `a comma list of ${EMBED_LOCKS.join(", ")}`, example: "lock=sell" },
  fromChains: { takes: "a comma list of chain ids", example: "fromChains=8453" },
  toChains: { takes: "a comma list of chain ids", example: "toChains=42161" },
  sellTokens: { takes: "a comma list of token symbols", example: "sellTokens=USDC" },
  buyTokens: { takes: "a comma list of token symbols", example: "buyTokens=USDC" },
  ref: { takes: CODE_TAKES, example: "ref=PARTNER" },
  promo: { takes: CODE_TAKES, example: "promo=LAUNCH10" },
};

/** What the frame opens on: every field resolved, nothing left to check. */
export interface EmbedDefaults {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
  /** The pay amount as typed into the panel; "" for none. */
  amount: string;
  settlement: EmbedSettlement;
  theme: EmbedTheme;
  layout: EmbedLayout;
  /** Whether the How it works disclosure shows under the card. */
  howItWorks: boolean;
  /** A fixed frame height in px that scrolls inside, or null to grow as today. */
  height: number | null;
  /** The fields the user cannot change, in EMBED_LOCKS order. */
  locks: readonly EmbedLock[];
  /** The chains each leg may use, in offer order; null for any the frame offers. */
  fromChains: readonly SelectableChainId[] | null;
  toChains: readonly SelectableChainId[] | null;
  /** The token symbols each leg may use, as the registry spells them; null for any. */
  sellTokens: readonly string[] | null;
  buyTokens: readonly string[] | null;
  /** The referral and promo codes sent on every quote, uppercase; null for none. */
  ref: string | null;
  promo: string | null;
}

/** Static fallback while capabilities load; unconfigured openings may prefer Stealth. */
export const FRAME_DEFAULTS: EmbedDefaults = {
  fromChainId: DEFAULT_CHAIN_ID,
  toChainId: DEFAULT_TO_CHAIN_ID,
  fromToken: DEFAULT_FROM_TOKEN,
  toToken: DEFAULT_TO_TOKEN,
  amount: "",
  settlement: "public",
  theme: "auto",
  layout: "full",
  howItWorks: true,
  height: null,
  locks: [],
  fromChains: null,
  toChains: null,
  sellTokens: null,
  buyTokens: null,
  ref: null,
  promo: null,
};

/** The amount syntax `parseEmbedParams` accepts, split into whole and fraction. */
const AMOUNT = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/**
 * Why a typed `text` cannot be the frame height, or null when it can (or is
 * empty, the standard frame). Surrounding space is ignored, as when typed.
 */
export function heightProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || parseEmbedHeight(trimmed) !== undefined) return null;
  return `Use ${EMBED_PARAM_HINT.height.takes}.`;
}

/** The frame's look and layout: the options no matrix can refuse. */
export type EmbedLook = Pick<EmbedDefaults, "theme" | "layout" | "howItWorks" | "height">;

/**
 * The look and layout the frame opens on. Every well-formed value is honoured,
 * so this needs no capability matrix and the frame applies it before one loads.
 */
export function embedLook(params: EmbedParams): EmbedLook {
  return {
    theme: params.theme ?? FRAME_DEFAULTS.theme,
    layout: params.layout ?? FRAME_DEFAULTS.layout,
    howItWorks: params.howItWorks ?? FRAME_DEFAULTS.howItWorks,
    height: params.height ?? FRAME_DEFAULTS.height,
  };
}

/** The codes the frame sends on quote: no matrix can refuse them either. */
export type EmbedCodes = Pick<EmbedDefaults, "ref" | "promo">;

export function embedCodes(params: EmbedParams): EmbedCodes {
  return { ref: params.ref ?? null, promo: params.promo ?? null };
}

/** The look of a frame URL with no layout parameters: the full widget. */
export const FULL_LOOK: EmbedLook = embedLook({});

/**
 * Why `amount` cannot be the pay amount in `token`, or null when it can.
 * The frame drops a refused amount; the configurator shows the reason.
 */
export function amountProblem(amount: string, token: Token): string | null {
  const match = AMOUNT.exec(amount);
  if (!match) return "Use a plain number, like 250 or 0.5.";
  const fraction = match[2] ?? "";
  if (fraction.length > token.decimals) {
    return `${token.symbol} takes at most ${token.decimals} decimals.`;
  }
  if (!/[1-9]/.test(amount)) return "Use an amount above zero.";
  return null;
}

/** Everything the resolver reads from the solver's capability matrix. */
export interface EmbedOffer {
  sourceChainIds: readonly SelectableChainId[];
  destinationChainIds: readonly SelectableChainId[];
  originSymbols: readonly string[];
  destinationSymbols: readonly string[];
  capabilities: WidgetCapabilities;
  /** The matrix is the solver's live answer, not the fallback. */
  live: boolean;
  /**
   * Narrowed by a host's allow-lists (`restrictOffer`): the frame's own
   * defaults then hold only where the lists allow them.
   */
  restricted?: boolean;
  routeModel: ResolvedRouteModel;
}

/**
 * The frame's offer under a capability matrix: the same chain lists the
 * selectors render and the same token lists their menus narrow to.
 */
export function embedOffer(
  capabilities: WidgetCapabilities,
  state: CapabilityState | boolean,
): EmbedOffer {
  const capabilityState: CapabilityState =
    typeof state === "boolean" ? (state ? "live" : "fallback") : state;
  const routeModel = resolveRouteModel(capabilities, capabilityState, {
    chainEnabledForRole,
    presentationTokens: TOKENS,
  });
  return {
    sourceChainIds: routeModel.originChainIds,
    destinationChainIds: routeModel.destinationChainIds,
    originSymbols: originTokenSymbols(capabilities),
    destinationSymbols: destinationTokenSymbols(capabilities),
    capabilities,
    live: capabilityState === "live",
    restricted: capabilities.raw.restricted === true,
    routeModel,
  };
}

/**
 * Catalog continuity for explicit Stealth display, never route authorization.
 * Canton settles public only, so it is never part of a Stealth catalog.
 */
function stealthDisplayOffer(full: EmbedOffer): EmbedOffer {
  const inventory = (role: "origin" | "destination") => {
    const advertised =
      role === "origin" ? full.routeModel.originTokens : full.routeModel.destinationTokens;
    const tokensByChain = new Map(advertised);
    tokensByChain.delete(CANTON_MAINNET_CHAIN_ID);
    for (const tokens of Object.values(TOKENS)) {
      const chainId = tokens[0]?.chainId;
      if (
        chainId === undefined ||
        !isSelectableChainId(chainId) ||
        isCantonDestinationChainId(chainId) ||
        !chainEnabledForRole(chainId, role)
      )
        continue;
      const live = advertised.get(chainId) ?? [];
      tokensByChain.set(chainId, [
        ...live,
        ...tokens.filter((token) => !live.some((candidate) => candidate.symbol === token.symbol)),
      ]);
    }
    return tokensByChain;
  };
  const originTokens = inventory("origin");
  const destinationTokens = inventory("destination");
  return {
    ...full,
    sourceChainIds: [...originTokens.keys()],
    destinationChainIds: [...destinationTokens.keys()],
    originSymbols: [],
    destinationSymbols: [],
    // resolve retains the exact original capability closure.
    routeModel: { ...full.routeModel, originTokens, destinationTokens },
  };
}
export function legTokens(
  offer: EmbedOffer,
  chainId: number,
  leg: "sell" | "buy",
): readonly Token[] {
  const tokensByChain =
    leg === "sell" ? offer.routeModel.originTokens : offer.routeModel.destinationTokens;
  const symbols = leg === "sell" ? offer.originSymbols : offer.destinationSymbols;
  return (tokensByChain.get(chainId as SelectableChainId) ?? []).filter(
    (token) => symbols.length === 0 || symbols.includes(token.symbol),
  );
}

/**
 * The token a leg holds when none was asked for: the frame's own default on
 * the default chain, otherwise what a chain switch in the panel picks.
 */
function defaultToken(offer: EmbedOffer, chainId: SelectableChainId, leg: "sell" | "buy"): Token {
  const frameDefault = leg === "sell" ? FRAME_DEFAULTS.fromToken : FRAME_DEFAULTS.toToken;
  const symbols = leg === "sell" ? offer.originSymbols : offer.destinationSymbols;
  const tokens = legTokens(offer, chainId, leg);
  if (chainId === frameDefault.chainId) {
    const preferred = tokens.find((token) => token.symbol === frameDefault.symbol);
    if (preferred) return preferred;
  }
  return pickDefaultToken(tokens, symbols);
}

/** The requested token on a leg, or null when the frame cannot offer it there. */
function requestedToken(
  offer: EmbedOffer,
  chainId: SelectableChainId,
  leg: "sell" | "buy",
  symbol: string | undefined,
): Token | null {
  if (symbol === undefined) return null;
  const wanted = symbol.toLowerCase();
  return legTokens(offer, chainId, leg).find((t) => t.symbol.toLowerCase() === wanted) ?? null;
}

interface Route {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
}

/**
 * The exact selected route under the typed capability inventory. Only an
 * available live resolution may authorize a privacy mode; unknown route data
 * remains useful for display continuity but cannot grant one.
 */
function routeAvailability(offer: EmbedOffer, route: Route) {
  return offer.routeModel.resolve(
    { chainId: route.fromChainId, token: route.fromToken },
    { kind: "chain", chainId: route.toChainId, token: route.toToken },
  );
}

export function routeFills(offer: EmbedOffer, route: Route): boolean {
  return routeAvailability(offer, route).status !== "unavailable";
}
function routeSupportsEmbedSettlement(offer: EmbedOffer, route: Route): boolean {
  const availability = routeAvailability(offer, route);
  if (availability.status === "unknown") return true;
  if (availability.status === "unavailable") return false;
  return (
    availability.privacyModes.includes("public") ||
    (STEALTH_SETTLEMENT_LIVE && availability.privacyModes.includes("stealth"))
  );
}

/** Only an exact trusted live route may offer Stealth. */
export function stealthOffered(
  route: Route,
  capabilities: WidgetCapabilities,
  capabilityState: CapabilityState,
): boolean {
  if (!STEALTH_SETTLEMENT_LIVE) return false;
  const availability = resolveRouteModel(capabilities, capabilityState, {
    chainEnabledForRole,
    presentationTokens: TOKENS,
  }).resolve(
    { chainId: route.fromChainId, token: route.fromToken },
    { kind: "chain", chainId: route.toChainId, token: route.toToken },
  );
  return availability.status === "available" && availability.privacyModes.includes("stealth");
}

/** Why the frame ignores each requested value it does not open on. */
export type EmbedIgnored = Partial<Record<keyof EmbedParams, string>>;

const CHAIN_NAMES: Readonly<Record<number, string | undefined>> = EXTENDED_CHAIN_NAMES;
/** The token registry by plain chain id, for lookups on any chain id a list holds. */
const CHAIN_TOKENS: Readonly<Record<number, readonly Token[] | undefined>> = TOKENS;
/** A chain's display name, or "chain <id>" for one the registry does not name. */
export const chainName = (id: number): string => CHAIN_NAMES[id] ?? `chain ${id}`;

/** The allow-lists, as parameters ask for them or as the frame honours them. */
export type EmbedAllowLists = Pick<EmbedParams, EmbedAllowField>;

/** The distinct symbols a leg offers on any of `chainIds`, in registry order. */
export function legSymbols(
  offer: EmbedOffer,
  chainIds: readonly SelectableChainId[],
  leg: "sell" | "buy",
): string[] {
  return [...new Set(chainIds.flatMap((id) => legTokens(offer, id, leg).map((t) => t.symbol)))];
}

/**
 * The offer narrowed to a host's allow-lists (xochi-widget#39). Each list is
 * intersected with what its leg offers; a list that keeps nothing is ignored
 * (and named in `ignored`). A chain left with no allowed token on its leg is
 * dropped from the leg. `lists` is what the frame honours, null per absent or
 * ignored list. The offer is `restricted` when any list applies.
 */
export function restrictOffer(
  offer: EmbedOffer,
  asked: EmbedAllowLists,
): { offer: EmbedOffer; lists: Pick<EmbedDefaults, EmbedAllowField>; ignored: EmbedIgnored } {
  const ignored: EmbedIgnored = {};
  const keepChains = (
    offered: readonly SelectableChainId[],
    wanted: readonly number[] | undefined,
    field: "fromChains" | "toChains",
  ): SelectableChainId[] | null => {
    if (wanted === undefined || wanted.length === 0) return null;
    const kept = wanted.flatMap((id) => offered.find((offeredId) => offeredId === id) ?? []);
    if (kept.length > 0) return kept;
    ignored[field] =
      `the widget ${field === "fromChains" ? "sends from" : "delivers to"} none of ${wanted.map(chainName).join(", ")}`;
    return null;
  };
  const keepSymbols = (
    leg: "sell" | "buy",
    wanted: readonly string[] | undefined,
    field: "sellTokens" | "buyTokens",
  ): string[] | null => {
    if (wanted === undefined || wanted.length === 0) return null;
    const upper = wanted.map((s) => s.toUpperCase());
    const chains = leg === "sell" ? offer.sourceChainIds : offer.destinationChainIds;
    const kept = legSymbols(offer, chains, leg).filter((s) => upper.includes(s.toUpperCase()));
    if (kept.length > 0) return kept;
    ignored[field] =
      `the widget ${leg === "sell" ? "takes" : "delivers"} none of ${upper.join(", ")}`;
    return null;
  };
  const fromKept = keepChains(offer.sourceChainIds, asked.fromChains, "fromChains");
  const toKept = keepChains(offer.destinationChainIds, asked.toChains, "toChains");
  const sellKept = keepSymbols("sell", asked.sellTokens, "sellTokens");
  const buyKept = keepSymbols("buy", asked.buyTokens, "buyTokens");
  if (fromKept === null && toKept === null && sellKept === null && buyKept === null) {
    return {
      offer,
      lists: { fromChains: null, toChains: null, sellTokens: null, buyTokens: null },
      ignored,
    };
  }
  const symbolsOnly: EmbedOffer = {
    ...offer,
    originSymbols: sellKept ?? offer.originSymbols,
    destinationSymbols: buyKept ?? offer.destinationSymbols,
    restricted: true,
  };
  const narrowed: EmbedOffer = {
    ...symbolsOnly,
    sourceChainIds: (fromKept ?? offer.sourceChainIds).filter(
      (id) => legTokens(symbolsOnly, id, "sell").length > 0,
    ),
    destinationChainIds: (toKept ?? offer.destinationChainIds).filter(
      (id) => legTokens(symbolsOnly, id, "buy").length > 0,
    ),
  };
  return {
    offer: narrowed,
    lists: {
      fromChains: fromKept === null ? null : narrowed.sourceChainIds,
      toChains: toKept === null ? null : narrowed.destinationChainIds,
      sellTokens: sellKept,
      buyTokens: buyKept,
    },
    ignored,
  };
}

/**
 * The route a restricted offer falls back to: the frame's default route if
 * the lists allow it and it fills, else the first that fills, in offer order.
 * Null when no route fills at all.
 */
function firstRoute(offer: EmbedOffer): Route | null {
  const allowed = (route: Route): boolean =>
    offer.sourceChainIds.includes(route.fromChainId) &&
    offer.destinationChainIds.includes(route.toChainId) &&
    legTokens(offer, route.fromChainId, "sell").includes(route.fromToken) &&
    legTokens(offer, route.toChainId, "buy").includes(route.toToken);
  if (
    allowed(FRAME_DEFAULTS) &&
    routeFills(offer, FRAME_DEFAULTS) &&
    routeSupportsEmbedSettlement(offer, FRAME_DEFAULTS)
  ) {
    return FRAME_DEFAULTS;
  }
  for (const fromChainId of offer.sourceChainIds) {
    for (const toChainId of offer.destinationChainIds) {
      for (const fromToken of legTokens(offer, fromChainId, "sell")) {
        for (const toToken of legTokens(offer, toChainId, "buy")) {
          const route = { fromChainId, toChainId, fromToken, toToken };
          if (routeFills(offer, route) && routeSupportsEmbedSettlement(offer, route)) return route;
        }
      }
    }
  }
  return null;
}

/** Prefer the incumbent origin and a same-coin executable trusted Stealth route. */
function firstStealthRoute(offer: EmbedOffer): Route | null {
  if (!STEALTH_SETTLEMENT_LIVE || !offer.live) return null;
  const sourceChains = [
    ...offer.sourceChainIds.filter((chainId) => chainId === DEFAULT_CHAIN_ID),
    ...offer.sourceChainIds.filter((chainId) => chainId !== DEFAULT_CHAIN_ID),
  ];
  for (const fromChainId of sourceChains) {
    const preferredFrom = defaultToken(offer, fromChainId, "sell");
    const fromTokens = [
      preferredFrom,
      ...legTokens(offer, fromChainId, "sell").filter((token) => token !== preferredFrom),
    ];
    for (const fromToken of fromTokens) {
      let firstEligible: Route | null = null;
      for (const toChainId of stealthDestinationChains(offer.capabilities)) {
        if (!offer.destinationChainIds.includes(toChainId)) continue;
        const preferredTo = defaultToken(offer, toChainId, "buy");
        const toTokens = [
          preferredTo,
          ...legTokens(offer, toChainId, "buy").filter((token) => token !== preferredTo),
        ];
        for (const toToken of toTokens) {
          const route = { fromChainId, toChainId, fromToken, toToken };
          const availability = routeAvailability(offer, route);
          if (availability.status !== "available" || !availability.privacyModes.includes("stealth"))
            continue;
          if (toToken.symbol === fromToken.symbol) return route;
          firstEligible ??= route;
        }
      }
      if (firstEligible) return firstEligible;
    }
  }
  return null;
}

/**
 * Turn requested parameters into what the frame opens on, keeping each value
 * only if the frame can honour it (rules in the module comment).
 */
export function resolveEmbedDefaults(params: EmbedParams, offer: EmbedOffer): EmbedDefaults {
  return explainEmbedDefaults(params, offer).defaults;
}

/**
 * `resolveEmbedDefaults`, plus the reason for every requested value the frame
 * ignores: the frame drops them silently, the configurator names them. Each
 * reason is a clause with no closing full stop.
 */
export function explainEmbedDefaults(
  params: EmbedParams,
  full: EmbedOffer,
): { defaults: EmbedDefaults; ignored: EmbedIgnored } {
  // Public retains incumbent allow-list fallback. Explicit Stealth keeps
  // host-permitted display selections even when no advertised route remains.
  const explicitStealth = params.settlement === "stealth";
  const restriction = restrictOffer(explicitStealth ? stealthDisplayOffer(full) : full, params);
  const ignored: EmbedIgnored = { ...restriction.ignored };
  let offer = restriction.offer;
  let lists = restriction.lists;
  let first = firstRoute(offer);
  if (!explicitStealth && offer.restricted && first === null) {
    for (const field of EMBED_ALLOW_FIELDS) {
      if (lists[field] !== null) {
        ignored[field] = "the allow-lists together leave no route the solver fills";
      }
    }
    offer = full;
    lists = restrictOffer(full, {}).lists;
    first = firstRoute(offer);
  }

  // A live empty typed inventory has no route from which to derive token
  // defaults. Keep the established defaults as display-only state; exact route
  // authorization downstream still refuses them.
  if (
    first === null &&
    (!explicitStealth ||
      offer.sourceChainIds.length === 0 ||
      offer.destinationChainIds.length === 0)
  ) {
    const reason = "the solver advertises no route the widget can use";
    for (const field of [
      "fromChainId",
      "toChainId",
      "sellSymbol",
      "buySymbol",
      "amount",
    ] as const) {
      if (params[field] !== undefined) ignored[field] = reason;
    }
    if ((params.locks?.length ?? 0) > 0) ignored.locks = reason;
    return {
      defaults: {
        ...FRAME_DEFAULTS,
        settlement: params.settlement ?? FRAME_DEFAULTS.settlement,
        ...embedLook(params),
        ...lists,
        ...embedCodes(params),
      },
      ignored,
    };
  }
  const fallback = first ?? {
    fromChainId: offer.sourceChainIds[0],
    toChainId: offer.destinationChainIds[0],
    fromToken: defaultToken(offer, offer.sourceChainIds[0], "sell"),
    toToken: defaultToken(offer, offer.destinationChainIds[0], "buy"),
  };

  // The chain a leg holds when none (or none it can use) was asked for.
  const homeFrom = offer.sourceChainIds.includes(FRAME_DEFAULTS.fromChainId)
    ? FRAME_DEFAULTS.fromChainId
    : fallback.fromChainId;
  const homeTo = offer.destinationChainIds.includes(FRAME_DEFAULTS.toChainId)
    ? FRAME_DEFAULTS.toChainId
    : fallback.toChainId;
  const fromChainId = offer.sourceChainIds.find((id) => id === params.fromChainId) ?? homeFrom;
  const toChainId = offer.destinationChainIds.find((id) => id === params.toChainId) ?? homeTo;

  const askedSell = requestedToken(offer, fromChainId, "sell", params.sellSymbol);
  const askedBuy = requestedToken(offer, toChainId, "buy", params.buySymbol);
  const chainDefaults: Route = {
    fromChainId,
    toChainId,
    fromToken: defaultToken(offer, fromChainId, "sell"),
    toToken: defaultToken(offer, toChainId, "buy"),
  };
  const asked: Route = {
    ...chainDefaults,
    fromToken: askedSell ?? chainDefaults.fromToken,
    toToken: askedBuy ?? chainDefaults.toToken,
  };
  const routeConfigured =
    params.fromChainId !== undefined ||
    params.toChainId !== undefined ||
    params.sellSymbol !== undefined ||
    params.buySymbol !== undefined ||
    params.amount !== undefined ||
    (params.locks?.length ?? 0) > 0 ||
    EMBED_ALLOW_FIELDS.some((field) => params[field] !== undefined);
  // Explicit Stealth presets stay visible even when the exact pair is blocked;
  // destination discovery, not hydration, owns any subsequent financial change.
  const route =
    params.settlement === "stealth" && routeConfigured
      ? asked
      : ((!routeConfigured && params.settlement !== "public" ? firstStealthRoute(offer) : null) ??
        [asked, chainDefaults].find(
          (candidate) =>
            routeFills(offer, candidate) && routeSupportsEmbedSettlement(offer, candidate),
        ) ??
        fallback);

  // The amount is denominated in the sell token the URL meant: the one it
  // named, else the default coin of the chain it named. If the frame does not
  // open on that token, the number means something else here, so it goes too.
  const meantSell =
    params.sellSymbol !== undefined
      ? askedSell
      : fromChainId === (params.fromChainId ?? homeFrom)
        ? chainDefaults.fromToken
        : null;
  const amount =
    params.amount !== undefined &&
    meantSell !== null &&
    route.fromToken === meantSell &&
    amountProblem(params.amount, route.fromToken) === null
      ? params.amount.replace(/^0+(?=\d)/, "")
      : "";

  const selectedAvailability = routeAvailability(offer, route);
  const selectedPrivacyModes =
    selectedAvailability.status === "available" ? selectedAvailability.privacyModes : [];
  const stealthAvailable = STEALTH_SETTLEMENT_LIVE && selectedPrivacyModes.includes("stealth");
  const settlement: EmbedSettlement =
    params.settlement ?? (stealthAvailable ? "stealth" : "public");

  // A lock holds whatever the frame opens on. The amount is denominated in the
  // send token on the send chain, so locking it locks those two as well, and
  // with no amount to open on there is nothing to lock.
  const lockAsks = params.locks ?? [];
  const amountLocked = lockAsks.includes("amount") && amount !== "";
  const locks = EMBED_LOCKS.filter((lock) =>
    lock === "amount"
      ? amountLocked
      : lockAsks.includes(lock) || (amountLocked && (lock === "fromChain" || lock === "sell")),
  );
  if (lockAsks.includes("amount") && !amountLocked) {
    ignored.locks = "the amount can only be locked with an amount the widget opens on";
  }

  const fromName = chainName(fromChainId);
  const toName = chainName(toChainId);
  const listed = "it is outside the allow-lists";
  const noRoute = `no route the solver fills goes from ${asked.fromToken?.symbol ?? params.sellSymbol?.toUpperCase() ?? "a supported token"} on ${fromName} to ${asked.toToken?.symbol ?? params.buySymbol?.toUpperCase() ?? "a supported token"} on ${toName}`;
  if (params.fromChainId !== undefined && route.fromChainId !== params.fromChainId) {
    ignored.fromChainId =
      fromChainId === params.fromChainId
        ? noRoute
        : full.sourceChainIds.some((id) => id === params.fromChainId)
          ? listed
          : `the widget doesn't send from ${chainName(params.fromChainId)}`;
  }
  if (params.toChainId !== undefined && route.toChainId !== params.toChainId) {
    ignored.toChainId =
      toChainId === params.toChainId
        ? noRoute
        : full.destinationChainIds.some((id) => id === params.toChainId)
          ? listed
          : `the widget doesn't deliver to ${chainName(params.toChainId)}`;
  }
  const sameSymbol = (token: Token, symbol: string): boolean =>
    token.symbol.toLowerCase() === symbol.toLowerCase();
  if (params.sellSymbol !== undefined && !sameSymbol(route.fromToken, params.sellSymbol)) {
    ignored.sellSymbol =
      askedSell !== null
        ? noRoute
        : requestedToken(full, fromChainId, "sell", params.sellSymbol) !== null
          ? listed
          : `${params.sellSymbol.toUpperCase()} can't be sent on ${fromName}`;
  }
  if (params.buySymbol !== undefined && !sameSymbol(route.toToken, params.buySymbol)) {
    ignored.buySymbol =
      askedBuy !== null
        ? noRoute
        : requestedToken(full, toChainId, "buy", params.buySymbol) !== null
          ? listed
          : `${params.buySymbol.toUpperCase()} can't be received on ${toName}`;
  }
  if (params.amount !== undefined && amount === "") {
    ignored.amount =
      meantSell !== null && route.fromToken === meantSell
        ? (amountProblem(params.amount, route.fromToken) ?? "").replace(/\.$/, "")
        : "it is in a sell token the widget doesn't open on";
  }

  return {
    defaults: {
      fromChainId: route.fromChainId,
      toChainId: route.toChainId,
      fromToken: route.fromToken,
      toToken: route.toToken,
      amount,
      settlement,
      ...embedLook(params),
      locks,
      ...lists,
      ...embedCodes(params),
    },
    ignored,
  };
}

/**
 * The fields that decide the swap panel's opening state, as the panel holds
 * them. The look (`EmbedLook`) is not panel state, so it is not here.
 */
export interface EmbedState {
  fromChainId: number;
  toChainId: number;
  fromToken: { address: string };
  toToken: { address: string };
  amount: string;
  settlement: string;
}

/** Whether two configurations open the swap panel identically (the look aside). */
export function sameEmbedDefaults(a: EmbedState, b: EmbedState): boolean {
  return (
    a.fromChainId === b.fromChainId &&
    a.toChainId === b.toChainId &&
    a.fromToken.address === b.fromToken.address &&
    a.toToken.address === b.toToken.address &&
    a.amount === b.amount &&
    a.settlement === b.settlement
  );
}

/**
 * The parameters that reopen this route and mode explicitly. Capability-dependent
 * defaults must not replace a host's Public choice or selected destination.
 */
export function embedOverrides(defaults: EmbedDefaults): EmbedParams {
  const params: EmbedParams = {};
  if (defaults.fromChainId !== FRAME_DEFAULTS.fromChainId)
    params.fromChainId = defaults.fromChainId;
  params.toChainId = defaults.toChainId;
  if (defaults.fromToken.symbol !== FRAME_DEFAULTS.fromToken.symbol) {
    params.sellSymbol = defaults.fromToken.symbol;
  }
  if (defaults.toToken.symbol !== FRAME_DEFAULTS.toToken.symbol) {
    params.buySymbol = defaults.toToken.symbol;
  }
  if (defaults.amount !== "") params.amount = defaults.amount;
  // Public is explicit too: omitting it enables capability-dependent Stealth defaults.
  params.settlement = defaults.settlement;
  if (defaults.theme !== FRAME_DEFAULTS.theme) params.theme = defaults.theme;
  if (defaults.layout !== FRAME_DEFAULTS.layout) params.layout = defaults.layout;
  if (!defaults.howItWorks) params.howItWorks = false;
  if (defaults.height !== null) params.height = defaults.height;
  // The amount lock takes the send token and chain with it, and parsing
  // re-derives them (explainEmbedDefaults), so they are left out beside it: a
  // shared configurator link then reopens with them held by the amount lock,
  // as set, rather than as two locks of their own.
  const locks = defaults.locks.includes("amount")
    ? defaults.locks.filter((lock) => lock !== "fromChain" && lock !== "sell")
    : defaults.locks;
  if (locks.length > 0) params.locks = locks;
  if (defaults.fromChains !== null) params.fromChains = defaults.fromChains;
  if (defaults.toChains !== null) params.toChains = defaults.toChains;
  if (defaults.sellTokens !== null) params.sellTokens = defaults.sellTokens;
  if (defaults.buyTokens !== null) params.buyTokens = defaults.buyTokens;
  if (defaults.ref !== null) params.ref = defaults.ref;
  if (defaults.promo !== null) params.promo = defaults.promo;
  return params;
}

/** What the panel lets the user change: the locks and allow-lists it opened on. */
export type EmbedPolicy = Pick<EmbedDefaults, "locks" | EmbedAllowField>;

/** The panel with no locks and no allow-lists, as it was before they existed. */
export const OPEN_POLICY: EmbedPolicy = {
  locks: FRAME_DEFAULTS.locks,
  fromChains: null,
  toChains: null,
  sellTokens: null,
  buyTokens: null,
};

/** Whether a route keeps to the policy's allow-lists (locks are the caller's). */
export function policyAdmits(
  policy: EmbedPolicy,
  route: { fromChainId: number; toChainId: number; fromSymbol: string; toSymbol: string },
): boolean {
  return (
    (policy.fromChains?.some((id) => id === route.fromChainId) ?? true) &&
    (policy.toChains?.some((id) => id === route.toChainId) ?? true) &&
    (policy.sellTokens?.includes(route.fromSymbol) ?? true) &&
    (policy.buyTokens?.includes(route.toSymbol) ?? true)
  );
}

/**
 * Whether a route keeps every lock and list of what the frame opened on.
 * `amount` is the amount it would show, or null for one a lock cannot accept
 * (a Retry restores its own), which a locked amount refuses.
 */
export function policyHolds(
  opened: EmbedDefaults,
  route: { fromChainId: number; toChainId: number; fromSymbol: string; toSymbol: string },
  amount: string | null,
): boolean {
  const keeps: Record<EmbedLock, boolean> = {
    fromChain: route.fromChainId === opened.fromChainId,
    toChain: route.toChainId === opened.toChainId,
    sell: route.fromSymbol === opened.fromToken.symbol,
    buy: route.toSymbol === opened.toToken.symbol,
    amount: amount === opened.amount,
  };
  return opened.locks.every((lock) => keeps[lock]) && policyAdmits(opened, route);
}

/**
 * A leg's solver symbols narrowed to an allow-list (null: no list). An empty
 * solver list means "no narrowing" (pairAvailability.ts), so the list itself
 * stands in for it.
 */
export function narrowSymbols(
  offered: readonly string[],
  allowed: readonly string[] | null,
): readonly string[] {
  if (allowed === null) return offered;
  return offered.length === 0 ? allowed : offered.filter((s) => allowed.includes(s));
}

/** One leg of the policy: its chain and token locks and its two lists. */
function legPolicy(policy: EmbedPolicy, leg: "sell" | "buy") {
  return leg === "sell"
    ? {
        chainLocked: policy.locks.includes("fromChain"),
        tokenLocked: policy.locks.includes("sell"),
        chains: policy.fromChains,
        symbols: policy.sellTokens,
      }
    : {
        chainLocked: policy.locks.includes("toChain"),
        tokenLocked: policy.locks.includes("buy"),
        chains: policy.toChains,
        symbols: policy.buyTokens,
      };
}

/**
 * Whether the policy lets a leg, now `current`, move to `chainId`: its chain is
 * not locked elsewhere, the chain is listed, it carries an allowed token, and
 * with the token locked it carries that token (a chain switch keeps the symbol
 * only where it exists). The pickers and the route handlers read this one rule.
 */
export function legChainAllowed(
  policy: EmbedPolicy,
  leg: "sell" | "buy",
  chainId: number,
  current: { chainId: number; symbol: string },
): boolean {
  const { chainLocked, tokenLocked, chains, symbols } = legPolicy(policy, leg);
  const carried = (CHAIN_TOKENS[chainId] ?? []).map((t) => t.symbol);
  return (
    (!chainLocked || chainId === current.chainId) &&
    (chains?.some((id) => id === chainId) ?? true) &&
    (symbols === null || carried.some((s) => symbols.includes(s))) &&
    (!tokenLocked || carried.includes(current.symbol))
  );
}

/** Whether the policy lets a leg, now on `currentChainId`, take `token`. */
export function legTokenAllowed(
  policy: EmbedPolicy,
  leg: "sell" | "buy",
  token: { chainId: number; symbol: string },
  currentChainId: number,
): boolean {
  const { chainLocked, tokenLocked, chains, symbols } = legPolicy(policy, leg);
  return (
    !tokenLocked &&
    (!chainLocked || token.chainId === currentChainId) &&
    (chains?.some((id) => id === token.chainId) ?? true) &&
    (symbols?.includes(token.symbol) ?? true)
  );
}

/** The fragment that opens the full frame on its Claims tab. */
export const CLAIMS_HASH = "#claims";

/**
 * Where a frame without tabs (`layout=swap`) sends a stealth recipient to
 * claim: the full widget in its own tab, in the same theme, on Claims. The
 * route options are left out: the claim is the visit's whole purpose.
 */
export function claimsPath(theme: EmbedTheme): string {
  return `${EMBED_PATH}${encodeEmbedParams(theme === "auto" ? {} : { theme })}${CLAIMS_HASH}`;
}
