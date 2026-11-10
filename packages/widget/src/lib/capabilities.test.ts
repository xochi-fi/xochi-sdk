import { describe, expect, it } from "vitest";
import {
  TRON_CHAIN_ID,
  refundAddressError,
  renderableDestinationChainIds,
  servedStealthChains,
} from "@xochi/client";
import { FALLBACK_CAPABILITIES } from "./capabilities.js";

describe("fallback capability boundaries", () => {
  it("does not advertise Stealth factories", () => {
    expect(servedStealthChains(FALLBACK_CAPABILITIES)).toBeUndefined();
  });

  it("drops Tron, which only a live matrix offers", () => {
    expect(renderableDestinationChainIds(FALLBACK_CAPABILITIES, [8453, TRON_CHAIN_ID, 1])).toEqual([
      8453, 1,
    ]);
  });

  it("still validates a Tron origin refund while capabilities are unavailable", () => {
    expect(
      refundAddressError(
        "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
        TRON_CHAIN_ID,
        FALLBACK_CAPABILITIES,
      ),
    ).toBeNull();
  });
});
