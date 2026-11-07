// Unsigned-integer inputs: the spelling rule for every `UintLike` the signer hashes or signs
// (XSP, escrow, shielded). XSP and shielded refuse leading zeros; escrow admits them, as
// Riddler's feed does. ERC-4337 quantities (`erc4337.ts`) and escrow pin keys
// (`escrow-pin.ts`) also take 0x hex and keep their own parsers.
// The index re-exports `UintLike` and `parseUint`.

export type UintLike = bigint | number | string;

export const UINT32_MAX = 2n ** 32n - 1n;
export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT256_MAX = 2n ** 256n - 1n;

/**
 * The integer `value` spells, or `undefined` when it is not an accepted spelling: a bigint,
 * a safe-integer number (either sign; callers range-check), or a base-10 digit string with
 * no sign, whitespace, prefix or exponent. `BigInt` alone would read `""` as 0, `"0x10"` as
 * 16 and `" 7"` as 7. Leading zeros are refused unless `allowLeadingZeros`.
 */
export function uintSpelling(value: unknown, allowLeadingZeros = false): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== "string") return undefined;
  return (allowLeadingZeros ? /^[0-9]+$/ : /^(0|[1-9][0-9]*)$/).test(value)
    ? BigInt(value)
    : undefined;
}

/**
 * Strictly parses an unsigned integer: a non-negative bigint, a non-negative safe-integer
 * number, or a canonical base-10 string (no sign, whitespace, `0x`, exponent or, unless
 * `allowLeadingZeros`, leading zero). No upper bound; callers check their type's range.
 * Throws an `Error` naming `field`.
 */
export function parseUint(
  value: UintLike,
  field: string,
  opts: { allowLeadingZeros?: boolean } = {},
): bigint {
  const v = uintSpelling(value, opts.allowLeadingZeros);
  if (v === undefined || v < 0n) {
    throw new Error(
      `${field} must be a non-negative base-10 integer, got ${JSON.stringify(String(value))}`,
    );
  }
  return v;
}
