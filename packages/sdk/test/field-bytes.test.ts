/**
 * Pins the sdk's private Field encoders to `@xochi/provider`'s: the sdk keeps
 * its own copies (no signer dependency), so this is what stops them drifting.
 */

import { describe, it, expect } from "vitest";
import * as provider from "@xochi/provider";
import { bytesToHex, bytesToHexField, fieldToBytes } from "../src/inputs/field-bytes.js";
import { encodeProof } from "../src/encoding.js";

const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The thrown message, or the returned value, so both outcomes compare. */
function outcome<T>(fn: () => T): { ok: T } | { err: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe("field-bytes parity with @xochi/provider", () => {
  const values: [string, bigint][] = [
    ["0", 0n],
    ["1", 1n],
    ["p - 1", BN254_P - 1n],
    ["2^256 - 1", 2n ** 256n - 1n],
    ["2^256 (overflow)", 2n ** 256n],
    ["-1 (negative)", -1n],
  ];

  it.each(values)("fieldToBytes(%s) matches", (_, v) => {
    expect(outcome(() => fieldToBytes(v))).toEqual(outcome(() => provider.fieldToBytes(v)));
  });

  it("refuses overflow and negatives", () => {
    expect(() => fieldToBytes(2n ** 256n)).toThrow(/exceeds 32 bytes/);
    expect(() => fieldToBytes(-1n)).toThrow(/non-negative/);
  });

  const byteInputs: [string, Uint8Array][] = [
    ["32 zero bytes", new Uint8Array(32)],
    ["32 0xff bytes", new Uint8Array(32).fill(0xff)],
    ["p - 1", provider.fieldToBytes(BN254_P - 1n)],
    ["31 bytes", new Uint8Array(31)],
    ["33 bytes", new Uint8Array(33)],
  ];

  it.each(byteInputs)("bytesToHexField(%s) matches", (_, b) => {
    expect(outcome(() => bytesToHexField(b))).toEqual(outcome(() => provider.bytesToHexField(b)));
  });

  it.each([new Uint8Array(0), Uint8Array.of(0, 1, 0xab), new Uint8Array(64).fill(0x0f)])(
    "bytesToHex and encodeProof match provider's bytesToHex",
    (b) => {
      expect(bytesToHex(b)).toBe(provider.bytesToHex(b));
      expect(encodeProof(b)).toBe(provider.bytesToHex(b));
    },
  );
});
