// A Uint8Array port of the vendored Oxide parser
// tools/recipient/src/oxide/vendor/oxide-lib/attestation/nitro_attestation/parsers.ts
// (zkmoney-public 8fd1984, MIT, Copyright (c) 2026 Aztec Labs; see that directory's VENDORED.md).
// The vendored file reads Node's global Buffer and lives outside this package, so it cannot be
// imported here; this copy keeps its control flow, its order of checks and its error messages,
// and replaces only the Buffer calls. test/attestation holds it to the vendored file
// differentially (same values, same refusals).

import type { ParsedNitroAttestation } from "../ports.js";

export const NITRO_PCR0 = 0;
export const NITRO_PCR0_BYTES = 48;
export const SECP256K1_PUBLIC_KEY_BYTES = 64;
export const UNCOMPRESSED_PUBLIC_KEY_BYTES = 65;
export const COSE_ALG_HEADER = 1;
export const COSE_ES384_ALG = -35;

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | boolean
  | null;

export interface CoseSign1 {
  protectedHeaders: Uint8Array;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}

// Buffer#toString("utf8") keeps a leading U+FEFF and replaces invalid sequences with U+FFFD.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

class CborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): CborValue {
    if (this.offset >= this.bytes.length) {
      throw new Error("unexpected end of CBOR input");
    }
    const initial = this.byteAt(this.offset++);
    if (initial === 0xff) {
      throw new Error("unexpected CBOR break");
    }
    const major = initial >> 5;
    const additional = initial & 0x1f;
    const arg = this.readArgument(additional);

    switch (major) {
      case 0:
        if (arg == null) {
          throw new Error("indefinite-length CBOR integer is invalid");
        }
        return arg;
      case 1:
        if (arg == null) {
          throw new Error("indefinite-length CBOR integer is invalid");
        }
        return -1n - arg;
      case 2:
        return arg == null ? this.readIndefiniteBytes() : this.readBytes(Number(arg));
      case 3:
        return arg == null ? this.readIndefiniteText() : utf8.decode(this.readBytes(Number(arg)));
      case 4: {
        const out: CborValue[] = [];
        if (arg == null) {
          while (!this.consumeBreak()) {
            out.push(this.read());
          }
        } else {
          for (let i = 0; i < Number(arg); i++) {
            out.push(this.read());
          }
        }
        return out;
      }
      case 5: {
        const out = new Map<CborValue, CborValue>();
        if (arg == null) {
          while (!this.consumeBreak()) {
            out.set(this.read(), this.read());
          }
        } else {
          for (let i = 0; i < Number(arg); i++) {
            out.set(this.read(), this.read());
          }
        }
        return out;
      }
      case 6:
        return this.read();
      case 7:
        if (additional === 20) {
          return false;
        }
        if (additional === 21) {
          return true;
        }
        if (additional === 22) {
          return null;
        }
        throw new Error(`unsupported CBOR simple value ${additional}`);
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error(`trailing CBOR bytes: ${this.bytes.length - this.offset}`);
    }
  }

  private byteAt(index: number): number {
    const byte = this.bytes[index];
    if (byte === undefined) {
      throw new Error("unexpected end of CBOR input");
    }
    return byte;
  }

  private readArgument(additional: number): bigint | undefined {
    if (additional < 24) {
      return BigInt(additional);
    }
    if (additional === 24) {
      return BigInt(this.readUInt(1));
    }
    if (additional === 25) {
      return BigInt(this.readUInt(2));
    }
    if (additional === 26) {
      return BigInt(this.readUInt(4));
    }
    if (additional === 27) {
      // Buffer.readBigUInt64BE's refusal of a short read (Node lib/internal/buffer.js boundsError).
      const last = this.bytes.length - 8;
      if (this.offset > last) {
        throw new RangeError(
          last < 0
            ? "Attempt to access memory outside buffer bounds"
            : `The value of "offset" is out of range. It must be >= 0 and <= ${last}. Received ${this.offset}`,
        );
      }
      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      const value = view.getBigUint64(this.offset, false);
      this.offset += 8;
      return value;
    }
    if (additional === 31) {
      return undefined;
    }
    throw new Error(`unsupported CBOR additional information ${additional}`);
  }

  private readUInt(length: number): number {
    if (this.offset + length > this.bytes.length) {
      throw new Error("unexpected end of CBOR integer");
    }
    let value = 0;
    for (let i = 0; i < length; i++) {
      value = value * 256 + this.byteAt(this.offset + i);
    }
    this.offset += length;
    return value;
  }

  private readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error("unexpected end of CBOR byte string");
    }
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  private consumeBreak(): boolean {
    if (this.offset < this.bytes.length && this.bytes[this.offset] === 0xff) {
      this.offset++;
      return true;
    }
    return false;
  }

  private readIndefiniteBytes(): Uint8Array {
    const chunks: Uint8Array[] = [];
    while (!this.consumeBreak()) {
      const chunk = this.read();
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("indefinite CBOR byte string contains non-byte chunk");
      }
      chunks.push(chunk);
    }
    return concatBytes(chunks);
  }

  private readIndefiniteText(): string {
    const chunks: string[] = [];
    while (!this.consumeBreak()) {
      const chunk = this.read();
      if (typeof chunk !== "string") {
        throw new Error("indefinite CBOR text string contains non-text chunk");
      }
      chunks.push(chunk);
    }
    return chunks.join("");
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new CborReader(bytes);
  const value = reader.read();
  reader.assertDone();
  return value;
}

export function cborUint(major: number, value: number): Uint8Array {
  if (value < 24) {
    return Uint8Array.of((major << 5) | value);
  }
  if (value <= 0xff) {
    return Uint8Array.of((major << 5) | 24, value);
  }
  if (value <= 0xffff) {
    return Uint8Array.of((major << 5) | 25, value >>> 8, value & 0xff);
  }
  if (value <= 0xffffffff) {
    const out = new Uint8Array(5);
    out[0] = (major << 5) | 26;
    new DataView(out.buffer).setUint32(1, value, false);
    return out;
  }
  const out = new Uint8Array(9);
  out[0] = (major << 5) | 27;
  new DataView(out.buffer).setBigUint64(1, BigInt(value), false);
  return out;
}

export function cborText(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  return concatBytes([cborUint(3, bytes.length), bytes]);
}

export function cborBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes([cborUint(2, value.length), value]);
}

export function cborArray(values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concatBytes([cborUint(4, values.length), ...values]);
}

function getMapValue(map: Map<CborValue, CborValue>, key: string | number): CborValue | undefined {
  for (const [candidate, value] of map.entries()) {
    if (
      candidate === key ||
      (typeof candidate === "bigint" && typeof key === "number" && candidate === BigInt(key))
    ) {
      return value;
    }
  }
  return undefined;
}

function asMap(value: CborValue | undefined, name: string): Map<CborValue, CborValue> {
  if (!(value instanceof Map)) {
    throw new Error(`${name} must be a CBOR map`);
  }
  return value;
}

function asArray(value: CborValue | undefined, name: string): CborValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a CBOR array`);
  }
  return value;
}

export function asBytes(value: CborValue | undefined, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${name} must be a CBOR byte string`);
  }
  return value;
}

function optionalBytes(value: CborValue | undefined, name: string): Uint8Array | undefined {
  if (value == null) {
    return undefined;
  }
  return asBytes(value, name);
}

function optionalString(value: CborValue | undefined, name: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a CBOR text string`);
  }
  return value;
}

function optionalBigint(value: CborValue | undefined, name: string): bigint | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    return value;
  }
  throw new Error(`${name} must be a CBOR integer`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatCborValue(value: CborValue | undefined): string {
  if (value == null) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    return `0x${toHex(value)}`;
  }
  return `<cbor:${value.constructor.name}>`;
}

export function assertLen(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`${name} must be ${length} bytes, got ${value.length}`);
  }
}

export function parseCoseSign1(attestationDocument: Uint8Array): CoseSign1 {
  const cose = asArray(decodeCbor(attestationDocument), "COSE_Sign1");
  if (cose.length !== 4) {
    throw new Error(`COSE_Sign1 must have 4 elements, got ${cose.length}`);
  }
  const protectedHeaders = asBytes(cose[0], "COSE protected headers");
  const payloadBytes = asBytes(cose[2], "COSE payload");
  const signature = asBytes(cose[3], "COSE signature");
  const protectedMap = asMap(decodeCbor(protectedHeaders), "COSE protected header map");
  const alg = getMapValue(protectedMap, COSE_ALG_HEADER);
  if (alg !== BigInt(COSE_ES384_ALG)) {
    throw new Error(`expected COSE alg ES384 (${COSE_ES384_ALG}), got ${formatCborValue(alg)}`);
  }
  return { protectedHeaders, payloadBytes, signature };
}

export function parseNitroPayload(payloadBytes: Uint8Array): ParsedNitroAttestation {
  const payload = asMap(decodeCbor(payloadBytes), "Nitro attestation payload");
  const pcrs = asMap(getMapValue(payload, "pcrs"), "Nitro PCR map");
  const pcr0 = asBytes(getMapValue(pcrs, NITRO_PCR0), "Nitro PCR0");
  const pcr1 = asBytes(getMapValue(pcrs, 1), "Nitro PCR1");
  const pcr2 = asBytes(getMapValue(pcrs, 2), "Nitro PCR2");
  assertLen("Nitro PCR0", pcr0, NITRO_PCR0_BYTES);
  assertLen("Nitro PCR1", pcr1, NITRO_PCR0_BYTES);
  assertLen("Nitro PCR2", pcr2, NITRO_PCR0_BYTES);

  const caBundle = asArray(getMapValue(payload, "cabundle"), "Nitro cabundle").map((cert, i) =>
    asBytes(cert, `Nitro cabundle[${i}]`),
  );

  return {
    moduleId: optionalString(getMapValue(payload, "module_id"), "Nitro module_id"),
    digest: optionalString(getMapValue(payload, "digest"), "Nitro digest"),
    timestamp: optionalBigint(getMapValue(payload, "timestamp"), "Nitro timestamp"),
    pcr0,
    pcr1,
    pcr2,
    enclavePublicKey: optionalPublicKey(getMapValue(payload, "public_key")),
    userData: optionalBytes(getMapValue(payload, "user_data"), "Nitro user_data"),
    nonce: optionalBytes(getMapValue(payload, "nonce"), "Nitro nonce"),
    certificate: asBytes(getMapValue(payload, "certificate"), "Nitro certificate"),
    caBundle,
  };
}

function optionalPublicKey(value: CborValue | undefined): Uint8Array | undefined {
  if (value == null) {
    return undefined;
  }
  return normalizeSecp256k1PublicKey(asBytes(value, "Nitro public_key"));
}

export function normalizeSecp256k1PublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === SECP256K1_PUBLIC_KEY_BYTES) {
    return publicKey;
  }
  if (publicKey.length === UNCOMPRESSED_PUBLIC_KEY_BYTES && publicKey[0] === 4) {
    return publicKey.subarray(1);
  }
  throw new Error(
    `Nitro public_key must be 64-byte x||y or 65-byte uncompressed secp256k1 key, got ${publicKey.length}`,
  );
}
