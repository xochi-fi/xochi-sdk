// Passkey recipient keys (xochi-sdk#155, epic xochi#833; @xochi/spec PASSKEY-RECIPIENT.md).
// One WebAuthn passkey, evaluated once with the PRF extension (`eval: passkeyPrfInputBytes()`),
// yields the recipient's Aztec account secrets, the AES-256-GCM key that wraps an imported CLI
// recipient, and the key of the browser's persisted encrypted PXE store. The package root
// exports this module. Platform-neutral and network-free: the WebAuthn ceremony is the
// caller's; this module only derives, and never puts a PRF byte or a derived byte into an error.
//
//   accountSecret = OS2IP(HKDF-SHA256(first,  salt, "<label>/account-secret", 64)) mod r
//   accountSalt   = OS2IP(HKDF-SHA256(first,  salt, "<label>/account-salt",   64)) mod r
//   wrapKey       =       HKDF-SHA256(second, salt, "<label>/wrap-key",       32)
//   pxeStoreKey   =       HKDF-SHA256(second, salt, "<label>/pxe-store-key",  32)
//
// with label = salt = "xochi.recipient.passkey.v1" (UTF-8) and r the BN254 scalar field order.
// `{ secret, salt }` is the recipient CLI's `AccountSecrets`: a stock SchnorrAccount 6.0.0 with
// signing key `deriveMasterMessageSigningSecretKey(secret)`, keys `deriveKeys(secret)`, that
// salt and deployer zero. One passkey is one recipient.
//
// Erasure is best effort: the PRF copies, both HKDF pseudorandom keys and every 64-byte output
// are zeroed once used, but JavaScript cannot erase the hex strings, bigints or engine copies.

import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { AZTEC_FIELD_MODULUS, RefusalError, refuser } from "./shielded-values";
import type { Hex } from "./types";

/** The only relying party a passkey recipient is bound to. Production has no override. */
export const PASSKEY_RP_ID = "xochi.fi";
export const PASSKEY_RP_NAME = "Xochi";
export const PASSKEY_DERIVATION_V1 = 1;

const LABEL = "xochi.recipient.passkey.v1";
const HKDF_SALT = utf8ToBytes(LABEL);
const PRF_OUTPUT_BYTES = 32;

/**
 * The page's `extensions.prf.eval.{first, second}` as the 32 raw bytes WebAuthn takes: `first`
 * = `SHA-256(UTF8("xochi.recipient.passkey.v1/prf/account"))` derives the account secrets,
 * `second` = `SHA-256(UTF8("xochi.recipient.passkey.v1/prf/wrap"))` the wrap and PXE store
 * keys. Both are evaluated in one ceremony; the browser hashes each again
 * (`SHA-256("WebAuthn PRF" || 0x00 || input)`) before the authenticator sees it. A fresh pair
 * per call. Pass these bytes, never the text of `PASSKEY_PRF_INPUTS`: any other encoding
 * derives a different account.
 */
export function passkeyPrfInputBytes(): { first: Uint8Array; second: Uint8Array } {
  return {
    first: sha256(utf8ToBytes(`${LABEL}/prf/account`)),
    second: sha256(utf8ToBytes(`${LABEL}/prf/wrap`)),
  };
}

/** `passkeyPrfInputBytes()` as `0x` hex, for display and comparison. */
export const PASSKEY_PRF_INPUTS: { readonly first: Hex; readonly second: Hex } = (() => {
  const { first, second } = passkeyPrfInputBytes();
  return Object.freeze({
    first: `0x${bytesToHex(first)}` as Hex,
    second: `0x${bytesToHex(second)}` as Hex,
  });
})();

export type PasskeyDerivationRefusal =
  | "prf_output_invalid"
  | "derived_zero"
  | "unsupported_version";

/** A refused derivation. `field` names the input; no message carries key material. */
export class PasskeyDerivationError extends RefusalError<PasskeyDerivationRefusal> {
  override name = "PasskeyDerivationError";
}

const refusePasskey = refuser(PasskeyDerivationError);

/**
 * `getClientExtensionResults().prf.results.{first, second}`: each exactly 32 bytes, as the
 * `ArrayBuffer` the browser returns or any view of 32 bytes. They are copied, never written.
 */
export interface PasskeyPrfOutputs {
  first: ArrayBuffer | ArrayBufferView;
  second: ArrayBuffer | ArrayBufferView;
}

/**
 * `secret` / `salt`: BN254 field elements as `0x` + 64 lowercase hex (`Fr.toString()`).
 * `wrapKey`: 32 raw bytes, a fresh array the caller imports as a non-extractable AES-GCM
 * `CryptoKey` and then zeroes. `pxeStoreKey`: 32 raw bytes, a fresh array, the key of the
 * persisted encrypted PXE store; derived on every unlock and never persisted itself.
 */
export interface PasskeyRecipientKeys {
  secret: Hex;
  salt: Hex;
  wrapKey: Uint8Array;
  pxeStoreKey: Uint8Array;
}

// The `ArrayBuffer.prototype.byteLength` getter throws on anything without an ArrayBuffer's
// internal slot, whatever its prototype or `Symbol.toStringTag` claims; it holds across realms
// (an iframe's or a worker's buffers), where `instanceof` would not. A SharedArrayBuffer fails it.
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  try {
    Reflect.apply(arrayBufferByteLength, value, []);
    return true;
  } catch {
    // The brand check's answer is the throw itself: not an ArrayBuffer.
    return false;
  }
}

// A private copy of one output. A detached buffer (transferred away) refuses like a missing
// output; a TypedArray, DataView or ArrayBuffer of another realm is read like one of this realm.
function prfOutputCopy(field: "first" | "second", value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) && !isArrayBuffer(value)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
    return refusePasskey(
      "prf_output_invalid",
      `prf.${field}`,
      `expected an ArrayBuffer or a view of one, got ${kind}`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
  } catch (e) {
    // Reading a detached buffer or view throws a TypeError (possibly another realm's).
    if (!(e instanceof Error) || e.name !== "TypeError") throw e;
    return refusePasskey("prf_output_invalid", `prf.${field}`, "the buffer is detached");
  }
  if (bytes.length !== PRF_OUTPUT_BYTES) {
    refusePasskey(
      "prf_output_invalid",
      `prf.${field}`,
      `expected ${PRF_OUTPUT_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return bytes.slice();
}

// HKDF-Expand under `prk`, wide-reduced into the field; the 64-byte output is zeroed once read.
function fieldElement(field: string, prk: Uint8Array, info: string): Hex {
  const okm = expand(sha256, prk, utf8ToBytes(`${LABEL}/${info}`), 64);
  const value = BigInt(`0x${bytesToHex(okm)}`) % AZTEC_FIELD_MODULUS;
  okm.fill(0);
  if (value === 0n) refusePasskey("derived_zero", field, "reduces to 0 mod r");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Derives a passkey recipient's account secrets, wrap key and PXE store key from its two PRF
 * outputs. Refuses (`PasskeyDerivationError`) a version other than `PASSKEY_DERIVATION_V1`
 * (`unsupported_version`); an output that is not 32 bytes (`prf_output_invalid`; a missing
 * result means the authenticator did not evaluate PRF); a `second` equal to `first`
 * (`prf_output_invalid` on `prf.second`: the same result passed twice); and an account secret
 * or salt that reduces to zero (`derived_zero`).
 */
export function derivePasskeyRecipientKeys(
  prf: PasskeyPrfOutputs,
  version: number = PASSKEY_DERIVATION_V1,
): PasskeyRecipientKeys {
  if (version !== PASSKEY_DERIVATION_V1) {
    refusePasskey("unsupported_version", "version", `expected ${PASSKEY_DERIVATION_V1}`);
  }
  if (typeof prf !== "object" || prf === null) {
    refusePasskey("prf_output_invalid", "prf", "expected { first, second }");
  }
  const first = prfOutputCopy("first", prf.first);
  let second: Uint8Array | undefined;
  let firstPrk: Uint8Array | undefined;
  let secondPrk: Uint8Array | undefined;
  try {
    second = prfOutputCopy("second", prf.second);
    let difference = 0;
    for (let i = 0; i < PRF_OUTPUT_BYTES; i++) difference |= first[i]! ^ second[i]!;
    if (difference === 0) refusePasskey("prf_output_invalid", "prf.second", "equals prf.first");
    firstPrk = extract(sha256, first, HKDF_SALT);
    secondPrk = extract(sha256, second, HKDF_SALT);
    return {
      secret: fieldElement("accountSecret", firstPrk, "account-secret"),
      salt: fieldElement("accountSalt", firstPrk, "account-salt"),
      wrapKey: expand(sha256, secondPrk, utf8ToBytes(`${LABEL}/wrap-key`), 32),
      pxeStoreKey: expand(sha256, secondPrk, utf8ToBytes(`${LABEL}/pxe-store-key`), 32),
    };
  } finally {
    first.fill(0);
    second?.fill(0);
    firstPrk?.fill(0);
    secondPrk?.fill(0);
  }
}
