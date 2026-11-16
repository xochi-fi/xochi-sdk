// The few DER reads the certificate signature check needs, done here so the bytes compared are
// exactly the certificate's own (@peculiar/x509 re-encodes or tolerates what OpenSSL refuses).

interface DerElement {
  tag: number;
  contentStart: number;
  end: number;
}

/**
 * One element of an already-parsed certificate. Long-form lengths are read as OpenSSL reads
 * them (not required to be minimal); indefinite lengths and overruns are refused.
 */
function readElement(bytes: Uint8Array, offset: number, limit: number): DerElement {
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  if (tag === undefined || first === undefined || first === 0x80 || first > 0x84) {
    throw new Error(`malformed DER element at offset ${offset}`);
  }
  let length = first;
  let contentStart = offset + 2;
  if (first > 0x80) {
    length = 0;
    for (let i = 0; i < first - 0x80; i++) {
      length = length * 256 + (bytes[contentStart + i] ?? 0);
    }
    contentStart += first - 0x80;
  }
  const end = contentStart + length;
  if (end > limit) {
    throw new Error(`DER element at offset ${offset} overruns its container`);
  }
  return { tag, contentStart, end };
}

function expectTag(element: DerElement, tag: number, name: string): DerElement {
  if (element.tag !== tag) {
    throw new Error(
      `${name}: expected DER tag 0x${tag.toString(16)}, got 0x${element.tag.toString(16)}`,
    );
  }
  return element;
}

export interface CertificateSignatureFields {
  /** The signed bytes: the TBSCertificate element, header included. */
  tbs: Uint8Array;
  /** TBSCertificate.signature, the whole AlgorithmIdentifier element. */
  tbsSignatureAlgorithm: Uint8Array;
  /** Certificate.signatureAlgorithm, the whole AlgorithmIdentifier element. */
  signatureAlgorithm: Uint8Array;
  /** Certificate.signatureValue BIT STRING contents: the unused-bits octet, then the bits. */
  signatureValue: Uint8Array;
}

/** Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING } */
export function certificateSignatureFields(der: Uint8Array): CertificateSignatureFields {
  const certificate = expectTag(readElement(der, 0, der.length), 0x30, "Certificate");
  const tbs = expectTag(
    readElement(der, certificate.contentStart, certificate.end),
    0x30,
    "TBSCertificate",
  );
  const signatureAlgorithm = expectTag(
    readElement(der, tbs.end, certificate.end),
    0x30,
    "signatureAlgorithm",
  );
  const signatureValue = expectTag(
    readElement(der, signatureAlgorithm.end, certificate.end),
    0x03,
    "signatureValue",
  );

  // TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature, ... }
  let field = readElement(der, tbs.contentStart, tbs.end);
  if (field.tag === 0xa0) {
    field = readElement(der, field.end, tbs.end);
  }
  expectTag(field, 0x02, "serialNumber");
  const tbsSignatureAlgorithm = expectTag(
    readElement(der, field.end, tbs.end),
    0x30,
    "TBSCertificate.signature",
  );

  return {
    tbs: der.subarray(certificate.contentStart, tbs.end),
    tbsSignatureAlgorithm: der.subarray(field.end, tbsSignatureAlgorithm.end),
    signatureAlgorithm: der.subarray(tbs.end, signatureAlgorithm.end),
    signatureValue: der.subarray(signatureValue.contentStart, signatureValue.end),
  };
}

/** A DER length that is minimal (X.690 10.1), or null. */
function strictLength(bytes: Uint8Array, offset: number): { length: number; next: number } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, next: offset + 1 };
  const second = bytes[offset + 1];
  if (first === 0x81 && second !== undefined && second >= 0x80) {
    return { length: second, next: offset + 2 };
  }
  const third = bytes[offset + 2];
  if (first === 0x82 && second !== undefined && second !== 0 && third !== undefined) {
    return { length: second * 256 + third, next: offset + 3 };
  }
  return null;
}

/** A minimal, non-negative DER INTEGER: its magnitude (no sign octet) and where it ends, or null. */
function strictUnsignedInteger(
  bytes: Uint8Array,
  offset: number,
): { magnitude: Uint8Array; next: number } | null {
  if (bytes[offset] !== 0x02) return null;
  const length = strictLength(bytes, offset + 1);
  if (length === null || length.length === 0) return null;
  const end = length.next + length.length;
  if (end > bytes.length) return null;
  const first = bytes[length.next] ?? 0;
  const second = length.length > 1 ? bytes[length.next + 1] : undefined;
  if (first >= 0x80) return null;
  if (first === 0 && second !== undefined && second < 0x80) return null;
  const magnitudeStart = first === 0 && second !== undefined ? length.next + 1 : length.next;
  return { magnitude: bytes.subarray(magnitudeStart, end), next: end };
}

/**
 * ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } in exact DER, as OpenSSL requires (it
 * re-encodes the parsed value and compares): minimal lengths, minimal non-negative integers,
 * nothing after. Returns the magnitudes of r and s, or null for anything else.
 */
export function strictEcdsaSignature(bytes: Uint8Array): { r: Uint8Array; s: Uint8Array } | null {
  if (bytes[0] !== 0x30) return null;
  const length = strictLength(bytes, 1);
  if (length === null || length.next + length.length !== bytes.length) return null;
  const r = strictUnsignedInteger(bytes, length.next);
  if (r === null) return null;
  const s = strictUnsignedInteger(bytes, r.next);
  if (s === null || s.next !== bytes.length) return null;
  return { r: r.magnitude, s: s.magnitude };
}
