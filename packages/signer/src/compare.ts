// Comparison helpers shared by the value checks. Internal: not exported from the barrel.

// Read a value under its snake_case (canonical) or camelCase key, preferring snake_case.
export function pick(obj: Record<string, unknown> | null | undefined, snakeKey: string, camelKey: string): unknown {
  if (obj == null) return undefined;
  return obj[snakeKey] !== undefined ? obj[snakeKey] : obj[camelKey];
}

/**
 * Compares a quote field against a requested address-like value. Not `deposit.ts`'s
 * `normalizeAddress`, despite the identical rule: that one reproduces
 * `normalize_address/1` byte-for-byte because an attestation digest depends on it. Keep
 * them apart so an edit to either cannot retune the other.
 */
export function sameAddressish(a: string, b: string): boolean {
  // `0X` counts as an EVM prefix here, unlike deposit.ts's case-sensitive `"0x" <> _`:
  // treating `0XABC` as base58 would reject a caller's own address for its capitalisation.
  const norm = (v: string) => (/^0x/i.test(v) ? v.toLowerCase() : v);
  return norm(a) === norm(b);
}

/**
 * Compares base-unit amounts and chain ids numerically, tolerating string/number. A value
 * `BigInt` cannot read is not equal to anything, including another such value. Do NOT add a
 * `String(a) === String(b)` fallback: callers read `true` as "checked and matched", and
 * `null` against `null` would then skip the chain binding on the default, pinless path.
 */
export function sameNumeric(a: unknown, b: unknown): boolean {
  try {
    return BigInt(String(a)) === BigInt(String(b));
  } catch {
    return false;
  }
}
