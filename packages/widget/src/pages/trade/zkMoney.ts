/**
 * zk.money as a typed capability destination.
 *
 * The currently advertised route is DAI on Ethereum, settled public, to a
 * recipient tag. The Worker resolves `<tag>.zk.money` once per quote and binds the resulting one-time
 * deposit address as the payout recipient; this side sends `recipient_tag`
 * and never an address. zk.money's relayer then sweeps the deposit and credits
 * the tag, taking a fixed fee on arrival, so the figure shown is approximate.
 */

/** Where a credited deposit shows up. */
export const ZKMONEY_ACTIVITY_URL = "https://wallet.zk.money/activity";

export const ZKMONEY_ACCOUNT_URL = "https://wallet.zk.money/";

export const ZKMONEY_PRIVACY_COPY =
  "Inside zk.money on Aztec, amounts and participants are hidden from public view. Ethereum deposits and withdrawals stay public and may be correlated.";

/** zk.money's fixed deposit fee, stated once beside the quote. */
export const ZKMONEY_ARRIVAL_NOTE = "zk.money charges about $0.35 on arrival";

/** Delivered DAI the Worker accepts per send, inclusive. */
export const ZKMONEY_FLOOR_DAI = 1;
export const ZKMONEY_CAP_DAI = 4900;

/** The Worker's spelling of a tag: lowercase, no `@`, DNS-label characters. */
const TAG_PATTERN = /^[a-z0-9-]{1,63}$/;

/** What the user typed, as the Worker spells it: trimmed, one leading `@` off, lowercased. */
export function normalizeZkMoneyTag(input: string): string {
  const trimmed = input.trim();
  return (trimmed.startsWith("@") ? trimmed.slice(1) : trimmed).toLowerCase();
}

export function zkMoneyTagValid(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

/** The tag's own field error, or null while empty or valid. */
export function zkMoneyTagError(tag: string): string | null {
  if (tag.length === 0 || zkMoneyTagValid(tag)) return null;
  return "Use 1–63 letters, numbers or hyphens.";
}

/**
 * The Worker's tag failure, worded for the panel; null for unrelated errors.
 * The category can come from a declined quote or an HTTP failure with no quote.
 */
export function zkMoneyRefusal(errorCategory: string | undefined, tag: string): string | null {
  switch (errorCategory) {
    case "tag_unresolved":
      return `We couldn't find @${tag}. Check the spelling.`;
    case "tag_resolution_unavailable":
      return `We can't look up @${tag} right now. Please try again.`;
    case "tag_destination_unsupported":
      return "zk.money can only receive DAI on Ethereum, sent public.";
    case "amount_below_floor":
      return `@${tag} must receive at least ${ZKMONEY_FLOOR_DAI} DAI.`;
    case "amount_above_cap":
      return `@${tag} can receive at most ${ZKMONEY_CAP_DAI.toLocaleString("en-US")} DAI per send.`;
    default:
      return null;
  }
}
