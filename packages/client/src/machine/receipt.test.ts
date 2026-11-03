import { describe, expect, it } from "vitest";
import { destinationDisclosure, settlementDisclosure } from "./receipt.js";

describe("settlement disclosures", () => {
  it.each([
    ["public", "Public"],
    ["stealth", "Stealth"],
    ["shielded", "Shielded"],
  ] as const)("names %s settlement without host-owned copy", (mode, label) => {
    expect(settlementDisclosure(mode).label).toBe(label);
  });

  it("describes non-shielded Aztec destinations as stealth", () => {
    expect(destinationDisclosure({ type: "aztec", shielded: false })).toEqual(
      settlementDisclosure("stealth"),
    );
  });

  it("describes only explicitly shielded Aztec destinations as shielded", () => {
    expect(destinationDisclosure({ type: "aztec", shielded: true })).toEqual(
      settlementDisclosure("shielded"),
    );
  });

  it("preserves public and L1 stealth destination semantics", () => {
    expect(destinationDisclosure({ type: "chain", shielded: true })).toEqual(
      settlementDisclosure("public"),
    );
    expect(destinationDisclosure({ type: "stealth", shielded: false })).toEqual(
      settlementDisclosure("stealth"),
    );
  });
});
