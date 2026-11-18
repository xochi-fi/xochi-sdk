// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  listLocalOfframps,
  parseOfframpRecord,
  resumableOfframp,
  upsertLocalOfframp,
} from "./localOfframps.js";

const mixed = {
  id: "mixed_fixture",
  type: "offramp",
  timestamp: 1,
  stage: "deposit",
  status: "mixed",
  phase: "delivered",
  totals: { filled: "60000000", returned: "40000000" },
  data: { rail: "wise", currency: "USD", amount: "100000000" },
};
beforeEach(() => window.localStorage.clear());
describe("sanitized terminal cash-out totals", () => {
  it("roundtrips only the totals and does not resume a terminal split", () => {
    const safe = parseOfframpRecord({
      ...mixed,
      totals: { ...mixed.totals, extra: "discard" },
      extra: "discard",
    })!;
    expect(safe).toEqual(mixed);
    upsertLocalOfframp("fixture_wallet", safe);
    expect(listLocalOfframps("fixture_wallet")).toEqual([mixed]);
    expect(resumableOfframp(listLocalOfframps("fixture_wallet"))).toBeUndefined();
  });
  it.each([
    undefined,
    null,
    { filled: "60000000", returned: "040000000" },
    { filled: "0", returned: "100000000" },
    { filled: "60000000", returned: "30000000" },
    { filled: "1".repeat(32), returned: "40000000" },
  ])("rejects missing or incoherent mixed totals: %j", (totals) => {
    expect(parseOfframpRecord({ ...mixed, totals })).toBeNull();
  });
  it("continues to read older terminal records without totals", () => {
    const { totals: _, ...legacy } = mixed;
    expect(parseOfframpRecord({ ...legacy, status: "returned", phase: "returned" })).not.toBeNull();
  });
});
