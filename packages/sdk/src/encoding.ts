import type { Hex } from "viem";

/**
 * Encode publicInputs from bb.js string[] to on-chain bytes.
 * Each input is padded to 32 bytes and concatenated. Throws on an input that
 * is not hex or is wider than 32 bytes, since it would misalign every
 * following word.
 */
export function encodePublicInputs(inputs: string[]): Hex {
  const encoded = inputs
    .map((input, i) => {
      const hex = input.startsWith("0x") ? input.slice(2) : input;
      if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) {
        throw new Error(
          `Public input ${String(i)} must be 1-32 bytes of hex, got ${input.length > 70 ? `${input.slice(0, 70)}...` : input}`,
        );
      }
      return hex.padStart(64, "0");
    })
    .join("");
  return `0x${encoded}` as Hex;
}

/**
 * Decode on-chain bytes back to string[] of field elements.
 * Throws when the hex is not a whole number of 32-byte words.
 */
export function decodePublicInputs(hex: Hex): string[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{64})*$/.test(clean)) {
    throw new Error(
      `Public inputs must be a whole number of 32-byte hex words, got ${String(clean.length / 2)} bytes`,
    );
  }
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

type NoirScalar = string | number | bigint | boolean;

function isNoirScalar(value: unknown): value is NoirScalar {
  return ["string", "number", "bigint", "boolean"].includes(typeof value);
}

/**
 * Normalize circuit inputs for noir_js.
 *
 * Converts mixed types to the string | string[] format Noir expects:
 * - booleans -> "0" or "1"
 * - numbers / bigints -> String(n)
 * - arrays -> element-wise, one level deep
 * - strings -> passed through
 *
 * Throws on nested arrays, objects, null and undefined, which String() would
 * silently turn into "1,2", "[object Object]" or "undefined".
 */
export function normalizeInputs(
  inputs: Record<string, unknown>,
): Record<string, string | string[]> {
  const scalar = (key: string, value: unknown): string => {
    if (!isNoirScalar(value)) {
      throw new Error(
        `Input "${key}" must be a string, number, bigint or boolean, got ${String(value)}`,
      );
    }
    if (typeof value === "boolean") return value ? "1" : "0";
    return String(value);
  };
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(inputs)) {
    result[key] = Array.isArray(value)
      ? value.map((v, i) => scalar(`${key}[${String(i)}]`, v))
      : scalar(key, value);
  }
  return result;
}
