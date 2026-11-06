// Package-internal helpers shared across modules; index.ts does not re-export them.

/** A 20-byte EVM address, `0x`-prefixed hex in any case. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `signal`, if any, bounded by `timeoutMs`: aborts on whichever fires first. */
export function bounded(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}
