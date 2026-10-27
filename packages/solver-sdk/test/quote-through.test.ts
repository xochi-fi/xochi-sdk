// Quote-through announcements and capabilities (SOLVER-RFC §2.5, Riddler
// #1193): the two announcement keys travel together, and a venue that does
// not send them parses exactly as before.
import { describe, it, expect } from "vitest";
import { IntentAnnouncementSchema, VenueCapabilitiesSchema } from "../src/schema";

const base = {
  intentId: "xi_1",
  auctionId: "au_1",
  orderId: "0x" + "ab".repeat(32),
  fromChainId: 84532,
  toChainId: 4149314359,
  fromToken: "USDC",
  toToken: "CC",
  swapKind: "exact_input",
  fromAmount: "100000000",
  settlementPreference: "public",
  minOutput: "995000",
  opensAt: 1_000,
  closesAt: 1_300,
  exclusiveWindowMs: 5_000,
};

describe("IntentAnnouncementSchema quote-through", () => {
  it("parses an ordinary announcement without either key", () => {
    const parsed = IntentAnnouncementSchema.parse(base);
    expect(parsed.quoteThrough).toBeUndefined();
    expect(parsed.minValidUntilMs).toBeUndefined();
  });

  it("parses a quote-through announcement with its horizon", () => {
    const parsed = IntentAnnouncementSchema.parse({
      ...base,
      quoteThrough: true,
      minValidUntilMs: 61_300,
    });
    expect(parsed.quoteThrough).toBe(true);
    expect(parsed.minValidUntilMs).toBe(61_300);
  });

  it("refuses one key without the other", () => {
    expect(IntentAnnouncementSchema.safeParse({ ...base, quoteThrough: true }).success).toBe(false);
    expect(IntentAnnouncementSchema.safeParse({ ...base, minValidUntilMs: 61_300 }).success).toBe(
      false,
    );
  });
});

describe("VenueCapabilitiesSchema quote-through", () => {
  it("reads the corridor list when the venue publishes one", () => {
    const parsed = VenueCapabilitiesSchema.parse({
      rfcVersion: "0.6.0-draft",
      quoteThrough: {
        settleRule: "second_price",
        quoteTtlSeconds: 60,
        corridors: [{ fromChainId: 84532, toChainId: 4149314359 }],
      },
    });
    expect(parsed.quoteThrough?.corridors?.[0]?.toChainId).toBe(4149314359);
  });

  it("is optional", () => {
    expect(
      VenueCapabilitiesSchema.parse({ rfcVersion: "0.6.0-draft" }).quoteThrough,
    ).toBeUndefined();
  });
});
