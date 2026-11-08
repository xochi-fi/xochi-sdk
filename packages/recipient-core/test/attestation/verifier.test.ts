/// <reference types="node" />
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { WebCryptoAttestationVerifier } from "../../src/attestation/index.js";
import {
  AWS_NITRO_ROOT_G1_PEM,
  ENCLAVE_TS_URL,
  der,
  syntheticChain,
  syntheticDocument,
} from "./support.js";

const fileSha256 = (url: URL): string => bytesToHex(sha256(readFileSync(url)));

describe("WebCryptoAttestationVerifier validation time without a document timestamp", () => {
  async function untimedDocument(): Promise<{ document: Uint8Array; root: Uint8Array }> {
    const chain = await syntheticChain();
    const document = await syntheticDocument(chain.leafKeys.privateKey, {
      certificate: der(chain.leaf),
      caBundle: [der(chain.root)],
    });
    return { document, root: der(chain.root) };
  }

  it("validates the chain at the injected clock's time", async () => {
    const { document, root } = await untimedDocument();
    const inside = new WebCryptoAttestationVerifier({
      nowMs: () => Date.parse("2030-01-01T12:00:00Z"),
    });
    const parsed = await inside.verifyNitroAttestation({
      attestationDocument: document,
      trustedRootCertificates: [root],
    });
    expect(parsed.timestamp).toBeUndefined();

    const after = new WebCryptoAttestationVerifier({
      nowMs: () => Date.parse("2031-01-01T00:00:00Z"),
    });
    await expect(
      after.verifyNitroAttestation({
        attestationDocument: document,
        trustedRootCertificates: [root],
      }),
    ).rejects.toThrow("Nitro leaf certificate is not valid at 2031-01-01T00:00:00.000Z");
  });

  it("prefers an explicit now over the clock", async () => {
    const { document, root } = await untimedDocument();
    const verifier = new WebCryptoAttestationVerifier({
      nowMs: () => {
        throw new Error("clock read");
      },
    });
    await expect(
      verifier.verifyNitroAttestation({
        attestationDocument: document,
        trustedRootCertificates: [root],
        now: new Date("2030-01-01T12:00:00Z"),
      }),
    ).resolves.toMatchObject({ moduleId: "i-synthetic-enc0" });
  });
});

describe("WebCryptoAttestationVerifier construction", () => {
  it("refuses a crypto without SubtleCrypto (a browser page that is not a secure context)", () => {
    const insecureContextCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    expect(
      () => new WebCryptoAttestationVerifier({ nowMs: Date.now }, insecureContextCrypto as Crypto),
    ).toThrow("WebCrypto SubtleCrypto is unavailable; a secure context (https) is required");
  });
});

describe("provenance pins", () => {
  const vendoredDir = new URL(
    "../../src/oxide/vendor/oxide-lib/attestation/nitro_attestation/",
    import.meta.url,
  );

  it("the test copy of the AWS Nitro root is the one src/oxide/enclave.ts pins", () => {
    expect(readFileSync(ENCLAVE_TS_URL, "utf8")).toContain(AWS_NITRO_ROOT_G1_PEM);
  });

  it("the fleet fixture is pxe-bridge's, byte for byte", () => {
    expect(fileSha256(new URL("./fixtures/attestation-0xcb88.json", import.meta.url))).toBe(
      "1247db728ce7313926870ae5557583ed0e5ddae4def1f3e27b202f5f7c037f59",
    );
  });

  // src/attestation ports these two files; a changed vendored file means re-porting, then re-pinning.
  it("the vendored files the port mirrors are unchanged", () => {
    expect(fileSha256(new URL("parsers.ts", vendoredDir))).toBe(
      "a4c3193a002654dbb53e33758bc48e6e99af93aafe71cfe30b47aee60f5b698f",
    );
    expect(fileSha256(new URL("verify_nitro_attestation.ts", vendoredDir))).toBe(
      "abda6b77e69a095593ca155c12bb9f191d8c0935e906d39afcb3bbe72fd868fe",
    );
  });
});
