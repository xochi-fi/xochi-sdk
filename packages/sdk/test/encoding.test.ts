/**
 * Encoding unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  encodePublicInputs,
  decodePublicInputs,
  encodeProof,
  normalizeInputs,
} from "../src/encoding.js";

describe("encoding", () => {
  it("encodes public inputs to 32-byte padded hex", () => {
    const inputs = ["0x01", "0xff", "0x1234"];
    const encoded = encodePublicInputs(inputs);

    expect(encoded).toMatch(/^0x/);
    // 3 fields x 64 hex chars = 192 chars + "0x" prefix
    expect(encoded.length).toBe(2 + 3 * 64);
    // First field: 0x01 padded to 32 bytes
    expect(encoded.slice(2, 66)).toBe("0".repeat(62) + "01");
    // Second field: 0xff padded to 32 bytes
    expect(encoded.slice(66, 130)).toBe("0".repeat(62) + "ff");
  });

  it("round-trips encode/decode", () => {
    const inputs = [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x00000000000000000000000000000000000000000000000000000000000000ff",
    ];
    const encoded = encodePublicInputs(inputs);
    const decoded = decodePublicInputs(encoded);
    expect(decoded).toEqual(inputs);
  });

  it("encodes proof bytes to hex", () => {
    const proof = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const encoded = encodeProof(proof);
    expect(encoded).toBe("0xdeadbeef");
  });

  it("rejects a public input wider than 32 bytes instead of misaligning the rest", () => {
    expect(() => encodePublicInputs(["0x01", `0x${"ab".repeat(33)}`])).toThrow(
      "Public input 1 must be 1-32 bytes of hex",
    );
    expect(() => encodePublicInputs(["0xzz"])).toThrow("Public input 0");
  });

  it("rejects public-input bytes that are not whole 32-byte words", () => {
    expect(() => decodePublicInputs(`0x${"00".repeat(33)}`)).toThrow("whole number of 32-byte");
  });

  it("normalizes scalars and flat arrays, rejecting nested values", () => {
    expect(normalizeInputs({ a: true, b: 7n, c: [1, false, "0x02"] })).toEqual({
      a: "1",
      b: "7",
      c: ["1", "0", "0x02"],
    });
    expect(() => normalizeInputs({ m: [[1, 2]] })).toThrow('Input "m[0]"');
    expect(() => normalizeInputs({ o: { x: 1 } })).toThrow('Input "o"');
    expect(() => normalizeInputs({ u: undefined })).toThrow('Input "u"');
  });
});
