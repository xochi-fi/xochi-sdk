/**
 * Property-based tests for formatRawAmount.
 *
 * Angles that do not restate the string-slicing implementation:
 *   1. Totality: never throws on any string input.
 *   2. Shape invariant: output is digits with at most 4 trimmed fractional
 *      digits and no thousands separators.
 *   3. Exact multiples render as the whole number (no spurious decimal).
 *   4. Value-preservation oracle: re-parsing the output recovers the input
 *      up to a bounded truncation error (the function truncates, never rounds
 *      up, and drops nothing beyond the 4th decimal).
 *
 * Seed fixed for reproducible CI.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatRawAmount, safeBigInt } from "./format.js";

const SEED = 0xf0a7;
const FC_SETTINGS = { seed: SEED, numRuns: 200 } as const;

describe("safeBigInt properties", () => {
  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => typeof safeBigInt(s) === "bigint"),
      FC_SETTINGS,
    );
  });

  it("round-trips any bigint through its decimal string", () => {
    fc.assert(
      fc.property(fc.bigInt(), (n) => safeBigInt(n.toString()) === n),
      FC_SETTINGS,
    );
  });

  it("falls back to 0n for fractional strings (the crash class)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n }),
        fc.integer({ min: 1, max: 9 }),
        (whole, frac) => safeBigInt(`${whole}.${frac}`) === 0n,
      ),
      FC_SETTINGS,
    );
  });
});

describe("formatRawAmount properties", () => {
  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 30 }), (s, d) => {
        return typeof formatRawAmount(s, d) === "string";
      }),
      FC_SETTINGS,
    );
  });

  // Note: trailing zeros are trimmed from the full fraction BEFORE the 4-digit
  // slice, so sub-display-precision values (e.g. 1e-5) still render as "0.0000".
  // The guaranteed shape is therefore <=4 fractional digits with no separators.
  it("emits digits with <=4 fractional places and no thousands separators", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n }), fc.integer({ min: 0, max: 18 }), (v, d) => {
        const out = formatRawAmount(v.toString(), d);
        expect(out).not.toContain(",");
        expect(out).toMatch(/^\d+(\.\d{1,4})?$/);
      }),
      FC_SETTINGS,
    );
  });

  it("renders exact multiples as the bare whole number", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 18 }),
        (n, d) => {
          const scaled = n * 10n ** BigInt(d);
          return formatRawAmount(scaled.toString(), d) === n.toString();
        },
      ),
      FC_SETTINGS,
    );
  });

  it("re-parsing the output recovers the value within the truncation bound", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n }), fc.integer({ min: 0, max: 18 }), (v, d) => {
        const out = formatRawAmount(v.toString(), d);
        const [wStr, fStr = ""] = out.split(".");
        const k = fStr.length; // 0..4, and k <= d here
        const parsedScaled =
          BigInt(wStr) * 10n ** BigInt(d) + (fStr ? BigInt(fStr) : 0n) * 10n ** BigInt(d - k);
        const diff = v - parsedScaled;
        // truncation never overshoots, and drops nothing past the 4th decimal
        return diff >= 0n && diff < 10n ** BigInt(Math.max(0, d - 4));
      }),
      FC_SETTINGS,
    );
  });
});
