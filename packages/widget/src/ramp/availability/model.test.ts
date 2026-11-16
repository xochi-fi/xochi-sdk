import { describe, expect, it } from "vitest";
import type { RampAvailability } from "@xochi/client";
import { fetchPeerCapabilities, peerConfiguration } from "../peer/index.js";
import { buildRampIntent, nextExpiry, parseRampAmount, railCard } from "./model.js";
import { RECORDED_AT, recordedReads } from "../../test/rampPort.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const settlement = peerConfiguration().settlement;

async function wiseOffer() {
  const intent = buildRampIntent({
    direction: "onramp",
    amount: "25000000",
    currency: "USD",
    recipient: ACCOUNT,
    settlement,
  });
  const clock = { t: RECORDED_AT };
  const result = await fetchPeerCapabilities(intent, {
    user: ACCOUNT,
    reads: recordedReads({ account: ACCOUNT, clock }),
    now: () => clock.t,
  });
  return { intent, offer: result.offers.find((o) => o.rail.id === "wise")! };
}

describe("parseRampAmount", () => {
  it.each([
    ["25", "25000000"],
    ["0.5", "500000"],
    ["007.000001", "7000001"],
    ["12345678901234567890", "12345678901234567890000000"],
  ])("reads %s exactly as %s", (input, atomic) => {
    expect(parseRampAmount(input)).toBe(atomic);
  });
  it.each(["", "0", "0.000000", "-1", "1e6", "1.0000001", "1,5", " ", "0x10", "Infinity"])(
    "refuses %j",
    (input) => {
      expect(parseRampAmount(input)).toBeUndefined();
    },
  );
});

describe("railCard", () => {
  it("is selectable only while checkRampOffer accepts the fresh offer", async () => {
    const { intent, offer } = await wiseOffer();
    expect(railCard(offer, intent, settlement, RECORDED_AT).selectable).toBe(true);
    const until = Date.parse((offer.availability as { valid_until: string }).valid_until);
    expect(nextExpiry([offer], RECORDED_AT)).toBe(until);
    const late = railCard(offer, intent, settlement, until);
    expect(late).toMatchObject({ selectable: false, state: "expired" });
    // Another amount is not proven by this quote.
    const other = {
      ...intent,
      exact: { ...intent.exact, money: { ...intent.exact.money, atomic: "26000000" } },
    };
    expect(railCard(offer, other as typeof intent, settlement, RECORDED_AT).selectable).toBe(false);
  });

  it.each<RampAvailability>([
    { state: "setup_required", requirement_codes: ["peer_dispute_stake"] },
    { state: "setup_required", requirement_codes: ["some_new_requirement"] },
    { state: "temporarily_unavailable", reason_code: "capability_unavailable" },
    { state: "not_supported", reason_code: "capability_unavailable" },
    { state: "availability_unknown", reason_code: "brand_new_code" },
  ])("never makes $state selectable and always says why", async (availability) => {
    const { intent, offer } = await wiseOffer();
    const card = railCard({ ...offer, availability }, intent, settlement, RECORDED_AT);
    expect(card.selectable).toBe(false);
    expect(card.state).toBe(availability.state);
    expect(card.reason.length).toBeGreaterThan(10);
    expect(card.next?.length).toBeGreaterThan(10);
  });
});
