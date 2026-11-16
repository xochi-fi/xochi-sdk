import { describe, expect, it } from "vitest";
import { atomic, type RampIntent, type RampOffer } from "./ramp.js";
import { checkRampOffer, sameRampAsset, validateRampSettlement } from "./rampDiscovery.js";
const crypto = {
  kind: "crypto",
  chain_id: "eip155:8453",
  asset_id: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  decimals: 6,
} as const;
const fiat = { kind: "fiat", currency: "USD", decimals: 6 } as const;
const now = Date.parse("2026-11-16T12:00:00.000Z");
function intent(): RampIntent {
  return {
    contract_version: "ramp/1",
    kind: "intent",
    direction: "onramp",
    fiat,
    crypto,
    exact: { side: "crypto", money: { asset: crypto, atomic: atomic("25000000") } },
    recipient: "0x000000000000000000000000000000000000dEaD",
  };
}
function offer(): RampOffer {
  return {
    contract_version: "ramp/1",
    kind: "offer",
    provider_id: "peer",
    direction: "onramp",
    offer_id: "offer",
    capability_revision: "revision",
    fiat,
    crypto,
    rail: { id: "wise", label: "Wise" },
    bounds: {
      measured_in: "crypto",
      minimum: { asset: crypto, atomic: atomic("10000000") },
      maximum: { asset: crypto, atomic: atomic("30000000") },
    },
    interaction: { presentation: "popup", requirement_codes: [] },
    availability: { state: "available", valid_until: "2026-11-16T12:00:30.000Z" },
    observed_at: "2026-11-16T12:00:00.000Z",
    disclosures: { public_state: [], identity_visible_to: [], liveness_dependencies: [] },
  };
}
describe("provider-neutral offer selection", () => {
  it("accepts exact corridor and inclusive bounds", () => {
    for (const amount of ["10000000", "25000000", "30000000"]) {
      const i = intent();
      i.exact.money.atomic = atomic(amount);
      expect(checkRampOffer(offer(), i, crypto, now).ok).toBe(true);
    }
  });
  it.each([
    "available",
    "setup_required",
    "temporarily_unavailable",
    "availability_unknown",
    "not_supported",
  ])("only available can select: %s", (state) => {
    const o = offer();
    o.availability =
      state === "available"
        ? o.availability
        : state === "setup_required"
          ? { state, requirement_codes: ["setup"] }
          : { state: state as "availability_unknown", reason_code: "unproven" };
    expect(checkRampOffer(o, intent(), crypto, now).ok).toBe(state === "available");
  });
  it("rejects amounts with trailing line terminators", () => {
    const i = intent();
    i.exact.money.atomic = "25000000\n" as typeof i.exact.money.atomic;
    expect(checkRampOffer(offer(), i, crypto, now)).toEqual({ ok: false, code: "invalid_request" });
  });
  it("expires at the exact deadline", () => {
    expect(checkRampOffer(offer(), intent(), crypto, now + 30_000)).toEqual({
      ok: false,
      code: "quote_expired",
    });
  });
  it("rejects wrong direction, amount, currency, precision and unquoted side", () => {
    const cases: RampIntent[] = [];
    let i = intent();
    i.direction = "offramp";
    cases.push(i);
    i = intent();
    i.exact.money.atomic = atomic("30000001");
    cases.push(i);
    i = intent();
    i.fiat = { ...fiat, currency: "EUR" };
    cases.push(i);
    i = intent();
    i.crypto = { ...crypto, decimals: 18 };
    cases.push(i);
    i = intent();
    i.exact = { side: "fiat", money: { asset: fiat, atomic: atomic("25") } };
    cases.push(i);
    for (const request of cases)
      expect(checkRampOffer(offer(), request, crypto, now).ok).toBe(false);
  });
  it("never trusts the symbol for Base USDC identity", () => {
    expect(
      validateRampSettlement({ ...crypto, asset_id: "0x0000000000000000000000000000000000000001" }),
    ).toBeUndefined();
    expect(validateRampSettlement({ ...crypto, chain_id: "eip155:1" })).toBeUndefined();
    expect(
      validateRampSettlement({ ...crypto, asset_id: `eip155:1/erc20:${crypto.asset_id}` }),
    ).toBeUndefined();
    expect(validateRampSettlement({ ...crypto, decimals: 18 })).toBeUndefined();
    expect(sameRampAsset(crypto, { ...crypto, symbol: "OTHER" })).toBe(true);
    expect(
      validateRampSettlement({ ...crypto, asset_id: `eip155:8453/erc20:${crypto.asset_id}` }),
    ).toBeDefined();
  });
  it("rejects future observations, malformed input and contradictory bounds", () => {
    const o = offer();
    o.observed_at = "2026-11-16T12:00:01.000Z";
    expect(checkRampOffer(o, intent(), crypto, now).ok).toBe(false);
    expect(checkRampOffer({}, intent(), crypto, now).ok).toBe(false);
    o.bounds.minimum.atomic = atomic("40000000");
    expect(checkRampOffer(o, intent(), crypto, now).ok).toBe(false);
    expect(checkRampOffer(offer(), intent(), crypto, NaN).ok).toBe(false);
  });
});
