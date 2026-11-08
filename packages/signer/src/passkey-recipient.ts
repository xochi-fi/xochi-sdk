// Passkey recipient keys (xochi-sdk#155, epic xochi#833; @xochi/spec PASSKEY-RECIPIENT.md).
// One WebAuthn passkey, evaluated once with the PRF extension (`eval: PASSKEY_PRF_INPUTS`),
// yields the recipient's Aztec account secrets and the AES-256-GCM key that wraps an imported
// CLI recipient. The package root exports this module. Platform-neutral and network-free: the
// WebAuthn ceremony is the caller's; this module only derives, and never puts a PRF byte or a
// derived byte into an error.
//
//   accountSecret = OS2IP(HKDF-SHA256(first,  salt, "<label>/account-secret", 64)) mod r
//   accountSalt   = OS2IP(HKDF-SHA256(first,  salt, "<label>/account-salt",   64)) mod r
//   wrapKey       =       HKDF-SHA256(second, salt, "<label>/wrap-key",       32)
//
// with label = salt = "xochi.recipient.passkey.v1" (UTF-8) and r the BN254 scalar field order.
// `{ secret, salt }` is the recipient CLI's `AccountSecrets`: a stock SchnorrAccount 6.0.0 with
// signing key `deriveMasterMessageSigningSecretKey(secret)`, keys `deriveKeys(secret)`, that
// salt and deployer zero. One passkey is one recipient.

import { hkdf } from "@noble/hashes/hkdf.js";
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

/** `SHA-256(UTF8("xochi.recipient.passkey.v1/prf/<purpose>"))`: a PRF `eval` input. */
const prfInput = (purpose: string): Hex =>
  `0x${bytesToHex(sha256(utf8ToBytes(`${LABEL}/prf/${purpose}`)))}`;

/**
 * The page's `extensions.prf.eval.{first, second}`, both evaluated in one ceremony: `first`
 * (account purpose) derives the account secrets, `second` (wrap purpose) the wrap key. The
 * browser hashes each again (`SHA-256("WebAuthn PRF" || 0x00 || input)`) before the
 * authenticator sees it.
 */
export const PASSKEY_PRF_INPUTS: { readonly first: Hex; readonly second: Hex } = Object.freeze({
  first: prfInput("account"),
  second: prfInput("wrap"),
});

export type PasskeyDerivationRefusal =
  | "prf_output_invalid"
  | "derived_zero"
  | "unsupported_version";

/** A refused derivation. `field` names the input; no message carries key material. */
export class PasskeyDerivationError extends RefusalError<PasskeyDerivationRefusal> {
  override name = "PasskeyDerivationError";
}

const refusePasskey = refuser(PasskeyDerivationError);

/** `getClientExtensionResults().prf.results.{first, second}`, each exactly 32 bytes. */
export interface PasskeyPrfOutputs {
  first: Uint8Array;
  second: Uint8Array;
}

/**
 * `secret` / `salt`: BN254 field elements as `0x` + 64 lowercase hex (`Fr.toString()`).
 * `wrapKey`: 32 raw bytes, a fresh array the caller imports as a non-extractable AES-GCM
 * `CryptoKey` and then zeroes.
 */
export interface PasskeyRecipientKeys {
  secret: Hex;
  salt: Hex;
  wrapKey: Uint8Array;
}

function prfOutput(field: "first" | "second", value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
    return refusePasskey(
      "prf_output_invalid",
      `prf.${field}`,
      `expected a Uint8Array, got ${kind}`,
    );
  }
  if (value.length !== PRF_OUTPUT_BYTES) {
    refusePasskey(
      "prf_output_invalid",
      `prf.${field}`,
      `expected ${PRF_OUTPUT_BYTES} bytes, got ${value.length}`,
    );
  }
  return value;
}

// Wide (64-byte) reduction into the field; the HKDF output is zeroed once read.
function fieldElement(field: string, ikm: Uint8Array, info: string): Hex {
  const okm = hkdf(sha256, ikm, HKDF_SALT, utf8ToBytes(`${LABEL}/${info}`), 64);
  const value = BigInt(`0x${bytesToHex(okm)}`) % AZTEC_FIELD_MODULUS;
  okm.fill(0);
  if (value === 0n) refusePasskey("derived_zero", field, "reduces to 0 mod r");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Derives a passkey recipient's account secrets and wrap key from its two PRF outputs.
 * Refuses (`PasskeyDerivationError`) a version other than `PASSKEY_DERIVATION_V1`
 * (`unsupported_version`), a PRF output that is not a 32-byte `Uint8Array`
 * (`prf_output_invalid`; a missing result means the authenticator does not support PRF), and
 * an account secret or salt that reduces to zero (`derived_zero`).
 */
export function derivePasskeyRecipientKeys(
  prf: PasskeyPrfOutputs,
  version: typeof PASSKEY_DERIVATION_V1 = PASSKEY_DERIVATION_V1,
): PasskeyRecipientKeys {
  if (version !== PASSKEY_DERIVATION_V1) {
    refusePasskey("unsupported_version", "version", `expected ${PASSKEY_DERIVATION_V1}`);
  }
  if (typeof prf !== "object" || prf === null) {
    refusePasskey("prf_output_invalid", "prf", "expected { first, second }");
  }
  const first = prfOutput("first", prf.first);
  const second = prfOutput("second", prf.second);
  return {
    secret: fieldElement("accountSecret", first, "account-secret"),
    salt: fieldElement("accountSalt", first, "account-salt"),
    wrapKey: hkdf(sha256, second, HKDF_SALT, utf8ToBytes(`${LABEL}/wrap-key`), 32),
  };
}
