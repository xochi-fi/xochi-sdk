// `AttestationVerifier` for the CLI: the vendored, unmodified `verify_nitro_attestation.ts`
// (node:crypto X509Certificate and ES384 verify; `./vendor/README.md`), exactly what
// `verifyTeeAttestation` ran before the core took the verifier as a port.

import { verifyNitroAttestation } from "./vendor/nitro_attestation/verify_nitro_attestation.js";
import type {
  AttestationVerifier,
  NitroAttestationInput,
  ParsedNitroAttestation,
} from "../core/ports.js";

const buffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);

export class NodeAttestationVerifier implements AttestationVerifier {
  async verifyNitroAttestation(input: NitroAttestationInput): Promise<ParsedNitroAttestation> {
    return verifyNitroAttestation({
      attestationDocument: buffer(input.attestationDocument),
      trustedRootCertificates: input.trustedRootCertificates.map(buffer),
      expectedUserData: input.expectedUserData && buffer(input.expectedUserData),
      expectedNonce: input.expectedNonce && buffer(input.expectedNonce),
      now: input.now,
    });
  }
}
