/**
 * Send/payment_app cash-out model: pure functions, no I/O.
 *
 * The order's progress comes only from S5's `orderStatus` (a bounded phase,
 * rebuilt from chain and indexer facts) and the ramp snapshot's leg state. No
 * local field can advance an order. Estimates are approximate by contract
 * (`maker_estimate`); nothing here phrases one as a locked rate or an ETA.
 */

import type { RampPreview, RampSnapshot } from "@xochi/client";
import type { MakerPhase, MakerReason, MakerWalletAction } from "../peer/index.js";
import { formatTokenAmount } from "../../utils/format.js";

/** Peer's maker deposits settle Base USDC only (six decimals). */
export const USDC_DECIMALS = 6;

export function formatUsdc(atomic: string): string {
  return `${formatTokenAmount(BigInt(atomic), USDC_DECIMALS, USDC_DECIMALS)} USDC`;
}

export function formatMixedCashOut(filled: string, returned: string): string {
  return `${formatUsdc(filled)} cashed out; ${formatUsdc(returned)} returned`;
}

/** Plain decimal USDC for an input field (no grouping), e.g. "25" or "1.5". */
export function usdcDecimal(atomic: string): string {
  const v = atomic.padStart(USDC_DECIMALS + 1, "0");
  const whole = v.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, "");
  const fraction = v.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** An approximate fiat amount, always prefixed so it never reads as exact. */
export function formatEstimate(atomic: string, currency: string, decimals: number): string {
  return `about ${formatTokenAmount(BigInt(atomic), decimals, 2)} ${currency}`;
}

/** Why an amount is over the deployment's per-cash-out canary cap, if it is. */
export function canaryCapError(
  amount: string | undefined,
  cap: string | undefined,
): string | undefined {
  if (amount === undefined || cap === undefined || BigInt(amount) <= BigInt(cap)) return undefined;
  return `This deployment limits each cash-out to ${formatUsdc(cap)} for now. Enter ${formatUsdc(cap)} or less.`;
}

/** Bounded own-account handle: the same limits S5's `setOwnAccount` enforces. */
export function payeeError(value: string): string | undefined {
  const v = value.trim();
  if (v === "") return "Enter the account the payout goes to.";
  if (v.length > 256) return "That account is too long.";
  if (/[\u0000-\u001f\u007f]/.test(v)) return "Remove control characters from the account.";
  return undefined;
}

/** Shown after entry: enough to recognise the account, never the whole handle. */
export function maskPayee(value: string): string {
  const v = value.trim();
  const chars = [...v];
  if (chars.length <= 4) return "•".repeat(Math.max(chars.length, 4));
  return `${chars.slice(0, 2).join("")}${"•".repeat(4)}${chars.slice(-2).join("")}`;
}

/** Seconds left on an estimate, 0 once stale. A stale estimate cannot be submitted. */
export function estimateSecondsLeft(preview: Pick<RampPreview, "expires_at">, now: number): number {
  const at = Date.parse(preview.expires_at);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/** Every disclosure the preview carries; the user accepts all of them or nothing. */
export function disclosureCodes(preview: Pick<RampPreview, "disclosures">): string[] {
  const d = preview.disclosures;
  return [...d.public_state, ...d.identity_visible_to, ...d.liveness_dependencies];
}

export type ProgressStepId = "deposit" | "awaiting_buyer" | "matched" | "delivering" | "delivered";

export interface ProgressStep {
  id: ProgressStepId;
  label: string;
  state: "done" | "current" | "upcoming";
}

const STEP_LABELS: Record<ProgressStepId, string> = {
  deposit: "Deposit created on Base",
  awaiting_buyer: "Awaiting a buyer",
  matched: "Matched with a buyer",
  delivering: "Payout in progress",
  delivered: "Payout delivered",
};

const ORDER: ProgressStepId[] = ["deposit", "awaiting_buyer", "matched", "delivering", "delivered"];

/** The forward path. `returned` is shown beside it, not as a step on it. */
export function progressSteps(phase: MakerPhase | undefined): ProgressStep[] {
  const at =
    phase === undefined || phase === "returned" ? -1 : ORDER.indexOf(phase as ProgressStepId);
  return ORDER.map((id, i) => ({
    id,
    label: STEP_LABELS[id],
    state:
      phase === "delivered" || i < at || (id === "deposit" && phase !== undefined)
        ? "done"
        : i === at
          ? "current"
          : "upcoming",
  }));
}

export interface OrderHeadline {
  title: string;
  detail: string;
  tone: "progress" | "done" | "attention";
}

/** One sentence for where the order is, from the phase and the leg state only. */
export function orderHeadline(
  snapshot: RampSnapshot,
  phase: MakerPhase | undefined,
  reason: MakerReason | undefined,
): OrderHeadline {
  const leg = snapshot.peer;
  if (leg.state === "in_doubt")
    return {
      title: "Checking with Base",
      detail:
        "The last wallet step's outcome is not confirmed yet. Only a status check can settle it; nothing will be sent again.",
      tone: "attention",
    };
  if (snapshot.terminal && leg.partial_result)
    return {
      title: "Partly cashed out and returned",
      detail: formatMixedCashOut(
        leg.partial_result.filled_atomic,
        leg.partial_result.returned_atomic,
      ),
      tone: "done",
    };
  if (phase === "delivered")
    return {
      title: "Payout delivered",
      detail: "Peer verified the fiat payment for all of your USDC. The order is closed.",
      tone: "done",
    };
  if (phase === "returned")
    return {
      title: "Returned to your wallet",
      detail:
        "Unmatched USDC was withdrawn back to your wallet. Any part already paid out stays paid out.",
      tone: "done",
    };
  if (phase === "delivering")
    return {
      title: "Partly paid out",
      detail:
        "Peer verified a fiat payment for part of your USDC. The rest is still open for buyers or can be withdrawn.",
      tone: "progress",
    };
  if (phase === "matched")
    return {
      title: "Matched with a buyer",
      detail:
        "A buyer has reserved part of the deposit and must now pay your account. Peer releases USDC only after it verifies that payment.",
      tone: "progress",
    };
  if (phase === "awaiting_buyer")
    return {
      title: "Awaiting a buyer",
      detail:
        "Your USDC is in Peer’s holding contract on Base. Payments can arrive later and in parts.",
      tone: "progress",
    };
  if (leg.state === "failed")
    return {
      title: "This step did not go through",
      detail: failureText(leg.failure_code, reason),
      tone: "attention",
    };
  return {
    title: "Wallet approval needed",
    detail: "Review the next step in your wallet.",
    tone: "progress",
  };
}

function failureText(code: string | undefined, reason: MakerReason | undefined): string {
  if (reason === "active_intent_blocks_withdrawal")
    return "A buyer is mid-payment, so the whole deposit cannot be withdrawn now. You can withdraw the unmatched part.";
  if (reason === "setup_required" || code === "capability_unavailable")
    return "Peer needs a setup step for your account on this rail first. No deposit was created.";
  if (reason === "quote_expired" || code === "quote_expired")
    return "The estimate expired before the wallet step. Get a new estimate; no deposit was created.";
  if (reason === "quote_changed" || code === "quote_changed")
    return "Peer's terms changed. Review a new estimate; no deposit was created.";
  if (code === "approval_rejected") return "You declined in your wallet. Nothing was sent.";
  return "Peer declined this step. Nothing new was sent from your wallet.";
}

export const WALLET_ACTION_LABELS: Record<MakerWalletAction, string> = {
  approve_usdc: "Allow Peer's escrow to use exactly this USDC",
  create_deposit: "Create the cash-out deposit on Base",
  withdraw_unmatched: "Withdraw unmatched USDC to your wallet",
};

/** Phases where unmatched USDC may still be in escrow. */
export function canWithdraw(snapshot: RampSnapshot, phase: MakerPhase | undefined): boolean {
  return (
    !snapshot.terminal &&
    snapshot.peer.state === "processing" &&
    (phase === "awaiting_buyer" || phase === "matched" || phase === "delivering")
  );
}
