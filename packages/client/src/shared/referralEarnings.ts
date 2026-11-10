// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { z } from "zod";
import { REFERRAL_CODE_REGEX } from "./schemas.js";

/** US dollars as a decimal string with exactly two fractional digits. */
const usdCentsAmount = z
  .string()
  .regex(/^\d+\.\d{2}$/)
  .describe("US dollars, two fractional digits, rounded down to the cent.");

/**
 * One referral code's aggregates on `GET /api/referrals/earnings` (xochi#601).
 * Aggregates ONLY, and only as of the response's `as_of`: no wallet address,
 * per-trade amount, route or time is ever served to an affiliate (referral
 * design xochi#599, section 8). A code with fewer active referred wallets than
 * the response's `min_active_wallets` is `withheld`: listed, with every figure
 * null, because a total over one or two wallets is close to a per-trade read.
 */
const referralCodeIdentity = {
  code: z.string().regex(REFERRAL_CODE_REGEX),
  display_name: z.string().describe("Rendered as `Referral: {display_name}` on quotes."),
  status: z
    .enum(["live", "expired", "revoked"])
    .describe("Whether the code still applies to new quotes. Earnings stay listed either way."),
};

export const ReferralCodeEarningsSchema = z.discriminatedUnion("withheld", [
  z
    .object({
      ...referralCodeIdentity,
      withheld: z.literal(false),
      referred_volume_usd: usdCentsAmount.describe(
        "Notional of the referred trades that had completed by `as_of` (earnings held, claimable or claimed), in US dollars at each executed quote's served rate.",
      ),
      earnings_usd: z
        .object({
          pending: usdCentsAmount.describe("Trades executed and not yet settled."),
          held: usdCentsAmount.describe("Settled, inside the holdback window."),
          claimable: usdCentsAmount.describe("Past the holdback. Claims are not live yet."),
          claimed: usdCentsAmount.describe("Paid out."),
          reversed: usdCentsAmount.describe(
            "Not owed: the referred trade failed, was refunded or expired.",
          ),
        })
        .strict()
        .describe(
          "The affiliate's share of the routing fee layer by ledger state as of `as_of`, in US dollars at each executed quote's served rate (fixed when the trade executed, never re-priced).",
        ),
      active_referred_wallets: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Distinct wallets with at least one completed (held, claimable or claimed) referred trade of at least $100 notional in the 30 days before `as_of`. A count only, never below `min_active_wallets`.",
        ),
    })
    .strict(),
  z
    .object({
      ...referralCodeIdentity,
      withheld: z
        .literal(true)
        .describe(
          "Fewer than `min_active_wallets` active referred wallets as of `as_of`: every figure is withheld (null), including the wallet count.",
        ),
      referred_volume_usd: z.null(),
      earnings_usd: z.null(),
      active_referred_wallets: z.null(),
    })
    .strict(),
]);
export type ReferralCodeEarningsWire = z.infer<typeof ReferralCodeEarningsSchema>;

/**
 * `GET /api/referrals/earnings` (xochi#601): the session wallet's earnings per
 * referral code it is (or was) the affiliate of.
 */
export const ReferralEarningsResponseSchema = z
  .object({
    as_of: z
      .string()
      .datetime()
      .describe(
        "ISO 8601 UTC. The figures are a snapshot at this instant, the start of the current UTC day; nothing after it is counted until the next snapshot. Live totals are withheld so that comparing two reads cannot reveal a single trade's amount or time.",
      ),
    holdback_seconds: z
      .number()
      .int()
      .nonnegative()
      .describe("How long a settled earning is held before it becomes claimable."),
    min_active_wallets: z
      .number()
      .int()
      .positive()
      .describe(
        "A code's figures are served only when it has at least this many active referred wallets as of `as_of`; below it the code is listed with `withheld: true`.",
      ),
    codes: z.array(ReferralCodeEarningsSchema),
  })
  .strict();
export type ReferralEarningsResponseWire = z.infer<typeof ReferralEarningsResponseSchema>;
