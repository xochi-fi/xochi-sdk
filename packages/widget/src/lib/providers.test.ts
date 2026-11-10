import { describe, it, expect } from "vitest";
import { CATEGORY_MAX } from "@xochi/client";
import { PROVIDERS } from "./providers.js";

// Pins PROVIDERS to the June 2026 audit (docs/legal/provider-audit-2026-06.md
// Point Change Summary + Naming Changes). Update both together, or this fails.
const EXPECTED: Record<string, { name: string; category: string; points: number }> = {
  humanode: { name: "Humanode", category: "humanity", points: 15 },
  idena: { name: "Idena", category: "humanity", points: 18 },
  gitcoin: { name: "Human Passport", category: "humanity", points: 18 },
  worldcoin: { name: "Worldcoin", category: "humanity", points: 8 },
  brightid: { name: "BrightID", category: "humanity", points: 10 },
  zkpassport: { name: "ZKPassport", category: "identity", points: 30 },
  polygonid: { name: "Privado ID", category: "identity", points: 32 },
  coinbase: { name: "Coinbase Verified", category: "identity", points: 25 },
  civic: { name: "Civic", category: "identity", points: 22 },
  ens: { name: "ENS", category: "reputation", points: 10 },
  lens: { name: "Lens Protocol", category: "reputation", points: 6 },
  chainalysis: { name: "Chainalysis", category: "compliance", points: 20 },
  "xochi-history": { name: "Xochi History", category: "compliance", points: 15 },
};

describe("PROVIDERS audit conformance", () => {
  it("matches the June 2026 audit names, points, and categories", () => {
    const actual = Object.fromEntries(
      PROVIDERS.map((p) => [p.id, { name: p.name, category: p.category, points: p.points }]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("keeps rebranded provider IDs for backward compatibility", () => {
    // Display names changed; database/API IDs must not.
    expect(PROVIDERS.find((p) => p.id === "gitcoin")?.name).toBe("Human Passport");
    expect(PROVIDERS.find((p) => p.id === "polygonid")?.name).toBe("Privado ID");
  });

  it("has unique ids, positive-integer points, and valid categories", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      expect(Number.isInteger(p.points) && p.points > 0).toBe(true);
      expect(p.category in CATEGORY_MAX).toBe(true);
    }
  });

  it("no single provider exceeds its category maximum", () => {
    for (const p of PROVIDERS) {
      expect(p.points).toBeLessThanOrEqual(CATEGORY_MAX[p.category]);
    }
  });
});
