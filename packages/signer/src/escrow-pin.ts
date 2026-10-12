// The one reading of a caller's escrow pin ({@link PinnedEscrows}), shared by
// `assertEscrowBinding` and the pull guard in `intent-verify.ts` so the two can
// never disagree about which chain a key names or which address it pins. Not
// re-exported from the barrel: it is the semantics of `expectedEscrows`, not an
// API of its own.

import type { PinnedEscrows } from "./escrow";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const CHAIN_KEY = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

// A pin key is a positive chain id spelled in decimal (leading zeros allowed)
// or `0x` hex, surrounded by optional whitespace: `"8453"`, `"08453"`,
// `"0x2105"` and `" 8453 "` all name chain 8453, the same spellings the chain
// checks accept for the intent's own `fromChainId`. Anything else -- `""`,
// `"1e3"`, `"-8453"`, `"0"`, `"__proto__"` -- names no chain and returns null.
function chainIdOfKey(key: string): bigint | null {
  const trimmed = key.trim();
  if (!CHAIN_KEY.test(trimmed)) return null;
  const id = BigInt(trimmed);
  return id > 0n ? id : null;
}

/**
 * The escrow pinned for `chainId`, or `undefined` when no key names that chain.
 *
 * Every key is canonicalized and a key that is not a chain id refuses the whole pin
 * (a pin the caller cannot have meant is a misconfiguration, not a hole to read past).
 * Every value for the chain is trimmed (pins come from config files and env vars) and
 * must be a non-zero EVM address; when several keys name the chain they must all pin
 * the same address, case-insensitively, or the pin refuses rather than picks one.
 * `pin` must already be a non-null, non-array object; what an absent pin means is the
 * caller's call. `fail` builds the error the caller throws.
 */
export function resolvePinnedEscrow(
  pin: PinnedEscrows,
  chainId: bigint | number,
  fail: (message: string) => Error,
): string | undefined {
  const chain = BigInt(chainId);
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(pin as Record<string, unknown>)) {
    const id = chainIdOfKey(key);
    if (id === null) {
      throw fail(
        `expectedEscrows key ${JSON.stringify(key)} is not a positive chain id (decimal or 0x hex)`,
      );
    }
    if (id === chain) values.push(value);
  }
  if (values.length === 0) return undefined;

  const trimmed: string[] = [];
  for (const value of values) {
    const v = typeof value === "string" ? value.trim() : value;
    if (typeof v !== "string" || !EVM_ADDRESS.test(v) || ZERO_ADDRESS.test(v)) {
      throw fail(
        `pinned escrow for origin chain ${chain} is not a non-zero EVM address: ${JSON.stringify(value)}`,
      );
    }
    trimmed.push(v);
  }
  const first = trimmed[0]!;
  if (trimmed.some((v) => v.toLowerCase() !== first.toLowerCase())) {
    throw fail(
      `expectedEscrows names origin chain ${chain} under ${values.length} keys with different ` +
        `escrows (${JSON.stringify(values)}); refusing to pick one`,
    );
  }
  return first;
}
