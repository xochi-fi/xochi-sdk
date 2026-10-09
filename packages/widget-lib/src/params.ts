/**
 * Frame URL parameters: the defaults a host sets on `/embed`.
 *
 * The ONE definition of their names, syntax and encoding, shared by this
 * library (which writes them) and the widget frame (which reads them at load).
 * Moved here from xochi-widget `src/pages/trade/embedParams.ts`; the widget
 * importing it from this package instead of keeping its own copy is part of
 * its migration onto `@xochi/widget-lib`.
 *
 *   fromChain   origin chain, decimal chain id           fromChain=1
 *   toChain     destination chain, decimal chain id      toChain=8453
 *   sell        token sent, symbol (any case)            sell=USDT
 *   buy         token received, symbol (any case)        buy=USDC
 *   amount      amount sent, a plain decimal in `sell`   amount=250
 *   settlement  `public` or `stealth`                    settlement=stealth
 *
 * This module is SYNTAX only. They are defaults, not locks: the user can change
 * every one of them in the frame, and the frame checks each value against what
 * it can honour at load (chain offered in that direction, token on that chain,
 * pair fillable by the solver, stealth only on `toChain=1`, at most the sell
 * token's decimals), silently falling back to its own default for anything it
 * cannot. No parameter at all opens the frame on its defaults.
 */

/** The query-string keys, by field. */
export const EMBED_PARAM = {
  fromChainId: "fromChain",
  toChainId: "toChain",
  sellSymbol: "sell",
  buySymbol: "buy",
  amount: "amount",
  settlement: "settlement",
} as const;

/** The settlement modes a host may preselect. */
export type EmbedSettlement = "public" | "stealth";

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
}

const CHAIN_ID = /^[1-9]\d{0,11}$/;
const SYMBOL = /^[A-Za-z0-9]{1,16}$/;
const AMOUNT = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

const FIELDS = Object.keys(EMBED_PARAM) as (keyof EmbedParams)[];

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
  return params;
}

/** Why `value` cannot be written as `field`, or null when it can. */
function fieldProblem(field: keyof EmbedParams, value: unknown): string | null {
  switch (field) {
    case "fromChainId":
    case "toChainId":
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        CHAIN_ID.test(String(value))
        ? null
        : "must be a positive integer chain id (at most 12 digits)";
    case "sellSymbol":
    case "buySymbol":
      return typeof value === "string" && SYMBOL.test(value)
        ? null
        : "must be a token symbol of 1-16 letters or digits";
    case "amount":
      return typeof value === "string" && AMOUNT.test(value)
        ? null
        : 'must be a plain decimal string such as "250" or "0.5"';
    case "settlement":
      return value === "public" || value === "stealth" ? null : 'must be "public" or "stealth"';
  }
}

/**
 * The query string (with `?`, or "" for none) that asks the frame for
 * `params`. Keys are written in a fixed order, unset fields are omitted, and
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
    query.set(EMBED_PARAM[field], String(value));
  }
  const search = query.toString();
  return search === "" ? "" : `?${search}`;
}
