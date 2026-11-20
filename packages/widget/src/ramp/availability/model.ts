/**
 * Rail availability model for Trade/Buy and Send/payment_app.
 *
 * Pure functions over S2's normalized `RampOffer`s; no I/O. Selectability is
 * `checkRampOffer` against the validated Base USDC settlement at the given
 * clock, nothing else: a static label, a host parameter or a stale observation
 * can explain a rail but never make it selectable. Every reason is text built
 * from bounded snake_case codes, so a card reads the same without colour.
 */

import {
  atomic,
  checkRampOffer,
  type RampAvailability,
  type RampDirection,
  type RampIntent,
  type RampOffer,
  type RampSettlement,
} from "@xochi/client";

/** USDC and Peer's USD wire precision are both six decimals (ramp/peer/README.md). */
export const RAMP_DECIMALS = 6;

/** Canonical USDC amount from what the user typed; no JS number touches the value. */
export function parseRampAmount(input: string): string | undefined {
  const value = input.trim();
  const match = /^(\d{1,24})(?:\.(\d{0,6}))?$/.exec(value);
  if (!match) return undefined;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").padEnd(RAMP_DECIMALS, "0");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return digits === "0" ? undefined : digits;
}

/** Exact Base USDC amount, paid (offramp) or received (onramp), to the connected wallet. */
export function buildRampIntent(input: {
  direction: RampDirection;
  amount: string;
  currency: string;
  recipient: string;
  settlement: RampSettlement;
}): RampIntent {
  return {
    contract_version: "ramp/1",
    kind: "intent",
    direction: input.direction,
    exact: {
      side: "crypto",
      money: { asset: input.settlement, atomic: atomic(input.amount) },
    },
    fiat: { kind: "fiat", currency: input.currency, decimals: RAMP_DECIMALS },
    crypto: input.settlement,
    recipient: input.recipient,
  };
}

/** Display names for rail ids Peer returns. Availability comes only from live data. */
export const RAIL_NAMES: Readonly<Record<string, string>> = {
  venmo: "Venmo",
  revolut: "Revolut",
  wise: "Wise",
  zelle: "Zelle",
  cashapp: "Cash App",
  paypal: "PayPal",
  monzo: "Monzo",
  mercadopago: "Mercado Pago",
  chime: "Chime",
  n26: "N26",
  monobank: "Monobank",
  upi: "UPI",
  xmoney: "X Money",
  alipay: "Alipay",
};

export function railName(offer: Pick<RampOffer, "rail">): string {
  return Object.hasOwn(RAIL_NAMES, offer.rail.id) ? RAIL_NAMES[offer.rail.id] : offer.rail.label;
}

export type RailCardState = RampAvailability["state"] | "expired";

export interface RailCard {
  id: string;
  name: string;
  state: RailCardState;
  selectable: boolean;
  /** Short status, e.g. "Available" or "Setup required". */
  status: string;
  /** Why, in a sentence. */
  reason: string;
  /** What the user can do next, when anything. */
  next?: string;
  /** Temporarily unavailable: when Peer suggests checking again. */
  retryAfter?: string;
  /** Requirements that stay true even for an available rail. */
  needs: string[];
}

const STATUS: Record<RailCardState, string> = {
  available: "Available",
  setup_required: "Setup required",
  temporarily_unavailable: "Temporarily unavailable",
  not_supported: "Not supported",
  availability_unknown: "Availability unknown",
  expired: "Offer expired",
};

/** Setup requirements: what is missing, and the step that clears it. */
const REQUIREMENTS: Readonly<Record<string, { reason: string; next: string }>> = {
  peer_desktop_extension_or_app: {
    reason:
      "Buying through Peer works only in desktop Chrome or Brave with the Peer extension, or in the Peer app.",
    next: "Open this page in desktop Chrome or Brave with the Peer extension, or use the Peer app.",
  },
  peer_dispute_stake: {
    reason:
      "This rail needs Peer stake on your account. Without it, Peer can hold the payout for up to 14 days.",
    next: "Add stake in Peer, then check again.",
  },
  peer_wallet_linked_session: {
    reason:
      "Peer needs an account session linked to this wallet before it will quote a purchase. This widget cannot sign you in to Peer.",
    next: "Sign in to Peer with this wallet and finish its account setup, then check again.",
  },
  maker_account_setup: {
    reason: "Peer needs your payment-app account set up for this rail before you can cash out.",
    next: "Set up your account below, then check again.",
  },
  maker_seller_credential: {
    reason: "Peer has not verified a payment-app account of yours for this rail.",
    next: "Verify your own account in Peer, then check again.",
  },
};

/** Interaction requirements on an otherwise available offer. */
const NEEDS: Readonly<Record<string, string>> = {
  peer_extension: "The Peer browser extension or app",
  user_payment: "A payment you make from your own payment-app account",
  own_payment_account: "A payment-app account that belongs to you",
  maker_estimate: "Accepting an estimated, not locked, rate",
  asynchronous_partial_fills: "Waiting for fills, which can arrive in parts",
};

function reasonFor(
  availability: Exclude<RampAvailability, { state: "available" }>,
  direction: RampDirection,
): string {
  if (availability.state === "setup_required") {
    const known = availability.requirement_codes
      .map((c) => REQUIREMENTS[c]?.reason)
      .filter((r): r is string => r !== undefined);
    return known.length ? known.join(" ") : "Peer needs a setup step first.";
  }
  const code = availability.reason_code;
  switch (availability.state) {
    case "temporarily_unavailable":
      return code === "capabilities_unavailable"
        ? "Peer could not be reached, so this rail cannot be used right now."
        : "Peer reports no usable liquidity on this rail for this amount right now.";
    case "not_supported":
      return "Peer does not support this rail for this currency and amount.";
    case "availability_unknown":
      if (code === "capability_unavailable" && direction === "offramp")
        return "Peer has not confirmed live cash-out limits, rate and account status for this rail, so it cannot be chosen.";
      if (code === "capability_unavailable")
        return "Peer returned no fresh, verifiable offer for this rail, so it cannot be chosen.";
      if (code === "capabilities_unavailable")
        return "Peer could not be reached, so availability is unknown.";
      if (code === "invalid_request")
        return "Peer cannot quote this request; only USD to Base USDC is supported now.";
      return "Availability could not be confirmed.";
  }
}

function nextFor(
  availability: Exclude<RampAvailability, { state: "available" }>,
): string | undefined {
  switch (availability.state) {
    case "setup_required": {
      const steps = availability.requirement_codes
        .map((c) => REQUIREMENTS[c]?.next)
        .filter((r): r is string => r !== undefined);
      return steps.length ? steps.join(" ") : "Complete the step in Peer, then check again.";
    }
    case "temporarily_unavailable":
      return availability.retry_after
        ? "Check again after the time shown."
        : "Check again in a moment, or choose another rail.";
    case "not_supported":
      return "Choose another rail or a different amount.";
    case "availability_unknown":
      return "Check again later; it stays unselectable until Peer confirms it.";
  }
}

export function formatRampTime(value: string | number | Date, dateOnly = false): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : dateOnly
      ? date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" })
      : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** One card per offer, at `now`. Only `checkRampOffer` can make a card selectable. */
export function railCard(
  offer: RampOffer,
  intent: RampIntent,
  settlement: RampSettlement,
  now: number,
): RailCard {
  const needs = offer.interaction.requirement_codes
    .map((c) => NEEDS[c])
    .filter((n): n is string => n !== undefined);
  const base = { id: offer.rail.id, name: railName(offer), needs };
  const { availability } = offer;
  if (availability.state === "available") {
    const check = checkRampOffer(offer, intent, settlement, now);
    if (check.ok)
      return {
        ...base,
        state: "available",
        selectable: true,
        status: STATUS.available,
        reason:
          offer.direction === "offramp"
            ? `Live Peer estimate for this amount, not a locked rate; can be chosen until ${formatRampTime(availability.valid_until)}.`
            : `Fresh Peer offer for this exact amount, valid until ${formatRampTime(availability.valid_until)}.`,
      };
    const expired = check.code === "quote_expired";
    return {
      ...base,
      state: expired ? "expired" : "availability_unknown",
      selectable: false,
      status: expired ? STATUS.expired : STATUS.availability_unknown,
      reason: expired
        ? "This offer is past its validity window and can no longer be chosen."
        : "This offer no longer matches the request, so it cannot be chosen.",
      next: "Check again for a fresh offer.",
    };
  }
  return {
    ...base,
    state: availability.state,
    selectable: false,
    status: STATUS[availability.state],
    reason: reasonFor(availability, offer.direction),
    next: nextFor(availability),
    ...(availability.state === "temporarily_unavailable" && availability.retry_after
      ? { retryAfter: availability.retry_after }
      : {}),
  };
}

/** A result with no offers still explains itself (mobile web, unreachable, unknown). */
export function overallCard(
  availability: RampAvailability,
  direction: RampDirection,
): Omit<RailCard, "id" | "name" | "needs"> {
  if (availability.state === "available")
    return {
      state: "availability_unknown",
      selectable: false,
      status: STATUS.availability_unknown,
      reason: "Peer returned no rails for this request.",
      next: "Check again later.",
    };
  return {
    state: availability.state,
    selectable: false,
    status: STATUS[availability.state],
    reason: reasonFor(availability, direction),
    next: nextFor(availability),
    ...(availability.state === "temporarily_unavailable" && availability.retry_after
      ? { retryAfter: availability.retry_after }
      : {}),
  };
}

/** Next instant a currently selectable offer stops being selectable, if any. */
export function nextExpiry(offers: readonly RampOffer[], now: number): number | undefined {
  let next: number | undefined;
  for (const offer of offers) {
    if (offer.availability.state !== "available") continue;
    const at = Date.parse(offer.availability.valid_until);
    if (Number.isFinite(at) && at > now && (next === undefined || at < next)) next = at;
  }
  return next;
}

/** Full facts, expandable before rail choice and always visible at review before consent. */
export function rampFacts(direction: RampDirection): string[] {
  const shared = [
    "Base transfers, amounts and wallet addresses are public.",
    `The ${direction === "offramp" ? "buyer" : "seller"} sees your payment details and name.`,
    "Peer handles required payment data. Its access checks and secure verifier must be online.",
  ];
  return direction === "onramp"
    ? [
        ...shared,
        "Expired or unverifiable purchases have no protocol refund. Check the active intent before paying.",
        "Without Peer stake, Venmo or PayPal payouts can be held for 14 days. Held funds cannot start a swap.",
      ]
    : [...shared, "Rates can change. Payments can arrive later in parts."];
}
