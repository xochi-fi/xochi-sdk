// The quote/execute contract on the Canton escrow corridor (SPEC.md §3.3, §5.2.1):
// a party echo and the escrow envelope parse; EVM and Tron echoes are unchanged.

import { describe, expect, it } from "vitest";
import { ExecuteResponseSchema, QuoteResponseSchema } from "./schemas.js";

const PARTY = "user_5ABd4A02::1220e610231e7aef0de077733b3afb8a413f6784c8f2bb5c6607d311d3ddad2c3f4d";
const ESCROW = {
  address: "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb",
  order_id: `0x${"ab".repeat(32)}`,
  fill_deadline: "1790000000",
  order_terms: { escrow: "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb" },
  dest_opening: { recipient: PARTY },
  open_auth: { expiry: "1790000000", signature: "0x01" },
};
const quote = (over: Record<string, unknown>) => ({
  success: true,
  intent_id: "xi_1",
  quote_id: "q_1",
  can_solve: true,
  expiry: "2026-11-13T00:00:00.000Z",
  ...over,
});

describe("QuoteResponseSchema on the Canton corridor", () => {
  it("parses a party echo with the escrow envelope and refundable_at", () => {
    const parsed = QuoteResponseSchema.safeParse(
      quote({ recipient_address: PARTY, escrow: ESCROW, refundable_at: 1790014400 }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.recipient_address).toBe(PARTY);
  });

  it("refuses a case-folded or padded party echo", () => {
    for (const echo of [PARTY.toUpperCase(), ` ${PARTY}`]) {
      expect(QuoteResponseSchema.safeParse(quote({ recipient_address: echo })).success).toBe(false);
    }
  });

  it("leaves EVM and Tron echoes and escrow-off quotes unchanged", () => {
    for (const recipient_address of [
      "0x1111111111111111111111111111111111111111",
      "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    ]) {
      expect(QuoteResponseSchema.safeParse(quote({ recipient_address })).success).toBe(true);
    }
    expect(QuoteResponseSchema.safeParse(quote({ escrow: null })).success).toBe(true);
    expect(QuoteResponseSchema.safeParse(quote({})).success).toBe(true);
  });

  it("refuses an envelope without its order id", () => {
    const { order_id: _orderId, ...broken } = ESCROW;
    expect(QuoteResponseSchema.safeParse(quote({ escrow: broken })).success).toBe(false);
  });
});

describe("ExecuteResponseSchema on the Canton corridor", () => {
  it("parses the escrow envelope and refundable_at", () => {
    expect(
      ExecuteResponseSchema.safeParse({
        success: true,
        intent_id: "xi_1",
        status: "executing",
        escrow: ESCROW,
        refundable_at: 1790014400,
      }).success,
    ).toBe(true);
  });
});
