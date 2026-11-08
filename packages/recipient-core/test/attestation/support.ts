/// <reference types="node" />
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2";
import { X509CertificateGenerator, type X509Certificate } from "@peculiar/x509";
import type { NitroAttestationInput, ParsedNitroAttestation } from "../../src/ports.js";

/**
 * `fixtures/attestation-0xcb88.json` is xochi-fi/pxe-bridge `tests/fixtures/oxide/attestation-0xcb88.json`
 * at fcf226d (added in 0e01c17, #85), byte for byte (sha256 1247db72...7f59): a real attestation
 * document from the Oxide v6 mainnet fleet (enclave 0xcb88..., registry leaf 7, fetched read-only
 * with getAttestation on 2026-11-02). Public data: a COSE_Sign1 over the PCRs and the keys the
 * enclave registered. `userData` holds those keys; the document's `user_data` is their SHA-256
 * commitment (vendored `oxide-lib-tee/attestation/user_data.ts`).
 */
const FIXTURE_URL = new URL("./fixtures/attestation-0xcb88.json", import.meta.url);

/** `AWS_NITRO_ROOT_G1_PEM` of tools/recipient/src/oxide/enclave.ts (drift-tested). */
export const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

export const ENCLAVE_TS_URL = new URL(
  "../../../../tools/recipient/src/oxide/enclave.ts",
  import.meta.url,
);

export function awsNitroRootDer(): Uint8Array {
  const body = AWS_NITRO_ROOT_G1_PEM.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "");
  return new Uint8Array(Buffer.from(body, "base64"));
}

export interface RealFixture {
  document: Uint8Array;
  /** sha256("oxide-tee/v1" || publicKeyX || publicKeyY || encPubKeyX || encPubKeyY) */
  userData: Uint8Array;
}

export function realFixture(): RealFixture {
  const raw = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as {
    attestation: string;
    userData: Record<"publicKeyX" | "publicKeyY" | "encPubKeyX" | "encPubKeyY", string>;
  };
  const keys = [
    raw.userData.publicKeyX,
    raw.userData.publicKeyY,
    raw.userData.encPubKeyX,
    raw.userData.encPubKeyY,
  ].map((hex) => Buffer.from(hex.slice(2), "hex"));
  return {
    document: new Uint8Array(Buffer.from(raw.attestation, "base64")),
    userData: sha256(Buffer.concat([Buffer.from("oxide-tee/v1", "ascii"), ...keys])),
  };
}

// ---------------------------------------------------------------------------------------------
// The vendored (Node) verifier and parser, loaded at runtime from tools/recipient. A computed
// specifier keeps them out of this package's TypeScript program (they sit outside its rootDir
// and need Node's Buffer types); vitest transforms them like any other module.

const VENDORED_DIR = new URL(
  "../../../../tools/recipient/src/oxide/vendor/oxide-lib/attestation/nitro_attestation/",
  import.meta.url,
);

export type CborValue =
  | number
  | bigint
  | string
  | Buffer
  | CborValue[]
  | Map<CborValue, CborValue>
  | boolean
  | null;

interface VendoredParsed {
  moduleId?: string;
  digest?: string;
  timestamp?: bigint;
  pcr0: Buffer;
  pcr1: Buffer;
  pcr2: Buffer;
  enclavePublicKey?: Buffer;
  userData?: Buffer;
  nonce?: Buffer;
  certificate: Buffer;
  caBundle: Buffer[];
}

export interface VendoredVerifierModule {
  verifyNitroAttestation(input: {
    attestationDocument: Buffer;
    trustedRootCertificates?: Buffer[];
    expectedUserData?: Buffer;
    expectedNonce?: Buffer;
    now?: Date;
  }): VendoredParsed;
}

export interface VendoredParsersModule {
  decodeCbor(bytes: Buffer): CborValue;
  parseCoseSign1(document: Buffer): {
    protectedHeaders: Buffer;
    payloadBytes: Buffer;
    signature: Buffer;
  };
  parseNitroPayload(payloadBytes: Buffer): VendoredParsed;
}

export async function loadVendoredVerifier(): Promise<VendoredVerifierModule> {
  const href = new URL("verify_nitro_attestation.ts", VENDORED_DIR).href;
  return (await import(href)) as VendoredVerifierModule;
}

export async function loadVendoredParsers(): Promise<VendoredParsersModule> {
  const href = new URL("parsers.ts", VENDORED_DIR).href;
  return (await import(href)) as VendoredParsersModule;
}

// ---------------------------------------------------------------------------------------------
// Outcomes, compared across the two verifiers.

export interface NormalizedParsed {
  moduleId?: string;
  digest?: string;
  timestamp?: bigint;
  pcr0: Uint8Array;
  pcr1: Uint8Array;
  pcr2: Uint8Array;
  enclavePublicKey?: Uint8Array;
  userData?: Uint8Array;
  nonce?: Uint8Array;
  certificate: Uint8Array;
  caBundle: Uint8Array[];
}

export type Outcome = { ok: true; parsed: NormalizedParsed } | { ok: false; message: string };

const copy = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);
const copyOptional = (bytes: Uint8Array | undefined): Uint8Array | undefined =>
  bytes === undefined ? undefined : copy(bytes);

export function normalize(parsed: ParsedNitroAttestation | VendoredParsed): NormalizedParsed {
  return {
    moduleId: parsed.moduleId,
    digest: parsed.digest,
    timestamp: parsed.timestamp,
    pcr0: copy(parsed.pcr0),
    pcr1: copy(parsed.pcr1),
    pcr2: copy(parsed.pcr2),
    enclavePublicKey: copyOptional(parsed.enclavePublicKey),
    userData: copyOptional(parsed.userData),
    nonce: copyOptional(parsed.nonce),
    certificate: copy(parsed.certificate),
    caBundle: parsed.caBundle.map(copy),
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : `non-Error thrown: ${String(error)}`;

const toBuffer = (bytes: Uint8Array | undefined): Buffer | undefined =>
  bytes === undefined ? undefined : Buffer.from(bytes);

export function runVendored(
  vendored: VendoredVerifierModule,
  input: NitroAttestationInput,
): Outcome {
  try {
    const parsed = vendored.verifyNitroAttestation({
      attestationDocument: Buffer.from(input.attestationDocument),
      trustedRootCertificates: input.trustedRootCertificates.map((cert) => Buffer.from(cert)),
      expectedUserData: toBuffer(input.expectedUserData),
      expectedNonce: toBuffer(input.expectedNonce),
      now: input.now,
    });
    return { ok: true, parsed: normalize(parsed) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export async function runPort(
  verify: (input: NitroAttestationInput) => Promise<ParsedNitroAttestation>,
  input: NitroAttestationInput,
): Promise<Outcome> {
  try {
    return { ok: true, parsed: normalize(await verify(input)) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// A minimal definite-length CBOR encoder (shortest-form heads), enough to rebuild Nitro documents.

function head(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value));
  for (const [additional, size] of [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ] as const) {
    if (value < 1n << BigInt(size * 8)) {
      const out = new Uint8Array(1 + size);
      out[0] = (major << 5) | additional;
      for (let i = 0; i < size; i++) {
        out[size - i] = Number((value >> BigInt(i * 8)) & 0xffn);
      }
      return out;
    }
  }
  throw new Error(`CBOR argument too large: ${value}`);
}

export function encodeCbor(value: CborValue | Uint8Array): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (typeof value === "number") return encodeCbor(BigInt(value));
  if (typeof value === "bigint") return value >= 0n ? head(0, value) : head(1, -1n - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return Buffer.concat([head(3, BigInt(bytes.length)), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, BigInt(value.length)), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, BigInt(value.length)), ...value.map(encodeCbor)]);
  }
  const entries = [...value.entries()].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)]);
  return Buffer.concat([head(5, BigInt(value.size)), ...entries]);
}

/** The AWS NSM encodes the attestation payload as an indefinite-length map (0xbf ... 0xff). */
export function encodeIndefiniteMap(map: Map<CborValue, CborValue>): Uint8Array {
  const entries = [...map.entries()].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)]);
  return Buffer.concat([Uint8Array.of(0xbf), ...entries, Uint8Array.of(0xff)]);
}

export const ES384_PROTECTED_HEADER = Uint8Array.of(0xa1, 0x01, 0x38, 0x22);

export function encodeCoseSign1(parts: {
  protectedHeaders: Uint8Array;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}): Uint8Array {
  return new Uint8Array(
    encodeCbor([
      Buffer.from(parts.protectedHeaders),
      new Map(),
      Buffer.from(parts.payloadBytes),
      Buffer.from(parts.signature),
    ]),
  );
}

/** COSE Sig_structure for COSE_Sign1 with empty external AAD (RFC 9052 section 4.4). */
export function sigStructure(
  protectedHeaders: Uint8Array,
  payloadBytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    encodeCbor([
      "Signature1",
      Buffer.from(protectedHeaders),
      Buffer.alloc(0),
      Buffer.from(payloadBytes),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Synthetic Nitro-shaped chains and documents, signed with throwaway WebCrypto keys.

const P384: EcKeyGenParams & EcdsaParams = { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" };
const P256: EcKeyGenParams & EcdsaParams = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

export const SYNTHETIC_NOT_BEFORE = new Date("2030-01-01T00:00:00Z");
export const SYNTHETIC_NOT_AFTER = new Date("2030-01-02T00:00:00Z");
export const SYNTHETIC_TIMESTAMP = BigInt(Date.parse("2030-01-01T12:00:00Z"));

async function ecKeys(params: EcKeyGenParams): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(params, false, ["sign", "verify"])) as CryptoKeyPair;
}

export async function selfSigned(
  name: string,
  curve: "P-384" | "P-256" = "P-384",
): Promise<{ cert: X509Certificate; keys: CryptoKeyPair }> {
  const algorithm = curve === "P-384" ? P384 : P256;
  const keys = await ecKeys(algorithm);
  const cert = await X509CertificateGenerator.createSelfSigned(
    {
      name,
      keys,
      signingAlgorithm: algorithm,
      notBefore: SYNTHETIC_NOT_BEFORE,
      notAfter: SYNTHETIC_NOT_AFTER,
    },
    crypto,
  );
  return { cert, keys };
}

export interface SyntheticChain {
  root: X509Certificate;
  rootKeys: CryptoKeyPair;
  leaf: X509Certificate;
  leafKeys: CryptoKeyPair;
}

export async function syntheticChain(
  rootName = "CN=Synthetic Nitro Root, O=Test, C=US",
  leafSigningHash: "SHA-256" | "SHA-384" = "SHA-384",
): Promise<SyntheticChain> {
  const root = await selfSigned(rootName);
  const leafKeys = await ecKeys(P384);
  const leaf = await X509CertificateGenerator.create(
    {
      subject: "CN=Synthetic Nitro Leaf, O=Test, C=US",
      issuer: root.cert.subject,
      publicKey: leafKeys.publicKey,
      signingKey: root.keys.privateKey,
      signingAlgorithm: { ...P384, hash: leafSigningHash },
      notBefore: SYNTHETIC_NOT_BEFORE,
      notAfter: SYNTHETIC_NOT_AFTER,
    },
    crypto,
  );
  return { root: root.cert, rootKeys: root.keys, leaf, leafKeys };
}

const pcr = (fill: number): Buffer => Buffer.alloc(48, fill);

export async function syntheticDocument(
  signingKey: CryptoKey,
  fields: {
    certificate: Uint8Array;
    caBundle: Uint8Array[];
    timestamp?: bigint;
    nonce?: Uint8Array;
    userData?: Uint8Array;
  },
): Promise<Uint8Array> {
  const payload = new Map<CborValue, CborValue>([
    ["module_id", "i-synthetic-enc0"],
    ["digest", "SHA384"],
    ...(fields.timestamp === undefined ? [] : ([["timestamp", fields.timestamp]] as const)),
    [
      "pcrs",
      new Map<CborValue, CborValue>([
        [0, pcr(0)],
        [1, pcr(1)],
        [2, pcr(2)],
      ]),
    ],
    ["certificate", Buffer.from(fields.certificate)],
    ["cabundle", fields.caBundle.map((cert) => Buffer.from(cert))],
    ["public_key", null],
    ["user_data", fields.userData === undefined ? null : Buffer.from(fields.userData)],
    ["nonce", fields.nonce === undefined ? null : Buffer.from(fields.nonce)],
  ]);
  const payloadBytes = encodeCbor(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-384" },
      signingKey,
      sigStructure(ES384_PROTECTED_HEADER, payloadBytes),
    ),
  );
  return encodeCoseSign1({ protectedHeaders: ES384_PROTECTED_HEADER, payloadBytes, signature });
}

export const der = (cert: X509Certificate): Uint8Array => new Uint8Array(cert.rawData);

// ---------------------------------------------------------------------------------------------
// DER surgery on certificates: Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm,
// signatureValue BIT STRING }. Enough to re-encode or re-sign a synthetic certificate.

interface Tlv {
  tag: number;
  /** The whole element, header included. */
  bytes: Uint8Array;
  content: Uint8Array;
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset] ?? -1;
  const first = bytes[offset + 1] ?? -1;
  let length = first;
  let header = 2;
  if (first > 0x80) {
    length = 0;
    for (let i = 0; i < first - 0x80; i++) length = length * 256 + (bytes[offset + 2 + i] ?? 0);
    header += first - 0x80;
  }
  const end = offset + header + length;
  return {
    tag,
    bytes: bytes.subarray(offset, end),
    content: bytes.subarray(offset + header, end),
  };
}

function children(content: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = 0; offset < content.length; offset += out.at(-1)?.bytes.length ?? 1) {
    out.push(readTlv(content, offset));
  }
  return out;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return Buffer.concat([Uint8Array.of(tag), derLength(content.length), content]);
}

export interface CertificateParts {
  tbs: Uint8Array;
  signatureAlgorithm: Uint8Array;
  /** BIT STRING contents: the unused-bits octet, then the DER ECDSA-Sig-Value. */
  signatureBits: Uint8Array;
}

export function certificateParts(certificate: Uint8Array): CertificateParts {
  const [tbs, signatureAlgorithm, signatureValue] = children(readTlv(certificate, 0).content);
  if (!tbs || !signatureAlgorithm || signatureValue?.tag !== 0x03) {
    throw new Error("not a certificate");
  }
  return {
    tbs: tbs.bytes,
    signatureAlgorithm: signatureAlgorithm.bytes,
    signatureBits: signatureValue.content,
  };
}

export function assembleCertificate(parts: CertificateParts): Uint8Array {
  return new Uint8Array(
    tlv(0x30, Buffer.concat([parts.tbs, parts.signatureAlgorithm, tlv(0x03, parts.signatureBits)])),
  );
}

/** r and s of a DER ECDSA-Sig-Value, as their INTEGER contents. */
export function ecdsaIntegers(signatureDer: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  const [r, s] = children(readTlv(signatureDer, 0).content);
  if (r?.tag !== 0x02 || s?.tag !== 0x02) throw new Error("not an ECDSA-Sig-Value");
  return { r: r.content, s: s.content };
}

/** DER INTEGER contents of an unsigned big-endian magnitude (minimal, positive). */
function derUnsigned(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  return (trimmed[0] ?? 0) >= 0x80 ? Buffer.concat([Uint8Array.of(0), trimmed]) : trimmed;
}

export function ecdsaSigValue(r: Uint8Array, s: Uint8Array): Uint8Array {
  return new Uint8Array(tlv(0x30, Buffer.concat([tlv(0x02, r), tlv(0x02, s)])));
}

/** `tbs` signed by `key` (ECDSA P-384 key, `hash`), as a DER ECDSA-Sig-Value. */
export async function signTbs(
  key: CryptoKey,
  hash: "SHA-256" | "SHA-384",
  tbs: Uint8Array,
): Promise<Uint8Array> {
  const p1363 = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash }, key, Uint8Array.from(tbs)),
  );
  const half = p1363.length / 2;
  return ecdsaSigValue(derUnsigned(p1363.subarray(0, half)), derUnsigned(p1363.subarray(half)));
}

/** AlgorithmIdentifier { ecdsa-with-SHA384 } (RFC 5758: parameters absent). */
export const ECDSA_WITH_SHA384 = hexBytes("300a06082a8648ce3d040303");

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
