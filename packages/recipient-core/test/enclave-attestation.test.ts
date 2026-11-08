// The enclave check trusts only what the injected verifier returns: the parsed document must
// commit to the keys the enclave announced (user data) and to the pinned image (PCR0), whatever
// the verifier itself checked.

import { Buffer32 } from "@aztec-labs/foundation/buffer";
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { WebCryptoAttestationVerifier } from "../src/attestation/index.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { EnclaveTrustRefused, verifyEnclaveAttestation } from "../src/oxide/enclave.js";
import { oxidePins } from "../src/oxide/pins.js";
import { getPcr0 } from "../src/oxide/vendor/oxide-lib/attestation/pcr0.js";
import type { AttestationData } from "../src/oxide/vendor/oxide-lib/attestation/attestation_data.js";
import type { AttestationVerifier, ParsedNitroAttestation } from "../src/ports.js";

const raw = JSON.parse(
  readFileSync(new URL("./attestation/fixtures/attestation-0xcb88.json", import.meta.url), "utf8"),
) as {
  attestation: string;
  userData: Record<"publicKeyX" | "publicKeyY" | "encPubKeyX" | "encPubKeyY", string>;
};
const attestation: AttestationData = {
  attestation: Buffer.from(raw.attestation, "base64"),
  userData: {
    publicKeyX: Buffer32.fromString(raw.userData.publicKeyX),
    publicKeyY: Buffer32.fromString(raw.userData.publicKeyY),
    encPubKeyX: Buffer32.fromString(raw.userData.encPubKeyX),
    encPubKeyY: Buffer32.fromString(raw.userData.encPubKeyY),
  },
};
const pcr0 = getPcr0(attestation.attestation);
const pins = { ...oxidePins(OXDAI_MAINNET_REV2), pcr0: Buffer.from(pcr0).toString("hex") };
const onChain = keccak256(pcr0);
const clock = { nowMs: () => Date.parse("2026-11-08T00:00:00Z") };

/** A verifier that accepts and returns what the real one parsed, altered by `alter`. */
function lying(
  alter: (parsed: ParsedNitroAttestation) => ParsedNitroAttestation,
): AttestationVerifier {
  const real = new WebCryptoAttestationVerifier(clock);
  return {
    async verifyNitroAttestation(input) {
      return alter(await real.verifyNitroAttestation(input));
    },
  };
}

const refusal = (promise: Promise<void>) =>
  expect(promise).rejects.toSatisfy(
    (error) => error instanceof EnclaveTrustRefused && error.reason === "attestation_invalid",
  );

describe("enclave attestation result", () => {
  it("accepts the real fixture under the real verifier", async () => {
    await expect(
      verifyEnclaveAttestation(attestation, onChain, pins, new WebCryptoAttestationVerifier(clock)),
    ).resolves.toBeUndefined();
  });

  it("refuses a verifier result whose user data is not the announced keys'", async () => {
    await refusal(
      verifyEnclaveAttestation(
        attestation,
        onChain,
        pins,
        lying((parsed) => ({ ...parsed, userData: new Uint8Array(32) })),
      ),
    );
    await refusal(
      verifyEnclaveAttestation(
        attestation,
        onChain,
        pins,
        lying(({ userData: _dropped, ...parsed }) => parsed),
      ),
    );
  });

  it("refuses a verifier result whose PCR0 is not the pinned image", async () => {
    await refusal(
      verifyEnclaveAttestation(
        attestation,
        onChain,
        pins,
        lying((parsed) => ({ ...parsed, pcr0: new Uint8Array(48) })),
      ),
    );
  });

  it("refuses when the verifier throws", async () => {
    await refusal(
      verifyEnclaveAttestation(attestation, onChain, pins, {
        async verifyNitroAttestation() {
          throw new Error("TEST ONLY: bad signature");
        },
      }),
    );
  });
});
