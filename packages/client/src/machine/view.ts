/**
 * view(model) -> Receipt. Pure; the renderer draws this and nothing it derives
 * on its own from the raw quote.
 */
import { MAX_EXECUTE_RESENDS } from "../shared/index.js";
import { canSignQuote } from "./decisions.js";
import { holdsCurrentQuote, type Model } from "./machine.js";
import { phaseFromStatus } from "./phase.js";
import {
  costOf,
  payoutOf,
  settlementDisclosure,
  type QuoteSlot,
  type Receipt,
  type SigningSlot,
} from "./receipt.js";

function quoteSlot(model: Model): QuoteSlot {
  const { status, quote } = model.intent;
  // The receipt STAYS MOUNTED while a replacement is fetched, but only over a
  // solvable quote: after a decline the held quote's figures are empty.
  if (quote && (status === "quoted" || (status === "quoting" && quote.canSolve))) {
    return {
      kind: "ready",
      executable: !quote.preview,
      refreshing: status === "quoting",
      expiresInSec: model.quoteExpiresIn,
    };
  }
  if (status === "quoting") return { kind: "loading" };
  if (quote && !quote.canSolve) return { kind: "declined", reason: quote.error ?? null };
  return { kind: "none" };
}

function signingSlot(model: Model): SigningSlot {
  const quote = model.intent.quote;
  const signatures = quote?.pullAuthorization ? 2 : 1;
  const flow = model.sign;
  if (flow) {
    if (flow.stage === "execute") {
      const attempt = flow.execute;
      return typeof attempt?.resendAt === "number"
        ? {
            kind: "busy",
            retryAt: Math.ceil(attempt.resendAt / 1000),
            resend: attempt.resends + 1,
            of: MAX_EXECUTE_RESENDS,
          }
        : { kind: "submitted" };
    }
    return flow.stage === "intent"
      ? { kind: "in_wallet", step: 1, of: signatures }
      : { kind: "in_wallet", step: 2, of: 2 };
  }
  if (model.awaitingPull) return { kind: "awaiting_second" };
  // A quote for a trade the form no longer describes is shown, never offered.
  if (!canSignQuote(model.intent.status, quote) || !holdsCurrentQuote(model)) {
    return { kind: "unavailable" };
  }
  if (model.intent.refusal) return { kind: "refused", refusal: model.intent.refusal };
  return quote?.depositAddress ? { kind: "deposit" } : { kind: "ready", signatures };
}

export function view(model: Model): Receipt {
  const { status, reconciling, mayHaveMoved, notSent, quote, quotedSettlement } = model.intent;
  // A held quote is disclosed under the settlement it was requested (and is
  // signed) under, not whatever the form says now.
  const settlement = (quote && quotedSettlement) || model.ctx.settlementPreference;
  return {
    phase: phaseFromStatus(status, { reconciling, mayHaveMoved, notSent }),
    quote: quoteSlot(model),
    payout: payoutOf(quote),
    cost: costOf(quote),
    settlement: settlementDisclosure(settlement),
    signing: signingSlot(model),
  };
}
