// AWS Nitro attestation verification without node:crypto: X.509 through @peculiar/x509 (pure JS
// ASN.1) and every signature through WebCrypto. Mirrors the vendored
// tools/recipient/src/oxide/vendor/oxide-lib/attestation/nitro_attestation/verify_nitro_attestation.ts
// step for step (order of checks, validation time, root pinning, error messages); only the
// certificate chain and COSE signature checks are re-expressed for WebCrypto. test/attestation
// runs both on the same inputs and requires the same accept/reject, except for the differences
// below.
//
// Known differences (all fail-closed: the port refuses what the vendored verifier accepts):
// - An empty `trustedRootCertificates` is refused ("at least one trusted root is required");
//   the vendored verifier then accepts any self-consistent chain, pinning nothing.

import { X509Certificate, type PublicKey } from "@peculiar/x509";
import type {
  AttestationVerifier,
  Clock,
  NitroAttestationInput,
  ParsedNitroAttestation,
} from "../ports.js";
import {
  assertLen,
  cborArray,
  cborBytes,
  cborText,
  parseCoseSign1,
  parseNitroPayload,
} from "./parsers.js";

export class WebCryptoAttestationVerifier implements AttestationVerifier {
  /** `clock` is read only when the caller gives no `now` and the document has no timestamp. */
  constructor(private readonly clock: Clock) {}

  async verifyNitroAttestation(input: NitroAttestationInput): Promise<ParsedNitroAttestation> {
    if (input.trustedRootCertificates.length === 0) {
      throw new Error("at least one trusted root is required");
    }
    const { protectedHeaders, payloadBytes, signature } = parseCoseSign1(input.attestationDocument);
    const parsed = parseNitroPayload(payloadBytes);

    if (input.expectedUserData) {
      assertBytesEqual("Nitro user_data", parsed.userData, input.expectedUserData);
    }
    if (input.expectedNonce) {
      assertBytesEqual("Nitro nonce", parsed.nonce, input.expectedNonce);
    }

    const validationTime =
      input.now ??
      (parsed.timestamp != null
        ? new Date(Number(parsed.timestamp))
        : new Date(this.clock.nowMs()));
    await verifyCertificateChain(parsed, input.trustedRootCertificates, validationTime);
    await verifyCoseSignature(protectedHeaders, payloadBytes, signature, parsed.certificate);
    return parsed;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function assertBytesEqual(
  name: string,
  actual: Uint8Array | undefined,
  expected: Uint8Array,
): void {
  if (!actual || !bytesEqual(actual, expected)) {
    throw new Error(`${name} does not match expected binding`);
  }
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;

/**
 * Node's `new X509Certificate(bytes)` (OpenSSL): the first PEM CERTIFICATE block anywhere in the
 * bytes, else DER. @peculiar/x509 would also take hex and base64 text, which Node refuses, so the
 * format is decided here and the library only ever sees DER.
 */
function parseCertificate(bytes: Uint8Array): X509Certificate {
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const pem = PEM_CERTIFICATE.exec(text);
  if (pem?.[1] !== undefined) {
    const der = Uint8Array.from(atob(pem[1].replace(/\s/g, "")), (char) => char.charCodeAt(0));
    return new X509Certificate(der);
  }
  if (bytes[0] !== 0x30) {
    throw new Error("X.509 certificate is neither PEM nor DER");
  }
  return new X509Certificate(bytes.slice());
}

/**
 * True when `issuerKey` verifies `cert`'s signature over its TBSCertificate. Node's
 * `X509Certificate.verify` answers false, never throws, for a key that cannot check the signature
 * (another curve or key type, a malformed signature value); @peculiar/x509 throws for some of
 * those (a P-256 key against a P-384 signature is a RangeError). The chain walk relies on false:
 * a same-subject candidate that is not the issuer is skipped and the next one is tried, so a
 * throw here is the answer "not signed by this key", never an error of the walk itself.
 */
async function signedBy(cert: X509Certificate, issuerKey: PublicKey): Promise<boolean> {
  try {
    return await cert.verify({ publicKey: issuerKey, signatureOnly: true }, globalThis.crypto);
  } catch {
    return false;
  }
}

async function verifyCertificateChain(
  parsed: ParsedNitroAttestation,
  trustedRoots: Uint8Array[],
  now: Date,
): Promise<void> {
  const leaf = parseCertificate(parsed.certificate);
  const chain = parsed.caBundle.map(parseCertificate);
  if (chain.length === 0) {
    throw new Error("Nitro cabundle must contain at least one issuing certificate");
  }

  assertCertificateTime(leaf, now, "Nitro leaf certificate");
  for (const [i, cert] of chain.entries()) {
    assertCertificateTime(cert, now, `Nitro cabundle[${i}]`);
  }

  const unused = new Set(chain.keys());
  let current = leaf;
  while (current.subject !== current.issuer) {
    let issuer: X509Certificate | undefined;
    for (const i of unused) {
      const candidate = chain[i];
      if (
        candidate !== undefined &&
        candidate.subject === current.issuer &&
        (await signedBy(current, candidate.publicKey))
      ) {
        unused.delete(i);
        issuer = candidate;
        break;
      }
    }
    if (issuer === undefined) {
      throw new Error(`could not find issuer for Nitro certificate subject ${current.subject}`);
    }
    current = issuer;
  }

  const roots = trustedRoots.map(parseCertificate);
  let trusted = false;
  for (const root of roots) {
    if (
      bytesEqual(new Uint8Array(current.rawData), new Uint8Array(root.rawData)) ||
      (await signedBy(current, root.publicKey))
    ) {
      trusted = true;
      break;
    }
  }
  if (!trusted) {
    throw new Error("Nitro certificate chain does not terminate in a trusted root");
  }
}

function assertCertificateTime(cert: X509Certificate, now: Date, name: string): void {
  const from = cert.notBefore.getTime();
  const to = cert.notAfter.getTime();
  const time = now.getTime();
  if (time < from || time > to) {
    throw new Error(`${name} is not valid at ${now.toISOString()}`);
  }
}

async function verifyCoseSignature(
  protectedHeaders: Uint8Array,
  payloadBytes: Uint8Array,
  signature: Uint8Array,
  certificate: Uint8Array,
): Promise<void> {
  assertLen("COSE ES384 signature", signature, 96);
  const leaf = parseCertificate(certificate);
  const sigStructure = cborArray([
    cborText("Signature1"),
    cborBytes(protectedHeaders),
    cborBytes(new Uint8Array(0)),
    cborBytes(payloadBytes),
  ]);
  const key = await leaf.publicKey.export(leaf.publicKey.algorithm, ["verify"], globalThis.crypto);
  const ok = await globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-384" },
    key,
    signature.slice(),
    sigStructure,
  );
  if (!ok) {
    throw new Error("Nitro COSE signature verification failed");
  }
}
