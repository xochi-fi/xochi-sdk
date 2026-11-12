// The byte forms the CLI has always written: records as two-space JSON plus a newline (its
// `writePrivateJson`), the first operation lock write as one compact line plus a newline.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function prettyJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function compactJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
