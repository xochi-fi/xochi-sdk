import { describe, it, expect } from "vitest";
import { parseUint } from "@xochi/signer";

describe("parseUint", () => {
  it.each([
    [0n, 0n],
    [7, 7n],
    ["0", 0n],
    ["7", 7n],
    ["18446744073709551616", 2n ** 64n],
    [2n ** 300n, 2n ** 300n],
  ] as const)("accepts %s", (value, expected) => {
    expect(parseUint(value, "x")).toBe(expected);
  });

  it.each(["", "0x10", " 7", "7 ", "+7", "-0", "-1", "1e3", "1.0", "007", -1, -1n, 1.5, 2 ** 53])(
    "refuses %s, naming the field",
    (value) => {
      expect(() => parseUint(value, "amount")).toThrow(
        /^amount must be a non-negative base-10 integer/,
      );
    },
  );

  it("accepts leading zeros only when asked", () => {
    expect(parseUint("007", "x", { allowLeadingZeros: true })).toBe(7n);
    expect(() => parseUint(" 7", "x", { allowLeadingZeros: true })).toThrow(/x must be/);
  });
});
