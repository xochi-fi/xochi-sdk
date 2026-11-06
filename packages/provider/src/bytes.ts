// Byte-array guards for key and replay material. INTERNAL: not re-exported from `index.ts`.

/** Any 1-byte-element typed array (Uint8Array, Uint8ClampedArray, Int8Array), from any realm. */
export function isByteArray(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) return false;
  const view = value as ArrayBufferView & { readonly BYTES_PER_ELEMENT?: unknown };
  return view.BYTES_PER_ELEMENT === 1;
}

/** A fresh Uint8Array holding `value`'s bytes, never a view of the caller's buffer. */
export function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  for (let index = 0; index < value.byteLength; index += 1) {
    copy[index] = value[index];
  }
  return copy;
}
