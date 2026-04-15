import type { Hex } from "viem";

/**
 * Encode publicInputs from bb.js string[] to on-chain bytes.
 * Each input is padded to 32 bytes and concatenated.
 */
export function encodePublicInputs(inputs: string[]): Hex {
  const encoded = inputs
    .map((input) => {
      const hex = input.startsWith("0x") ? input.slice(2) : input;
      return hex.padStart(64, "0");
    })
    .join("");
  return `0x${encoded}` as Hex;
}

/**
 * Decode on-chain bytes back to string[] of field elements.
 */
export function decodePublicInputs(hex: Hex): string[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const inputs: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    inputs.push("0x" + clean.slice(i, i + 64));
  }
  return inputs;
}

/**
 * Encode proof bytes to hex string.
 */
export function encodeProof(proof: Uint8Array): Hex {
  const hex = Array.from(proof)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as Hex;
}

/**
 * Normalize circuit inputs for noir_js.
 *
 * Converts mixed types to the string | string[] format Noir expects:
 * - booleans -> "0" or "1"
 * - numbers -> String(n)
 * - arrays -> array.map(String)
 * - strings -> passed through
 */
export function normalizeInputs(
  inputs: Record<string, unknown>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      result[key] = value.map(String);
    } else if (typeof value === "boolean") {
      result[key] = value ? "1" : "0";
    } else {
      result[key] = String(value);
    }
  }
  return result;
}
