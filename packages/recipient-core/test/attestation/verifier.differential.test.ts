/// <reference types="node" />
import { Buffer } from "node:buffer";
import { X509Certificate } from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { WebCryptoAttestationVerifier } from "../../src/attestation/index.js";
import type { NitroAttestationInput } from "../../src/ports.js";
import {
  AWS_NITRO_ROOT_G1_PEM,
  SYNTHETIC_TIMESTAMP,
  awsNitroRootDer,
  der,
  encodeIndefiniteMap,
  encodeCoseSign1,
  loadVendoredParsers,
  loadVendoredVerifier,
  realFixture,
  runPort,
  runVendored,
  selfSigned,
  syntheticChain,
  syntheticDocument,
  assembleCertificate,
  certificateParts,
  ecdsaIntegers,
  ecdsaSigValue,
  signTbs,
  ECDSA_WITH_SHA384,
  type SyntheticChain,
  type CborValue,
  type Outcome,
  type VendoredParsersModule,
  type VendoredVerifierModule,
} from "./support.js";

let vendored: VendoredVerifierModule;
let parsers: VendoredParsersModule;
beforeAll(async () => {
  vendored = await loadVendoredVerifier();
  parsers = await loadVendoredParsers();
});

/** A clock nothing in these cases should read: every case has a timestamp or an explicit `now`. */
const unusedClock = {
  nowMs(): number {
    throw new Error("clock read");
  },
};

async function differential(
  input: NitroAttestationInput,
): Promise<{ node: Outcome; port: Outcome }> {
  const verifier = new WebCryptoAttestationVerifier(unusedClock);
  const node = runVendored(vendored, input);
  const port = await runPort((i) => verifier.verifyNitroAttestation(i), input);
  return { node, port };
}

const ISSUER_NOT_FOUND = "could not find issuer for Nitro certificate subject ";

/**
 * Same accept/reject, the same parsed output on accept and the same error message on reject. The
 * one message that differs is the subject in ISSUER_NOT_FOUND: Node prints it the OpenSSL way
 * ("C=US\nO=Amazon..."), @peculiar/x509 the RFC 4514 way ("C=US, O=Amazon...").
 */
function expectSameOutcome({ node, port }: { node: Outcome; port: Outcome }): void {
  if (!node.ok && !port.ok && node.message.startsWith(ISSUER_NOT_FOUND)) {
    expect(port.message.startsWith(ISSUER_NOT_FOUND)).toBe(true);
    return;
  }
  expect(port).toEqual(node);
}

async function expectBothAccept(input: NitroAttestationInput): Promise<void> {
  const outcomes = await differential(input);
  expect(outcomes.node.ok).toBe(true);
  expectSameOutcome(outcomes);
}

async function expectBothReject(
  input: NitroAttestationInput,
  message: string | RegExp,
): Promise<void> {
  const outcomes = await differential(input);
  expect(outcomes.node.ok).toBe(false);
  expect(outcomes.node.ok ? "" : outcomes.node.message).toMatch(message);
  expectSameOutcome(outcomes);
}

/**
 * Bytes that are neither a PEM CERTIFICATE block nor DER: OpenSSL (Node) reports its PEM parser's
 * error, the port its own. Same refusal, different text.
 */
async function expectBothRefuseCertificateBytes(input: NitroAttestationInput): Promise<void> {
  const { node, port } = await differential(input);
  expect(node).toEqual({ ok: false, message: "error:0480006C:PEM routines::no start line" });
  expect(port).toEqual({ ok: false, message: "X.509 certificate is neither PEM nor DER" });
}

/** A known difference, fail-closed: the vendored verifier accepts, the port refuses. */
async function expectPortStricter(input: NitroAttestationInput, message: string): Promise<void> {
  const { node, port } = await differential(input);
  expect(node.ok).toBe(true);
  expect(port).toEqual({ ok: false, message });
}

describe("WebCryptoAttestationVerifier vs vendored verifyNitroAttestation: real fleet document", () => {
  const fixture = realFixture();
  const root = awsNitroRootDer();
  // Leaf validity of the fixture (2026-10-26 12:07:03Z .. 15:07:06Z); timestamp 12:07:06.538Z.
  const leafNotBefore = Date.parse("2026-10-26T12:07:03Z");
  const leafNotAfter = Date.parse("2026-10-26T15:07:06Z");

  function decodeDocument(): {
    protectedHeaders: Buffer;
    payload: Map<CborValue, CborValue>;
    payloadBytes: Buffer;
    signature: Buffer;
  } {
    const cose = parsers.parseCoseSign1(Buffer.from(fixture.document));
    const payload = parsers.decodeCbor(cose.payloadBytes);
    if (!(payload instanceof Map)) throw new Error("fixture payload is not a CBOR map");
    return { ...cose, payload };
  }

  /** Re-encodes the fixture with a changed payload (and therefore an invalid COSE signature). */
  function withPayload(mutate: (payload: Map<CborValue, CborValue>) => void): Uint8Array {
    const { protectedHeaders, payload, signature } = decodeDocument();
    mutate(payload);
    return encodeCoseSign1({
      protectedHeaders,
      payloadBytes: encodeIndefiniteMap(payload),
      signature,
    });
  }

  function caBundle(payload: Map<CborValue, CborValue>): Buffer[] {
    const bundle = payload.get("cabundle");
    if (!Array.isArray(bundle)) throw new Error("fixture cabundle is not an array");
    return bundle as Buffer[];
  }

  const base = (): NitroAttestationInput => ({
    attestationDocument: fixture.document,
    trustedRootCertificates: [root],
    expectedUserData: fixture.userData,
  });

  it("the test encoder rebuilds the fixture byte for byte", () => {
    const { protectedHeaders, payload, payloadBytes, signature } = decodeDocument();
    expect(Buffer.from(encodeIndefiniteMap(payload)).equals(payloadBytes)).toBe(true);
    const rebuilt = encodeCoseSign1({ protectedHeaders, payloadBytes, signature });
    expect(Buffer.from(rebuilt).equals(Buffer.from(fixture.document))).toBe(true);
  });

  it("accepts the real document under the pinned AWS root with its user_data binding", async () => {
    await expectBothAccept(base());
  });

  it("accepts it without bindings", async () => {
    await expectBothAccept({
      attestationDocument: fixture.document,
      trustedRootCertificates: [root],
    });
  });

  it("accepts the pinned root given as PEM bytes", async () => {
    await expectBothAccept({
      ...base(),
      trustedRootCertificates: [new TextEncoder().encode(AWS_NITRO_ROOT_G1_PEM)],
    });
  });

  describe("the pinned root as PEM text, read as OpenSSL reads it", () => {
    const pem = `${AWS_NITRO_ROOT_G1_PEM}\n`;
    const [, firstBodyLine = "", secondBodyLine = ""] = pem.split("\n");
    const latin1 = (text: string): Uint8Array =>
      Uint8Array.from(text, (char) => char.charCodeAt(0));
    const withRoot = (text: string): NitroAttestationInput => ({
      ...base(),
      trustedRootCertificates: [latin1(text)],
    });

    it("accepts the layouts OpenSSL accepts", async () => {
      const body = pem.split("\n").slice(1, -2).join("");
      for (const text of [
        pem.replace(secondBodyLine, `${secondBodyLine.slice(0, 5)} \t\r${secondBodyLine.slice(5)}`),
        `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        `-----BEGIN CERTIFICATE-----\n${body.slice(0, 7)}\n${body.slice(7)}\n-----END CERTIFICATE-----\n`,
        pem.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE----- \t"),
        `-----BEGIN FOO-----\nAAAA\n-----END FOO-----\n${pem}`,
        `${pem}trailing text`,
      ]) {
        await expectBothAccept(withRoot(text));
      }
    });

    async function expectBothRefuse(text: string, portMessage: string): Promise<void> {
      const { node, port } = await differential(withRoot(text));
      expect(node.ok).toBe(false);
      expect(port).toEqual({ ok: false, message: portMessage });
    }

    it("refuses unpadded base64", async () => {
      expect(pem).toContain("Y=\n-----END");
      await expectBothRefuse(
        pem.replace("Y=\n-----END", "Y\n-----END"),
        "PEM CERTIFICATE block is not base64",
      );
    });

    it("refuses padding before the end of the body", async () => {
      await expectBothRefuse(
        pem.replace("Y=\n-----END", "Y=\nAAAA\n-----END"),
        "PEM CERTIFICATE block is not base64",
      );
    });

    it("refuses a no-break space (0xA0) in the body", async () => {
      await expectBothRefuse(
        pem.replace(secondBodyLine, `\u00a0${secondBodyLine}`),
        "PEM CERTIFICATE block is not base64",
      );
    });

    it("refuses text after the END marker on its line", async () => {
      await expectBothRefuse(
        pem.replace("-----END CERTIFICATE-----", "-----END CERTIFICATE-----junk"),
        "PEM CERTIFICATE block has a bad END line",
      );
    });

    it("refuses a certificate block nested inside another block", async () => {
      await expectBothRefuse(
        `-----BEGIN FOO-----\n${pem}-----END FOO-----\n`,
        "PEM FOO block has a bad END line",
      );
      await expectBothRefuse(
        `-----BEGIN FOO-----\nAAAA\n${pem}`,
        "PEM FOO block has a bad END line",
      );
    });

    it("refuses a blank line inside the body and RFC 1421 headers", async () => {
      for (const text of [
        pem.replace(secondBodyLine, `\n${secondBodyLine}`),
        pem.replace(firstBodyLine, `Proc-Type: 4,ENCRYPTED\n\n${firstBodyLine}`),
        pem.replace(secondBodyLine, `AB:CD\n${secondBodyLine}`),
      ]) {
        await expectBothRefuse(text, "PEM CERTIFICATE block has a blank or header line");
      }
    });

    it("refuses a blank line right after BEGIN, which OpenSSL reads as an empty header", async () => {
      await expectPortStricter(
        withRoot(pem.replace(firstBodyLine, `\n${firstBodyLine}`)),
        "PEM CERTIFICATE block has a blank or header line",
      );
    });
  });

  it("refuses an empty trusted root list, which the vendored verifier accepts unpinned", async () => {
    await expectPortStricter(
      { ...base(), trustedRootCertificates: [] },
      "at least one trusted root is required",
    );
  });

  describe("validation time", () => {
    it("defaults to the document timestamp although the leaf has long expired", async () => {
      await expectBothAccept(base());
    });

    it("accepts an explicit now at the leaf's notBefore and at its notAfter (inclusive)", async () => {
      await expectBothAccept({ ...base(), now: new Date(leafNotBefore) });
      await expectBothAccept({ ...base(), now: new Date(leafNotAfter) });
    });

    it("refuses a leaf not yet valid at an explicit now", async () => {
      await expectBothReject(
        { ...base(), now: new Date(leafNotBefore - 1) },
        "Nitro leaf certificate is not valid at 2026-10-26T12:07:02.999Z",
      );
    });

    it("refuses a leaf expired at an explicit now", async () => {
      await expectBothReject(
        { ...base(), now: new Date(leafNotAfter + 1) },
        "Nitro leaf certificate is not valid at 2026-10-26T15:07:06.001Z",
      );
    });
  });

  describe("bindings", () => {
    it("refuses a wrong expectedUserData", async () => {
      const wrong = Uint8Array.from(fixture.userData);
      wrong[0] = (wrong[0] ?? 0) ^ 1;
      await expectBothReject(
        { ...base(), expectedUserData: wrong },
        "Nitro user_data does not match expected binding",
      );
    });

    it("refuses a wrong expectedNonce (the document carries none)", async () => {
      await expectBothReject(
        { ...base(), expectedNonce: new Uint8Array(32).fill(7) },
        "Nitro nonce does not match expected binding",
      );
    });
  });

  describe("COSE envelope", () => {
    it("refuses a flipped COSE signature byte", async () => {
      const { protectedHeaders, payloadBytes, signature } = decodeDocument();
      const flipped = Buffer.from(signature);
      flipped[10] = (flipped[10] ?? 0) ^ 0x01;
      await expectBothReject(
        {
          ...base(),
          attestationDocument: encodeCoseSign1({
            protectedHeaders,
            payloadBytes,
            signature: flipped,
          }),
        },
        "Nitro COSE signature verification failed",
      );
    });

    it("refuses a COSE signature that is not 96 bytes", async () => {
      const { protectedHeaders, payloadBytes, signature } = decodeDocument();
      await expectBothReject(
        {
          ...base(),
          attestationDocument: encodeCoseSign1({
            protectedHeaders,
            payloadBytes,
            signature: signature.subarray(0, 95),
          }),
        },
        "COSE ES384 signature must be 96 bytes, got 95",
      );
    });

    it("refuses a flipped payload byte", async () => {
      const { protectedHeaders, payloadBytes, signature } = decodeDocument();
      const at = payloadBytes.indexOf(Buffer.from(fixture.userData));
      expect(at).toBeGreaterThan(0);
      const flipped = Buffer.from(payloadBytes);
      flipped[at] = (flipped[at] ?? 0) ^ 0x01;
      const attestationDocument = encodeCoseSign1({
        protectedHeaders,
        payloadBytes: flipped,
        signature,
      });
      await expectBothReject(
        { attestationDocument, trustedRootCertificates: [root] },
        "Nitro COSE signature verification failed",
      );
      await expectBothReject(
        { ...base(), attestationDocument },
        "Nitro user_data does not match expected binding",
      );
    });

    it("refuses a wrong COSE algorithm header", async () => {
      const { payloadBytes, signature } = decodeDocument();
      const es256 = Uint8Array.of(0xa1, 0x01, 0x26);
      await expectBothReject(
        {
          ...base(),
          attestationDocument: encodeCoseSign1({
            protectedHeaders: es256,
            payloadBytes,
            signature,
          }),
        },
        "expected COSE alg ES384 (-35), got -7n",
      );
      await expectBothReject(
        {
          ...base(),
          attestationDocument: encodeCoseSign1({
            protectedHeaders: Uint8Array.of(0xa0),
            payloadBytes,
            signature,
          }),
        },
        "expected COSE alg ES384 (-35), got undefined",
      );
    });

    it("refuses a truncated document at sampled lengths", async () => {
      for (const length of [0, 1, 2, 10, 100, 2000, fixture.document.length - 1]) {
        await expectBothReject(
          { ...base(), attestationDocument: fixture.document.subarray(0, length) },
          /unexpected end of CBOR/,
        );
      }
    });

    it("refuses trailing bytes after the document", async () => {
      const extended = Uint8Array.from([...fixture.document, 0x00]);
      await expectBothReject(
        { ...base(), attestationDocument: extended },
        "trailing CBOR bytes: 1",
      );
    });
  });

  describe("certificate chain", () => {
    it("still walks a reordered CA bundle, then refuses the re-encoded payload's signature", async () => {
      const attestationDocument = withPayload((payload) => {
        const bundle = caBundle(payload);
        payload.set("cabundle", [bundle[2], bundle[0], bundle[3], bundle[1]] as Buffer[]);
      });
      await expectBothReject(
        { ...base(), attestationDocument },
        "Nitro COSE signature verification failed",
      );
    });

    it("refuses a CA bundle with an issuing certificate removed", async () => {
      for (const removed of [1, 2, 3]) {
        const attestationDocument = withPayload((payload) => {
          payload.set(
            "cabundle",
            caBundle(payload).filter((_, i) => i !== removed),
          );
        });
        await expectBothReject({ ...base(), attestationDocument }, ISSUER_NOT_FOUND);
      }
    });

    it("refuses a CA bundle with an issuing certificate swapped for another", async () => {
      const attestationDocument = withPayload((payload) => {
        const bundle = caBundle(payload);
        payload.set("cabundle", [bundle[0], bundle[1], bundle[1], bundle[3]] as Buffer[]);
      });
      await expectBothReject({ ...base(), attestationDocument }, ISSUER_NOT_FOUND);
    });

    it("refuses an empty CA bundle", async () => {
      const attestationDocument = withPayload((payload) => payload.set("cabundle", []));
      await expectBothReject(
        { ...base(), attestationDocument },
        "Nitro cabundle must contain at least one issuing certificate",
      );
    });

    it("refuses a chain that does not end in the trusted root", async () => {
      const { payload } = decodeDocument();
      const intermediate = caBundle(payload)[1] as Buffer;
      const unrelated = await selfSigned("C=US, O=Amazon, OU=AWS, CN=aws.nitro-enclaves");
      for (const wrongRoot of [new Uint8Array(intermediate), der(unrelated.cert)]) {
        await expectBothReject(
          { ...base(), trustedRootCertificates: [wrongRoot] },
          "Nitro certificate chain does not terminate in a trusted root",
        );
      }
      await expectBothAccept({ ...base(), trustedRootCertificates: [der(unrelated.cert), root] });
    });
  });
});

describe("WebCryptoAttestationVerifier vs vendored verifyNitroAttestation: synthetic chains", () => {
  it("accepts a synthetic document with nonce and user_data bindings, refuses a wrong nonce", async () => {
    const chain = await syntheticChain();
    const nonce = new Uint8Array(32).fill(0xab);
    const userData = new Uint8Array(32).fill(0xcd);
    const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
      nonce,
      userData,
    });
    const input = {
      attestationDocument,
      trustedRootCertificates: [der(chain.root)],
      expectedNonce: nonce,
      expectedUserData: userData,
    };
    await expectBothAccept(input);
    await expectBothReject(
      { ...input, expectedNonce: new Uint8Array(32).fill(0xac) },
      "Nitro nonce does not match expected binding",
    );
  });

  it("accepts a synthetic chain whose bundle puts a same-subject P-256 impostor before the issuer", async () => {
    const chain = await syntheticChain();
    const impostor = await selfSigned(chain.root.subject, "P-256");
    const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(impostor.cert), der(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
    });
    await expectBothAccept({ attestationDocument, trustedRootCertificates: [der(chain.root)] });
  });

  // OpenSSL fails to decode the impostor's key when the vendored walk reads `candidate.publicKey`
  // and the whole verification throws; WebCrypto's importKey throws a DataError at the same
  // step. Skipping the candidate instead would accept what the vendored verifier refuses.
  it("refuses, like OpenSSL, a same-subject candidate whose key point is not on the curve", async () => {
    const chain = await syntheticChain();
    const impostor = await selfSigned(chain.root.subject);
    const point = new Uint8Array(await crypto.subtle.exportKey("raw", impostor.keys.publicKey));
    const impostorDer = der(impostor.cert);
    const at = Buffer.from(impostorDer).indexOf(Buffer.from(point));
    expect(at).toBeGreaterThan(0);
    const offCurve = Uint8Array.from(impostorDer);
    const lastByte = at + point.length - 1;
    offCurve[lastByte] = (offCurve[lastByte] ?? 0) ^ 0x01;
    const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [offCurve, der(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
    });
    const { node, port } = await differential({
      attestationDocument,
      trustedRootCertificates: [der(chain.root)],
    });
    expect(node).toEqual({
      ok: false,
      message: "error:03000072:digital envelope routines::decode error",
    });
    expect(port).toEqual({ ok: false, message: "Invalid keyData" });
  });

  it("accepts certificates given as PEM, in the document and as the trusted root", async () => {
    const chain = await syntheticChain();
    const pem = (cert: typeof chain.root): Uint8Array =>
      new TextEncoder().encode(cert.toString("pem"));
    const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: pem(chain.leaf),
      caBundle: [pem(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
    });
    await expectBothAccept({ attestationDocument, trustedRootCertificates: [pem(chain.root)] });
  });

  it("refuses certificates given as base64 or hex text, which Node cannot parse", async () => {
    const chain = await syntheticChain();
    for (const format of ["base64", "hex"] as const) {
      const text = new TextEncoder().encode(chain.root.toString(format));
      const inBundle = await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: [text],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      await expectBothRefuseCertificateBytes({
        attestationDocument: inBundle,
        trustedRootCertificates: [der(chain.root)],
      });
      const valid = await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: [der(chain.root)],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      await expectBothRefuseCertificateBytes({
        attestationDocument: valid,
        trustedRootCertificates: [text],
      });
    }
  });

  it("refuses a document over 64 KiB, which the vendored verifier parses", async () => {
    const chain = await syntheticChain();
    const withUserData = async (size: number) => ({
      attestationDocument: await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: [der(chain.root)],
        timestamp: SYNTHETIC_TIMESTAMP,
        userData: new Uint8Array(size).fill(7),
      }),
      trustedRootCertificates: [der(chain.root)],
    });
    await expectBothAccept(await withUserData(60_000));
    const oversized = await withUserData(70_000);
    await expectPortStricter(
      oversized,
      `Nitro attestation document must be at most 65536 bytes, got ${oversized.attestationDocument.length}`,
    );
  });

  // The vendored verifier: new Date(Number(timestamp)) is an Invalid Date past 8.64e15 ms (or
  // for now = new Date(NaN)), and NaN comparisons make every certificate "valid". The port
  // refuses an invalid validation time.
  it("refuses a validation time that is not a valid date, which the vendored verifier accepts", async () => {
    const chain = await syntheticChain();
    const beyondDateRange = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(chain.root)],
      timestamp: 2n ** 60n,
    });
    const roots = [der(chain.root)];
    await expectPortStricter(
      { attestationDocument: beyondDateRange, trustedRootCertificates: roots },
      "Nitro validation time is not a valid date",
    );
    const timed = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
    });
    await expectPortStricter(
      { attestationDocument: timed, trustedRootCertificates: roots, now: new Date(Number.NaN) },
      "Nitro validation time is not a valid date",
    );
  });

  it("accepts 16 bundle certificates, refuses 17, which the vendored verifier walks", async () => {
    const chain = await syntheticChain();
    const withBundle = async (size: number) => ({
      attestationDocument: await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: Array.from({ length: size }, () => der(chain.root)),
        timestamp: SYNTHETIC_TIMESTAMP,
      }),
      trustedRootCertificates: [der(chain.root)],
    });
    await expectBothAccept(await withBundle(16));
    await expectPortStricter(
      await withBundle(17),
      "Nitro cabundle must contain at most 16 certificates, got 17",
    );
  });

  describe("certificate signature encodings (OpenSSL accepts only exact DER)", () => {
    async function documentWithLeaf(chain: SyntheticChain, leaf: Uint8Array) {
      const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: leaf,
        caBundle: [der(chain.root)],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      return { attestationDocument, trustedRootCertificates: [der(chain.root)] };
    }

    /** The leaf with its signatureValue BIT STRING contents replaced. */
    async function leafWithSignatureBits(
      chain: SyntheticChain,
      rewrite: (bits: Uint8Array) => Uint8Array,
    ) {
      const parts = certificateParts(der(chain.leaf));
      return documentWithLeaf(
        chain,
        assembleCertificate({ ...parts, signatureBits: rewrite(parts.signatureBits) }),
      );
    }

    const withSignature = (sig: Uint8Array): Uint8Array => Uint8Array.of(0, ...sig);

    it("accepts the leaf reassembled unchanged (control)", async () => {
      const chain = await syntheticChain();
      await expectBothAccept(await leafWithSignatureBits(chain, (bits) => bits));
    });

    it("refuses an ECDSA r with a superfluous leading zero", async () => {
      const chain = await syntheticChain();
      const input = await leafWithSignatureBits(chain, (bits) => {
        const { r, s } = ecdsaIntegers(bits.subarray(1));
        return withSignature(ecdsaSigValue(Uint8Array.of(0, ...r), s));
      });
      await expectBothReject(input, ISSUER_NOT_FOUND);
    });

    it("refuses an ECDSA r encoded as a negative INTEGER", async () => {
      let chain = await syntheticChain();
      while (ecdsaIntegers(certificateParts(der(chain.leaf)).signatureBits.subarray(1)).r[0]) {
        chain = await syntheticChain();
      }
      const input = await leafWithSignatureBits(chain, (bits) => {
        const { r, s } = ecdsaIntegers(bits.subarray(1));
        return withSignature(ecdsaSigValue(r.subarray(1), s));
      });
      await expectBothReject(input, ISSUER_NOT_FOUND);
    });

    it("refuses a long-form length where the short form fits", async () => {
      const chain = await syntheticChain();
      const input = await leafWithSignatureBits(chain, (bits) => {
        const sig = bits.subarray(1);
        return withSignature(Uint8Array.of(0x30, 0x81, ...sig.subarray(1)));
      });
      await expectBothReject(input, ISSUER_NOT_FOUND);
    });

    it("refuses bytes after the ECDSA-Sig-Value", async () => {
      const chain = await syntheticChain();
      const input = await leafWithSignatureBits(chain, (bits) => Uint8Array.of(...bits, 0));
      await expectBothReject(input, ISSUER_NOT_FOUND);
    });

    it("refuses a signature BIT STRING with unused bits", async () => {
      const chain = await syntheticChain();
      const input = await leafWithSignatureBits(chain, (bits) =>
        Uint8Array.of(1, ...bits.subarray(1)),
      );
      await expectBothReject(input, ISSUER_NOT_FOUND);
    });

    it("refuses an outer signatureAlgorithm that differs from the TBS signature field", async () => {
      // TBS says ecdsa-with-SHA256; the certificate is signed, and labelled outside, SHA-384.
      const chain = await syntheticChain(undefined, "SHA-256");
      const { tbs } = certificateParts(der(chain.leaf));
      const signature = await signTbs(chain.rootKeys.privateKey, "SHA-384", tbs);
      const leaf = assembleCertificate({
        tbs,
        signatureAlgorithm: ECDSA_WITH_SHA384,
        signatureBits: withSignature(signature),
      });
      await expectBothReject(await documentWithLeaf(chain, leaf), ISSUER_NOT_FOUND);
    });
  });

  describe("PEM framing", () => {
    const pemOf = (chain: SyntheticChain, label = "CERTIFICATE", eol = "\n"): string =>
      chain.root
        .toString("pem")
        .replace(/CERTIFICATE/g, label)
        .replace(/\r?\n/g, eol);

    async function withRoot(chain: SyntheticChain, root: string) {
      const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: [der(chain.root)],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      return { attestationDocument, trustedRootCertificates: [new TextEncoder().encode(root)] };
    }

    it("accepts a PEM block after other lines, and with CRLF line ends", async () => {
      const chain = await syntheticChain();
      await expectBothAccept(await withRoot(chain, `Subject: root\nIssuer: root\n${pemOf(chain)}`));
      await expectBothAccept(await withRoot(chain, pemOf(chain, "CERTIFICATE", "\r\n")));
    });

    it("refuses a BEGIN marker that does not start a line", async () => {
      const chain = await syntheticChain();
      await expectBothRefuseCertificateBytes(await withRoot(chain, `x${pemOf(chain)}`));
    });

    it("refuses the X509 CERTIFICATE and TRUSTED CERTIFICATE labels OpenSSL also reads", async () => {
      const chain = await syntheticChain();
      for (const label of ["X509 CERTIFICATE", "TRUSTED CERTIFICATE"]) {
        await expectPortStricter(
          await withRoot(chain, pemOf(chain, label)),
          `unsupported PEM label: ${label}`,
        );
      }
    });

    it("refuses many BEGIN lines without an END line", async () => {
      const chain = await syntheticChain();
      const { node, port } = await differential(
        await withRoot(chain, "-----BEGIN CERTIFICATE-----\n".repeat(500)),
      );
      expect(node.ok).toBe(false);
      expect(port).toEqual({ ok: false, message: "PEM CERTIFICATE block has no END line" });
    });

    it("refuses certificate bytes over 16 KiB before reading them, which Node reads", async () => {
      const chain = await syntheticChain();
      const padded = `${"comment line\n".repeat(1_300)}${pemOf(chain)}`;
      expect(padded.length).toBeGreaterThan(16_384);
      await expectPortStricter(
        await withRoot(chain, padded),
        `X.509 certificate must be at most 16384 bytes, got ${padded.length}`,
      );
      await expectBothAccept(
        await withRoot(chain, `${"comment line\n".repeat(1_000)}${pemOf(chain)}`),
      );
    });

    it("refuses 50,000 BEGIN lines quickly", { timeout: 5_000 }, async () => {
      const chain = await syntheticChain();
      const text = "-----BEGIN CERTIFICATE-----\n".repeat(50_000);
      const { node, port } = await differential(await withRoot(chain, text));
      expect(node.ok).toBe(false);
      expect(port).toEqual({
        ok: false,
        message: `X.509 certificate must be at most 16384 bytes, got ${text.length}`,
      });
    });
  });

  describe("forged chains against the real AWS Nitro root", () => {
    const awsRoot = awsNitroRootDer();
    const awsSubject = new X509Certificate(awsRoot.slice()).subject;

    it("refuses an attacker chain whose root copies the AWS subject DN", async () => {
      const chain = await syntheticChain(awsSubject);
      expect(chain.root.subject).toBe(awsSubject);
      const attestationDocument = await syntheticDocument(chain.leafKeys.privateKey, {
        certificate: der(chain.leaf),
        caBundle: [der(chain.root)],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      const selfPinned = { attestationDocument, trustedRootCertificates: [der(chain.root)] };
      await expectBothAccept(selfPinned);
      await expectBothReject(
        { attestationDocument, trustedRootCertificates: [awsRoot] },
        "Nitro certificate chain does not terminate in a trusted root",
      );
    });

    it("refuses a self-signed leaf (no walk at all)", async () => {
      const leaf = await selfSigned("CN=Attacker Enclave, O=Test, C=US");
      const filler = await selfSigned("CN=Attacker Filler, O=Test, C=US");
      const attestationDocument = await syntheticDocument(leaf.keys.privateKey, {
        certificate: der(leaf.cert),
        caBundle: [der(filler.cert)],
        timestamp: SYNTHETIC_TIMESTAMP,
      });
      await expectBothReject(
        { attestationDocument, trustedRootCertificates: [awsRoot] },
        "Nitro certificate chain does not terminate in a trusted root",
      );
    });
  });

  it("refuses a document signed by a key other than the leaf's", async () => {
    const chain = await syntheticChain();
    const other = await syntheticChain();
    const attestationDocument = await syntheticDocument(other.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(chain.root)],
      timestamp: SYNTHETIC_TIMESTAMP,
    });
    await expectBothReject(
      { attestationDocument, trustedRootCertificates: [der(chain.root)] },
      "Nitro COSE signature verification failed",
    );
  });
});
