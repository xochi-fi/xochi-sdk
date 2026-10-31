/**
 * Frame URL parameters: what a host sets on `/embed`.
 *
 * The ONE definition of their names, syntax and encoding, shared by this
 * library (which writes them) and the widget frame (which reads them at load
 * by importing this package, never a copy of its own).
 *
 *   fromChain   origin chain, decimal chain id           fromChain=1
 *   toChain     destination chain, decimal chain id      toChain=8453
 *   sell        token sent, symbol (any case)            sell=USDT
 *   buy         token received, symbol (any case)        buy=USDC
 *   amount      amount sent, a plain decimal in `sell`   amount=250
 *   settlement  `public` or `stealth`                    settlement=stealth
 *   theme       `auto`, `light`, `dim` or `contrast`     theme=light
 *   layout      `full` or `swap` (no tab row)            layout=swap
 *   howItWorks  `0` hides the How it works disclosure    howItWorks=0
 *   height      fixed frame height in px, 480 to 1600    height=640
 *   lock        fields the user cannot change            lock=sell,buy,amount
 *   fromChains  chains the user may send from            fromChains=8453,10
 *   toChains    chains the user may receive on           toChains=1
 *   sellTokens  tokens the user may send                 sellTokens=USDC,USDT
 *   buyTokens   tokens the user may receive              buyTokens=USDC
 *   ref         referral code                            ref=PARTNER
 *   promo       promo code                               promo=LAUNCH10
 *
 * This module is SYNTAX only. The route, amount and settlement are defaults,
 * not locks: the user can change every one of them in the frame, unless `lock`
 * names it, and only within the allow-lists. The frame checks each value
 * against what it can honour at load (chain offered in that direction, token
 * on that chain, pair fillable by the solver, stealth only where the solver
 * offers it, at most the sell token's decimals), silently falling back to its
 * own default for anything it cannot.
 *
 * The look is honoured whenever it is well-formed: `theme` defaults to `auto`
 * (the OS preference), `layout` to `full`, `howItWorks` to shown, and without
 * `height` the frame grows to its content. Locks and allow-lists are
 * client-side conveniences, not policy: a user who edits the URL is not bound
 * by them. `ref` and `promo` are sent on every quote and the server decides;
 * a code it cannot use never blocks a quote. No parameter at all opens the
 * frame on its defaults.
 */

/** The query-string keys, by field: the route keys, then the frame's look, locks, lists and codes. */
export const EMBED_PARAM = {
  fromChainId: "fromChain",
  toChainId: "toChain",
  sellSymbol: "sell",
  buySymbol: "buy",
  amount: "amount",
  settlement: "settlement",
  theme: "theme",
  layout: "layout",
  howItWorks: "howItWorks",
  height: "height",
  locks: "lock",
  fromChains: "fromChains",
  toChains: "toChains",
  sellTokens: "sellTokens",
  buyTokens: "buyTokens",
  ref: "ref",
  promo: "promo",
} as const;

/** The settlement modes a host may preselect. */
export type EmbedSettlement = "public" | "stealth";

/**
 * The frame's looks: `auto` (the default) follows the OS, `contrast` is the
 * high-contrast theme.
 */
export const EMBED_THEMES = ["auto", "light", "dim", "contrast"] as const;
export type EmbedTheme = (typeof EMBED_THEMES)[number];

/** What the frame shows: everything (the default), or the swap card without its tab row. */
export const EMBED_LAYOUTS = ["full", "swap"] as const;
export type EmbedLayout = (typeof EMBED_LAYOUTS)[number];

/**
 * The fields a host may lock, by their parameter names, in the order they are
 * stored and written. Locking `amount` locks `fromChain` and `sell` too: the
 * amount is denominated in them.
 */
export const EMBED_LOCKS = ["fromChain", "sell", "amount", "toChain", "buy"] as const;
export type EmbedLock = (typeof EMBED_LOCKS)[number];

/** The allow-list fields, in the order they are written. */
export const EMBED_ALLOW_FIELDS = ["fromChains", "toChains", "sellTokens", "buyTokens"] as const;
export type EmbedAllowField = (typeof EMBED_ALLOW_FIELDS)[number];

/** The heights `height` accepts, in CSS pixels, inclusive. */
export const EMBED_HEIGHT = { min: 480, max: 1600 } as const;

/** The most entries a list parameter (`lock` and the allow-lists) may carry. */
export const MAX_EMBED_LIST = 32;

/**
 * A referral or promo code as the server stores it: 3 to 32 of `A-Z 0-9 _ -`,
 * starting with a letter or digit. The same pattern as `@xochi/client`'s
 * `REFERRAL_CODE_REGEX` and `PROMO_CODE_REGEX` (params.test.ts holds them
 * equal); inlined because this package has no dependencies.
 */
export const EMBED_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/**
 * What the URL asks for: syntactically well-formed values, not yet checked
 * against the token registry or the solver.
 */
export interface EmbedParams {
  fromChainId?: number;
  toChainId?: number;
  sellSymbol?: string;
  buySymbol?: string;
  amount?: string;
  settlement?: EmbedSettlement;
  theme?: EmbedTheme;
  layout?: EmbedLayout;
  /** Whether the How it works disclosure shows under the card; written `1` or `0`. */
  howItWorks?: boolean;
  /** A fixed frame height in CSS px that scrolls inside, `EMBED_HEIGHT` bounds. */
  height?: number;
  /** The fields the user cannot change, in `EMBED_LOCKS` order (key `lock`). */
  locks?: readonly EmbedLock[];
  fromChains?: readonly number[];
  toChains?: readonly number[];
  sellTokens?: readonly string[];
  buyTokens?: readonly string[];
  /** Uppercase, `EMBED_CODE_PATTERN`. */
  ref?: string;
  /** Uppercase, `EMBED_CODE_PATTERN`. */
  promo?: string;
}

const CHAIN_ID = /^[1-9]\d{0,11}$/;
const SYMBOL = /^[A-Za-z0-9]{1,16}$/;
const AMOUNT = /^(\d{1,30})(?:\.(\d{1,30}))?$/;
const PIXELS = /^[1-9]\d{0,3}$/;
const LOCK_ENTRY = /^[A-Za-z]+$/;

const FIELDS = Object.keys(EMBED_PARAM) as (keyof EmbedParams)[];

/** A presented code in its stored (uppercase) form, or null when it cannot be one. */
export function normalizeEmbedCode(presented: string): string | null {
  const code = presented.trim().toUpperCase();
  return EMBED_CODE_PATTERN.test(code) ? code : null;
}

/** `text` as a frame height in pixels, or undefined when the frame refuses it. */
export function parseEmbedHeight(text: string): number | undefined {
  if (!PIXELS.test(text)) return undefined;
  const px = Number(text);
  return px >= EMBED_HEIGHT.min && px <= EMBED_HEIGHT.max ? px : undefined;
}

/**
 * A comma list of up to MAX_EMBED_LIST distinct values (compared
 * case-insensitively) each matching `entry`, or undefined when the list is
 * empty, too long, repeats a value or has one malformed entry: a list
 * half-understood is not honoured at all.
 */
function parseList(raw: string | null, entry: RegExp): string[] | undefined {
  if (raw === null || raw === "") return undefined;
  // One past the cap is enough to refuse it, however long the value is.
  const items = raw.split(",", MAX_EMBED_LIST + 1);
  const keys = items.map((item) => item.toUpperCase());
  if (
    items.length > MAX_EMBED_LIST ||
    !items.every((item) => entry.test(item)) ||
    new Set(keys).size !== keys.length
  ) {
    return undefined;
  }
  return items;
}

/**
 * Read the frame parameters from a query string (`location.search`, with or
 * without the leading `?`). Malformed values are dropped here and unknown keys
 * ignored, so a URL with nothing usable reads as `{}`. Never throws.
 */
export function parseEmbedParams(search: string): EmbedParams {
  const query = new URLSearchParams(search);
  const params: EmbedParams = {};
  const fromChain = query.get(EMBED_PARAM.fromChainId) ?? "";
  if (CHAIN_ID.test(fromChain)) params.fromChainId = Number(fromChain);
  const toChain = query.get(EMBED_PARAM.toChainId) ?? "";
  if (CHAIN_ID.test(toChain)) params.toChainId = Number(toChain);
  const sell = query.get(EMBED_PARAM.sellSymbol) ?? "";
  if (SYMBOL.test(sell)) params.sellSymbol = sell;
  const buy = query.get(EMBED_PARAM.buySymbol) ?? "";
  if (SYMBOL.test(buy)) params.buySymbol = buy;
  const amount = query.get(EMBED_PARAM.amount) ?? "";
  if (AMOUNT.test(amount)) params.amount = amount;
  const settlement = query.get(EMBED_PARAM.settlement);
  if (settlement === "public" || settlement === "stealth") params.settlement = settlement;
  const theme = query.get(EMBED_PARAM.theme);
  const knownTheme = EMBED_THEMES.find((known) => known === theme);
  if (knownTheme !== undefined) params.theme = knownTheme;
  const layout = query.get(EMBED_PARAM.layout);
  const knownLayout = EMBED_LAYOUTS.find((known) => known === layout);
  if (knownLayout !== undefined) params.layout = knownLayout;
  const howItWorks = query.get(EMBED_PARAM.howItWorks);
  if (howItWorks === "0" || howItWorks === "1") params.howItWorks = howItWorks === "1";
  const height = parseEmbedHeight(query.get(EMBED_PARAM.height) ?? "");
  if (height !== undefined) params.height = height;
  const locks = parseList(query.get(EMBED_PARAM.locks), LOCK_ENTRY);
  if (locks?.every((lock) => EMBED_LOCKS.some((known) => known === lock))) {
    params.locks = EMBED_LOCKS.filter((known) => locks.includes(known));
  }
  const fromChains = parseList(query.get(EMBED_PARAM.fromChains), CHAIN_ID);
  if (fromChains) params.fromChains = fromChains.map(Number);
  const toChains = parseList(query.get(EMBED_PARAM.toChains), CHAIN_ID);
  if (toChains) params.toChains = toChains.map(Number);
  const sellTokens = parseList(query.get(EMBED_PARAM.sellTokens), SYMBOL);
  if (sellTokens) params.sellTokens = sellTokens;
  const buyTokens = parseList(query.get(EMBED_PARAM.buyTokens), SYMBOL);
  if (buyTokens) params.buyTokens = buyTokens;
  const ref = normalizeEmbedCode(query.get(EMBED_PARAM.ref) ?? "");
  if (ref !== null) params.ref = ref;
  const promo = normalizeEmbedCode(query.get(EMBED_PARAM.promo) ?? "");
  if (promo !== null) params.promo = promo;
  return params;
}

function isChainId(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && CHAIN_ID.test(String(value));
}

function isSymbol(value: unknown): boolean {
  return typeof value === "string" && SYMBOL.test(value);
}

/**
 * Whether `value` is a list `parseEmbedParams` reads back whole: 1 to
 * MAX_EMBED_LIST entries, each passing `entry`, none repeated (compared
 * case-insensitively).
 */
function isList(value: unknown, entry: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMBED_LIST) return false;
  if (!value.every(entry)) return false;
  const keys = value.map((item) => String(item).toUpperCase());
  return new Set(keys).size === keys.length;
}

/** Why `value` cannot be written as `field`, or null when it can. */
function fieldProblem(field: keyof EmbedParams, value: unknown): string | null {
  switch (field) {
    case "fromChainId":
    case "toChainId":
      return isChainId(value) ? null : "must be a positive integer chain id (at most 12 digits)";
    case "sellSymbol":
    case "buySymbol":
      return isSymbol(value) ? null : "must be a token symbol of 1-16 letters or digits";
    case "amount":
      return typeof value === "string" && AMOUNT.test(value)
        ? null
        : 'must be a plain decimal string such as "250" or "0.5"';
    case "settlement":
      return value === "public" || value === "stealth" ? null : 'must be "public" or "stealth"';
    case "theme":
      return EMBED_THEMES.some((theme) => theme === value)
        ? null
        : `must be one of ${EMBED_THEMES.join(", ")}`;
    case "layout":
      return EMBED_LAYOUTS.some((layout) => layout === value)
        ? null
        : `must be one of ${EMBED_LAYOUTS.join(", ")}`;
    case "howItWorks":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "height":
      return typeof value === "number" && parseEmbedHeight(String(value)) !== undefined
        ? null
        : `must be a whole number of pixels from ${EMBED_HEIGHT.min} to ${EMBED_HEIGHT.max}`;
    case "locks":
      return isList(value, (lock) => EMBED_LOCKS.some((known) => known === lock))
        ? null
        : `must be a non-empty list of ${EMBED_LOCKS.join(", ")}, each once`;
    case "fromChains":
    case "toChains":
      return isList(value, isChainId)
        ? null
        : `must be a list of 1 to ${MAX_EMBED_LIST} distinct positive integer chain ids (at most 12 digits)`;
    case "sellTokens":
    case "buyTokens":
      return isList(value, isSymbol)
        ? null
        : `must be a list of 1 to ${MAX_EMBED_LIST} token symbols of 1-16 letters or digits, distinct in any case`;
    case "ref":
    case "promo":
      return typeof value === "string" && normalizeEmbedCode(value) === value
        ? null
        : "must be 3 to 32 capital letters, digits, _ or -, starting with a letter or digit";
  }
}

/** A value `fieldProblem` accepted, as the frame reads it. */
function fieldText(field: keyof EmbedParams, value: unknown): string {
  switch (field) {
    case "howItWorks":
      return value === true ? "1" : "0";
    case "locks": {
      const locks = value as readonly EmbedLock[];
      return EMBED_LOCKS.filter((lock) => locks.includes(lock)).join(",");
    }
    case "fromChains":
    case "toChains":
    case "sellTokens":
    case "buyTokens":
      return (value as readonly unknown[]).join(",");
    default:
      return String(value);
  }
}

/**
 * The query string (with `?`, or "" for none) that asks the frame for
 * `params`. Keys are written in `EMBED_PARAM` order, the route keys first,
 * whatever the object's order; unset fields are omitted, `lock` is written in
 * `EMBED_LOCKS` order, a list's commas are left unencoded, and
 * `parseEmbedParams` reads the result back to an equal object.
 *
 * Throws a TypeError naming the field for a value `parseEmbedParams` would
 * drop, and for an unknown key: a host's mistake should fail where it was made,
 * not reach the frame as a default silently ignored.
 */
export function encodeEmbedParams(params: EmbedParams): string {
  if (params === null || typeof params !== "object") {
    throw new TypeError("embed params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!(FIELDS as string[]).includes(key)) {
      throw new TypeError(
        `unknown embed parameter "${key}" (expected one of ${FIELDS.join(", ")})`,
      );
    }
  }
  const query = new URLSearchParams();
  for (const field of FIELDS) {
    const value = params[field];
    if (value === undefined) continue;
    const problem = fieldProblem(field, value);
    if (problem !== null) throw new TypeError(`embed parameter ${field} ${problem}`);
    query.set(EMBED_PARAM[field], fieldText(field, value));
  }
  // Commas are legal in a query and read better as they are; only a list
  // writes one, and no value written holds a comma of its own.
  const search = query.toString().replace(/%2C/g, ",");
  return search === "" ? "" : `?${search}`;
}
