// Value rules shared by the shielded encodings (`shielded.ts`, `shielded-recipient.ts`,
// `shielded-readiness.ts`): one refusal vocabulary, one parser per value kind. INTERNAL:
// the index does not re-export this module; `shielded.ts` re-exports its public names.

import { ethers } from "ethers";
import { EVM_ADDRESS } from "./primitives";
import type { Hex } from "./types";
import { UINT256_MAX, uintSpelling, type UintLike } from "./uint";

export { coder, keccak } from "./primitives";
export { UINT32_MAX, UINT64_MAX, UINT256_MAX, type UintLike } from "./uint";

/** BN254 scalar field order: every Aztec field element and address is below it. */
export const AZTEC_FIELD_MODULUS =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
/** Largest amount a shielded encoding admits: `0 < amount <= 2^128 - 1`. */
export const SHIELDED_AMOUNT_MAX = 2n ** 128n - 1n;

/**
 * Why an input is refused before anything is encoded or verified. These are ENCODING
 * refusals, not the enrollment API's refusal classes (`challenge_expired`,
 * `binding_unavailable`): a caller maps any of these to its own wire class.
 */
export type ShieldedRefusal =
  | "not_bytes32"
  | "aztec_zero"
  | "aztec_out_of_field"
  | "amount_not_canonical"
  | "amount_zero"
  | "amount_over_max"
  | "not_evm_address"
  | "evm_address_zero"
  | "uint_not_canonical"
  | "uint_out_of_range"
  | "chain_id_zero"
  | "environment_empty"
  | "digest_zero"
  | "purpose_mismatch";

/**
 * A refused input: `code` names the rule, `field` the input, `detail` the specifics. The
 * message is `${field}: ${code} (${detail})`. Each shielded module subclasses it with its
 * own closed refusal union and class name.
 */
export class RefusalError<C extends string> extends Error {
  readonly code: C;
  readonly field: string;
  readonly detail: string;
  constructor(code: C, field: string, detail: string) {
    super(`${field}: ${code} (${detail})`);
    this.code = code;
    this.field = field;
    this.detail = detail;
  }
}

type RefusalClass<C extends string> = new (code: C, field: string, detail: string) => Error;

/** A thrower for `E`'s refusals. */
export function refuser<C extends string>(
  E: RefusalClass<C>,
): (code: C, field: string, detail: string) => never {
  return (code, field, detail) => {
    throw new E(code, field, detail);
  };
}

export class ShieldedEncodingError extends RefusalError<ShieldedRefusal> {
  override name = "ShieldedEncodingError";
}

export const refuse = refuser(ShieldedEncodingError);

/** Runs `fn`, re-raising a value-rule refusal (`ShieldedEncodingError`) as `E`. */
export function withRefusalsAs<T>(fn: () => T, E: RefusalClass<ShieldedRefusal>): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof ShieldedEncodingError)) throw e;
    throw new E(e.code, e.field, e.detail);
  }
}

/**
 * An untrusted value for an error message: a string bounded to 64 characters, otherwise
 * only its kind. Never throws (a bigint breaks `JSON.stringify`) and never copies an
 * attacker-sized value into the message.
 */
export function describeUntrusted(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
  }
  return value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

export function bytes32(field: string, value: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    refuse("not_bytes32", field, `expected 0x + 64 hex, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase() as Hex;
}

/** A `bytes32` field element below the BN254 modulus; zero allowed (salt, deployer, hashes). */
export function aztecField(field: string, value: string): bigint {
  const v = BigInt(bytes32(field, value));
  if (v >= AZTEC_FIELD_MODULUS) refuse("aztec_out_of_field", field, "not below the BN254 modulus");
  return v;
}

/**
 * An Aztec `bytes32`: a nonzero field element below the BN254 modulus. Magnitude is all
 * this checks: that the value is an Aztec address and not an EVM address is established by
 * descriptor/address derivation, not by its size, so a small value is not refused.
 */
export function assertAztecBytes32(field: string, value: string): Hex {
  const hex = bytes32(field, value);
  const v = BigInt(hex);
  if (v === 0n) refuse("aztec_zero", field, "zero");
  if (v >= AZTEC_FIELD_MODULUS) refuse("aztec_out_of_field", field, "not below the BN254 modulus");
  return hex;
}

/**
 * A shielded amount as it crosses JSON (§7 `BaseUnits`): a canonical positive decimal
 * string (no sign, no leading zero, no exponent, no whitespace), `0 < x <= 2^128 - 1`.
 */
export function parseShieldedAmount(field: string, value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    refuse(
      "amount_not_canonical",
      field,
      `expected a canonical decimal, got ${JSON.stringify(value)}`,
    );
  }
  const v = BigInt(value);
  if (v === 0n) refuse("amount_zero", field, "zero");
  if (v > SHIELDED_AMOUNT_MAX) refuse("amount_over_max", field, "above 2^128 - 1");
  return v;
}

export function evmAddress(field: string, value: string): Hex {
  if (typeof value !== "string" || !EVM_ADDRESS.test(value)) {
    refuse("not_evm_address", field, `expected 0x + 40 hex, got ${JSON.stringify(value)}`);
  }
  if (BigInt(value) === 0n) refuse("evm_address_zero", field, "zero address");
  return value.toLowerCase() as Hex;
}

// Unsigned integers: a bigint, a safe integer, or a canonical decimal string.
export function uint(field: string, value: UintLike, max: bigint): bigint {
  const v = uintSpelling(value);
  if (v === undefined) {
    return refuse("uint_not_canonical", field, `got ${JSON.stringify(String(value))}`);
  }
  if (v < 0n || v > max) refuse("uint_out_of_range", field, `${v} outside [0, ${max}]`);
  return v;
}

export function chainId(field: string, value: UintLike): bigint {
  const v = uint(field, value, UINT256_MAX);
  if (v === 0n) refuse("chain_id_zero", field, "zero (no virtual-chain stand-in)");
  return v;
}

// An Aztec value typed uint256 (chain id, protocol version): nonzero and in-field.
export function aztecUint(field: string, value: UintLike): bigint {
  const v = uint(field, value, UINT256_MAX);
  if (v === 0n) refuse("aztec_zero", field, "zero");
  if (v >= AZTEC_FIELD_MODULUS) refuse("aztec_out_of_field", field, "not below the BN254 modulus");
  return v;
}

export function environmentHash(environment: string): Hex {
  if (typeof environment !== "string" || environment.length === 0) {
    refuse("environment_empty", "environment", "a domain must name its environment");
  }
  return ethers.id(environment) as Hex;
}
