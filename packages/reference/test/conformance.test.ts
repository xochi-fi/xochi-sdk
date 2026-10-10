// Byte-equality contract with raxol_payments: re-signs every vector in the
// FROZEN @xochi/spec conformance fixture via the ported TS signers and
// asserts digest/signature/signed_object equality, plus signer recovery.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import { ethers } from "ethers";
import { CONFIG } from "../src/config";
import { signOnly } from "../src/sign-only";
import { signXochiIntent, XOCHI_TYPES, type Quote, type Eip712Signable } from "@xochi/signer";
import type { SignerConfig } from "@xochi/signer";

const require = createRequire(import.meta.url);

interface FixtureVector {
  name: string;
  protocol: "erc3009" | "permit2" | "xochi";
  chain: string | null;
  token: string;
  private_key: string;
  expected_signer: string;
  quote?: Quote;
  eip712?: Eip712Signable;
  expected_digest: string;
  expected_signature: string;
  expected_signed_object: string | null;
}

function loadFixture(): FixtureVector[] {
  const p = require.resolve("@xochi/spec/conformance/conformance.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const FIXTURE_CONFIG: SignerConfig = {
  ...CONFIG,
  PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

async function verifyErc3009(vec: FixtureVector) {
  const result = await signOnly("erc3009", vec.quote as Quote, vec.chain as string, FIXTURE_CONFIG);
  return compare(vec, result.digest, result.signature, result.signed_object);
}

async function verifyPermit2(vec: FixtureVector) {
  const result = await signOnly("permit2", vec.quote as Quote, vec.chain as string, FIXTURE_CONFIG);
  return compare(vec, result.digest, result.signature, result.signed_object);
}

async function verifyXochi(vec: FixtureVector) {
  const signature = await signXochiIntent(vec.eip712 as Eip712Signable, FIXTURE_CONFIG.PRIVATE_KEY);
  const digest = ethers.TypedDataEncoder.hash(
    (vec.eip712 as Eip712Signable).domain,
    XOCHI_TYPES,
    (vec.eip712 as Eip712Signable).message,
  );
  return compare(vec, digest, signature, null);
}

function compare(
  vec: FixtureVector,
  digest: string,
  signature: string,
  signedObject: string | null,
): string[] {
  const failures: string[] = [];

  if (digest !== vec.expected_digest) {
    failures.push(`digest mismatch: got ${digest}, expected ${vec.expected_digest}`);
  }

  if (signature !== vec.expected_signature) {
    failures.push(`signature mismatch: got ${signature}, expected ${vec.expected_signature}`);
  }

  if (vec.expected_signed_object !== null && signedObject !== vec.expected_signed_object) {
    failures.push(
      `signed_object mismatch: got ${signedObject}, expected ${vec.expected_signed_object}`,
    );
  }

  // Sanity: recover the signer from the digest+signature and assert it
  // matches expected_signer. Catches any future signer drift.
  try {
    const recovered = ethers.recoverAddress(digest, signature);
    if (recovered !== vec.expected_signer) {
      failures.push(`recovered signer mismatch: got ${recovered}, expected ${vec.expected_signer}`);
    }
  } catch (e) {
    failures.push(`signer recovery failed: ${(e as Error).message}`);
  }

  return failures;
}

async function runVector(vec: FixtureVector): Promise<string[]> {
  switch (vec.protocol) {
    case "erc3009":
      return verifyErc3009(vec);
    case "permit2":
      return verifyPermit2(vec);
    case "xochi":
      return verifyXochi(vec);
    default:
      return [`unknown protocol: ${vec.protocol}`];
  }
}

describe("conformance", () => {
  const fixture = loadFixture();

  it("loads 45 vectors from the frozen fixture", () => {
    expect(fixture.length).toBe(45);
  });

  for (const vec of fixture) {
    it(`${vec.name} re-signs byte-identically`, async () => {
      const failures = await runVector(vec);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
