// Comparison helpers shared by the value checks. Internal: not exported from the barrel.

// Read a value under its snake_case (canonical) or camelCase key, preferring snake_case.
export function pick(
  obj: Record<string, unknown> | null | undefined,
  snakeKey: string,
  camelKey: string,
): unknown {
  if (obj == null) return undefined;
  return obj[snakeKey] !== undefined ? obj[snakeKey] : obj[camelKey];
}

/**
 * Compares a quote field against a requested address-like value. Not `deposit-verify.ts`'s
 * `normalizeAddress`, and not the same rule: that one reproduces `normalize_address/1`
 * byte-for-byte because an attestation digest depends on it. Keep them apart so an edit
 * to either cannot retune the other.
 */
export function sameAddressish(a: string, b: string): boolean {
  // Case is folded only for a value that is `0x` + hex and nothing else (an EVM address,
  // or a 32-byte hex id): hex is case-insensitive, every other encoding here is not.
  // `0X` counts as the prefix, since treating `0XABC` as base58 would reject a caller's
  // own address for its capitalisation. Do not fold anything merely STARTING `0x`: a
  // Canton party id (`hint::1220<64 hex>`, spec 0.8.0) has a free-text, case-sensitive
  // hint that may itself start `0x`, so `0xAlice::1220...` and `0xalice::1220...` are
  // two parties, and a fold reads a swapped one as the requested recipient.
  const norm = (v: string) => (/^0x[0-9a-f]+$/i.test(v) ? v.toLowerCase() : v);
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
