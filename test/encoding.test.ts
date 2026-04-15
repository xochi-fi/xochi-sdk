/**
 * Encoding unit tests.
 */

import { describe, it, expect } from "vitest";
import { encodePublicInputs, decodePublicInputs, encodeProof } from "../src/encoding.js";

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
});
