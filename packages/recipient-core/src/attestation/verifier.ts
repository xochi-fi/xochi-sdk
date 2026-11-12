// AWS Nitro attestation verification without node:crypto: X.509 parsing through @peculiar/x509
// (pure JS ASN.1) and every signature through WebCrypto. Mirrors the vendored
// tools/recipient/src/node/vendor/nitro_attestation/verify_nitro_attestation.ts
// step for step (order of checks, validation time, root pinning, error messages); only the
// certificate chain and COSE signature checks are re-expressed for WebCrypto, with OpenSSL's
// rules made explicit where @peculiar/x509 is laxer (exact-DER ECDSA signatures, outer and TBS
// signature algorithms equal, PEM framing and base64 as OpenSSL reads them). test/attestation
// runs both on the same inputs and requires the same accept/reject, except for the differences
// below.
//
// Known differences (all fail-closed: the port refuses what the vendored verifier accepts):
// - An empty `trustedRootCertificates` is refused ("at least one trusted root is required");
//   the vendored verifier then accepts any self-consistent chain, pinning nothing.
// - Certificate signatures: only ecdsa-with-SHA256/384/512 (parameters absent, RFC 5758) by a
//   P-256, P-384 or P-521 named-curve key. RSA, Ed25519, secp256k1, SHA-224 and explicit-curve
//   keys, which OpenSSL may verify, are refused (Nitro chains are ECDSA P-384 throughout).
// - The COSE leaf key must be a WebCrypto ECDSA key; an RSA leaf with a 96-byte RSA signature,
//   which Node verifies for 'sha384', is refused.
// - PEM: only the "CERTIFICATE" label is read; "X509 CERTIFICATE" and "TRUSTED CERTIFICATE"
//   blocks, which OpenSSL reads, are refused ("unsupported PEM label: ..."), and so is a blank
//   line right after BEGIN, which OpenSSL reads as an empty header section.
// - A cabundle of more than MAX_CA_BUNDLE certificates is refused before any parsing (real Nitro
//   bundles hold 4-5; the issuer search is quadratic in the bundle size).
// - A validation time that is not a valid date (a timestamp beyond 8.64e15 ms, a NaN `now` or
//   clock) is refused; the vendored verifier's NaN comparisons then pass every validity check.
// - Size caps, checked before any parsing: an attestation document over MAX_DOCUMENT_BYTES
//   (real ones are 4-5 KiB) and any certificate input (leaf, bundle entry, trusted root, DER or
//   PEM text) over MAX_CERTIFICATE_BYTES (Nitro certificates are under 1 KiB) are refused.
// Rejection messages that differ in text only: the subject in "could not find issuer ..."
// (RFC 4514 here, OpenSSL's one-per-line form there) and certificate-encoding errors (OpenSSL's
// "PEM routines::..." there).

import { X509Certificate, type PublicKey } from "@peculiar/x509";
import type {
  AttestationVerifier,
  Clock,
  NitroAttestationInput,
  ParsedNitroAttestation,
} from "../ports.js";
import { certificateSignatureFields, strictEcdsaSignature } from "./der.js";
import {
  assertLen,
  cborArray,
  cborBytes,
  cborText,
  parseCoseSign1,
  parseNitroPayload,
} from "./parsers.js";

const MAX_CA_BUNDLE = 16;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;

export class WebCryptoAttestationVerifier implements AttestationVerifier {
  private readonly subtle: SubtleCrypto;

  /**
   * `clock` is read only when the caller gives no `now` and the document has no timestamp.
   * `webCrypto` must provide SubtleCrypto, which browsers expose only in secure contexts.
   *
   * Certificates are validated at the document's own timestamp by default, so an old document
   * still verifies: this check proves the document came from a Nitro enclave, not that it is
   * fresh. Freshness comes from the on-chain enclave registry the caller checks the keys
   * against, or from an `expectedNonce` the caller had the enclave sign.
   */
  constructor(
    private readonly clock: Clock,
    private readonly webCrypto: Crypto = globalThis.crypto,
  ) {
    if (webCrypto?.subtle === undefined) {
      throw new Error(
        "WebCrypto SubtleCrypto is unavailable; a secure context (https) is required",
      );
    }
    this.subtle = webCrypto.subtle;
  }

  async verifyNitroAttestation(input: NitroAttestationInput): Promise<ParsedNitroAttestation> {
    if (input.trustedRootCertificates.length === 0) {
      throw new Error("at least one trusted root is required");
    }
    if (input.attestationDocument.length > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Nitro attestation document must be at most ${MAX_DOCUMENT_BYTES} bytes, got ${input.attestationDocument.length}`,
      );
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
    if (!Number.isFinite(validationTime.getTime())) {
      throw new Error("Nitro validation time is not a valid date");
    }
    await this.verifyCertificateChain(parsed, input.trustedRootCertificates, validationTime);
    await this.verifyCoseSignature(protectedHeaders, payloadBytes, signature, parsed.certificate);
    return parsed;
  }

  private async verifyCertificateChain(
    parsed: ParsedNitroAttestation,
    trustedRoots: Uint8Array[],
    now: Date,
  ): Promise<void> {
    if (parsed.caBundle.length > MAX_CA_BUNDLE) {
      throw new Error(
        `Nitro cabundle must contain at most ${MAX_CA_BUNDLE} certificates, got ${parsed.caBundle.length}`,
      );
    }
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
          (await this.signedBy(current, candidate.publicKey))
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
        (await this.signedBy(current, root.publicKey))
      ) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      throw new Error("Nitro certificate chain does not terminate in a trusted root");
    }
  }

  /**
   * True when `issuerKey` verifies `cert`'s signature, by OpenSSL's `X509_verify` rules: the outer
   * signatureAlgorithm equals TBSCertificate.signature, the BIT STRING has no unused bits, and the
   * ECDSA-Sig-Value is exact DER with r and s that fit the issuer's curve. A signature failing
   * those rules, or a key of another type or curve, is "not signed by this key" (false), as
   * Node's `X509Certificate.verify` answers it, so the walk skips a same-subject candidate that
   * is not the issuer. A key WebCrypto cannot import (an off-curve point) throws its DataError
   * instead, ending the verification, as OpenSSL's decode error ends the vendored one. The
   * signature is verified over the certificate's own TBS bytes, never a re-encoding.
   */
  private async signedBy(cert: X509Certificate, issuerKey: PublicKey): Promise<boolean> {
    const fields = certificateSignatureFields(new Uint8Array(cert.rawData));
    if (!bytesEqual(fields.signatureAlgorithm, fields.tbsSignatureAlgorithm)) {
      return false;
    }
    const hash = ECDSA_SIGNATURE_HASHES[toHex(fields.signatureAlgorithm)];
    if (hash === undefined || fields.signatureValue[0] !== 0) {
      return false;
    }
    const signature = strictEcdsaSignature(fields.signatureValue.subarray(1));
    const curve = ecCurve(issuerKey);
    if (signature === null || curve === undefined) {
      return false;
    }
    const size = CURVE_SCALAR_BYTES[curve];
    if (signature.r.length > size || signature.s.length > size) {
      return false;
    }
    const key = await this.subtle.importKey(
      "spki",
      new Uint8Array(issuerKey.rawData),
      { name: "ECDSA", namedCurve: curve },
      false,
      ["verify"],
    );
    const p1363 = new Uint8Array(2 * size);
    p1363.set(signature.r, size - signature.r.length);
    p1363.set(signature.s, 2 * size - signature.s.length);
    return this.subtle.verify({ name: "ECDSA", hash }, key, p1363, fields.tbs.slice());
  }

  private async verifyCoseSignature(
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
    const key = await leaf.publicKey.export(leaf.publicKey.algorithm, ["verify"], this.webCrypto);
    const ok = await this.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      key,
      signature.slice(),
      sigStructure,
    );
    if (!ok) {
      throw new Error("Nitro COSE signature verification failed");
    }
  }
}

/** DER AlgorithmIdentifier (hex) -> WebCrypto hash, for ecdsa-with-SHA* with absent parameters. */
const ECDSA_SIGNATURE_HASHES: Record<string, string> = {
  "300a06082a8648ce3d040302": "SHA-256",
  "300a06082a8648ce3d040303": "SHA-384",
  "300a06082a8648ce3d040304": "SHA-512",
};

const CURVE_SCALAR_BYTES = { "P-256": 32, "P-384": 48, "P-521": 66 } as const;
type Curve = keyof typeof CURVE_SCALAR_BYTES;

function ecCurve(key: PublicKey): Curve | undefined {
  const algorithm = key.algorithm as Partial<EcKeyAlgorithm>;
  const curve = algorithm.namedCurve;
  return algorithm.name === "ECDSA" &&
    curve !== undefined &&
    Object.hasOwn(CURVE_SCALAR_BYTES, curve)
    ? (curve as Curve)
    : undefined;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

const PEM_OTHER_CERTIFICATE_LABELS = ["X509 CERTIFICATE", "TRUSTED CERTIFICATE"];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Index of the first `marker` at or after `from` that starts a line, or -1. Linear time. */
function lineStartIndexOf(text: string, marker: string, from: number): number {
  for (let at = text.indexOf(marker, from); at !== -1; at = text.indexOf(marker, at + 1)) {
    if (at === 0 || text[at - 1] === "\n") return at;
  }
  return -1;
}

/** The line starting at `start`, without its "\n" and trailing spaces, tabs and CRs. */
function readLine(text: string, start: number): { line: string; next: number } {
  const newline = text.indexOf("\n", start);
  const lineEnd = newline === -1 ? text.length : newline;
  let end = lineEnd;
  while (end > start && " \t\r".includes(text.charAt(end - 1))) end--;
  return { line: text.slice(start, end), next: lineEnd + 1 };
}

/**
 * The base64 of the first PEM CERTIFICATE block, read the way OpenSSL's PEM_read_bio_X509_AUX
 * reads it (Node 24 probed): BEGIN and END lines start a line and may carry trailing
 * whitespace; a block's first "-----END " line must name the block's own label; a block with
 * another label is skipped only after its END line; inside the body only spaces, tabs and CRs
 * are whitespace, and the base64 must be padded. Stricter than OpenSSL (fail-closed): a blank
 * or "key: value" header line anywhere in the body is refused, as are the other certificate
 * labels. null when the text has no PEM block at all.
 */
function pemCertificateBase64(text: string): string | null {
  for (let at = lineStartIndexOf(text, "-----BEGIN ", 0); at !== -1; ) {
    const begin = readLine(text, at);
    if (!begin.line.endsWith("-----")) {
      at = lineStartIndexOf(text, "-----BEGIN ", begin.next);
      continue;
    }
    const label = begin.line.slice("-----BEGIN ".length, -"-----".length);
    if (PEM_OTHER_CERTIFICATE_LABELS.includes(label)) {
      throw new Error(`unsupported PEM label: ${label}`);
    }
    const body: string[] = [];
    let endLine: string | undefined;
    let cursor = begin.next;
    while (cursor <= text.length && endLine === undefined) {
      const { line, next } = readLine(text, cursor);
      cursor = next;
      if (line.startsWith("-----END ")) {
        endLine = line;
      } else {
        body.push(line);
      }
    }
    if (endLine === undefined) {
      throw new Error(`PEM ${label} block has no END line`);
    }
    if (endLine !== `-----END ${label}-----`) {
      throw new Error(`PEM ${label} block has a bad END line`);
    }
    if (label === "CERTIFICATE") {
      if (body.some((line) => line.replace(/[ \t\r]/g, "") === "" || line.includes(":"))) {
        throw new Error("PEM CERTIFICATE block has a blank or header line");
      }
      const base64 = body.join("").replace(/[ \t\r]/g, "");
      if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
        throw new Error("PEM CERTIFICATE block is not base64");
      }
      return base64;
    }
    at = lineStartIndexOf(text, "-----BEGIN ", cursor);
  }
  return null;
}

/**
 * Node's `new X509Certificate(bytes)` (OpenSSL): the first PEM certificate block, else DER.
 * @peculiar/x509 would also take hex and base64 text, which Node refuses, so the format is
 * decided here and the library only ever sees DER.
 */
function parseCertificate(bytes: Uint8Array): X509Certificate {
  if (bytes.length > MAX_CERTIFICATE_BYTES) {
    throw new Error(
      `X.509 certificate must be at most ${MAX_CERTIFICATE_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = pemCertificateBase64(text);
  if (base64 !== null) {
    return new X509Certificate(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
  }
  if (bytes[0] !== 0x30) {
    throw new Error("X.509 certificate is neither PEM nor DER");
  }
  return new X509Certificate(bytes.slice());
}

function assertCertificateTime(cert: X509Certificate, now: Date, name: string): void {
  const from = cert.notBefore.getTime();
  const to = cert.notAfter.getTime();
  const time = now.getTime();
  if (time < from || time > to) {
    throw new Error(`${name} is not valid at ${now.toISOString()}`);
  }
}
