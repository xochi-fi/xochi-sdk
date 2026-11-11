// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import {
  ReferralEarningsResponseSchema,
  type ReferralEarningsResponseWire,
} from "./referralEarnings.js";

/**
 * A `GET /api/referrals/earnings` body that satisfies the server contract
 * (ReferralEarningsResponseSchema, xochi-fi/xochi#615): two shown codes, one
 * live and one expired, a seven-day holdback. Shared by the unit and page tests;
 * typed against the server's published schema so the two cannot drift silently.
 */
const EARNINGS_FIXTURE: ReferralEarningsResponseWire = {
  as_of: "2026-10-10T00:00:00.000Z",
  holdback_seconds: 604_800,
  min_active_wallets: 5,
  codes: [
    {
      code: "ACME",
      display_name: "Acme Wallet",
      status: "live",
      withheld: false,
      referred_volume_usd: "125430.50",
      earnings_usd: {
        pending: "12.40",
        held: "38.75",
        claimable: "102.10",
        claimed: "0.00",
        reversed: "4.05",
      },
      active_referred_wallets: 37,
    },
    {
      code: "ACME-2025",
      display_name: "Acme (2025 campaign)",
      status: "expired",
      withheld: false,
      referred_volume_usd: "9870.00",
      earnings_usd: {
        pending: "0.00",
        held: "0.00",
        claimable: "21.60",
        claimed: "0.00",
        reversed: "0.00",
      },
      active_referred_wallets: 8,
    },
  ],
};

/**
 * One shown code and one below `min_active_wallets`, whose figures the server
 * withholds as nulls.
 */
const MIXED_EARNINGS_FIXTURE: ReferralEarningsResponseWire = {
  ...EARNINGS_FIXTURE,
  codes: [
    EARNINGS_FIXTURE.codes[0],
    {
      code: "ACME-PILOT",
      display_name: "Acme (pilot)",
      status: "live",
      withheld: true,
      referred_volume_usd: null,
      earnings_usd: null,
      active_referred_wallets: null,
    },
  ],
};

describe("ReferralEarningsResponseSchema", () => {
  it("accepts the contract fixture", () => {
    expect(ReferralEarningsResponseSchema.safeParse(EARNINGS_FIXTURE).success).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    const body = { ...EARNINGS_FIXTURE, referred_wallets: ["0x" + "ab".repeat(20)] };
    expect(ReferralEarningsResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects an unknown per-code field", () => {
    const [first, second] = EARNINGS_FIXTURE.codes;
    const body = { ...EARNINGS_FIXTURE, codes: [{ ...first, last_trade_at: "x" }, second] };
    expect(ReferralEarningsResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a USD amount that is not two-decimal dollars", () => {
    const [first] = EARNINGS_FIXTURE.codes;
    const body = {
      ...EARNINGS_FIXTURE,
      codes: [{ ...first, earnings_usd: { ...first.earnings_usd, held: "38.7" } }],
    };
    expect(ReferralEarningsResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects an unknown code status", () => {
    const [first] = EARNINGS_FIXTURE.codes;
    const body = { ...EARNINGS_FIXTURE, codes: [{ ...first, status: "paused" }] };
    expect(ReferralEarningsResponseSchema.safeParse(body).success).toBe(false);
  });

  it("accepts null figures on a withheld code", () => {
    expect(ReferralEarningsResponseSchema.safeParse(MIXED_EARNINGS_FIXTURE).success).toBe(true);
  });

  it("accepts nulls only when withheld", () => {
    const [shown, withheld] = MIXED_EARNINGS_FIXTURE.codes;
    const parse = (code: object) =>
      ReferralEarningsResponseSchema.safeParse({ ...MIXED_EARNINGS_FIXTURE, codes: [code] })
        .success;
    for (const field of ["referred_volume_usd", "earnings_usd", "active_referred_wallets"]) {
      expect(parse({ ...shown, [field]: null }), field).toBe(false);
    }
    // A withheld code must carry no figures at all.
    expect(parse({ ...withheld, referred_volume_usd: "1.00" })).toBe(false);
    expect(parse({ ...withheld, active_referred_wallets: 2 })).toBe(false);
    // Withheld is required, and the minimum is required at the top level.
    const { withheld: _omit, ...unflagged } = shown;
    expect(parse(unflagged)).toBe(false);
    const { min_active_wallets: _min, ...noMin } = MIXED_EARNINGS_FIXTURE;
    expect(ReferralEarningsResponseSchema.safeParse(noMin).success).toBe(false);
  });
});
