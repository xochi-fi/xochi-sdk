// Cross-implementation vector check for solver registration (SOLVER-RFC.md §3.1).
//
// `registration.test.ts` proves a registration this SDK signs is one its stub venue
// verifies -- self-consistent, and green under any encoding. This file asserts the
// SHARED values in `@xochi/spec`'s `conformance/solver-registration.json`, the file
// the Riddler server's `POST /solver/register` verifier is held to (vendored there
// as `test/support/vectors/escrow_solver_registration.json`).
//
// Drift does not fail loudly: every honest registration is refused 403, and no
// solver can reach the surface at all.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  registrationDigest,
  registrationTypedData,
  signRegistration,
  SOLVER_REGISTRATION_DOMAIN,
  SOLVER_REGISTRATION_PRIMARY_TYPE,
  SOLVER_REGISTRATION_TYPES,
  type SolverRegistration,
  type SolverRegistrationMessage,
} from "../src/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(here, "../../spec/conformance/solver-registration.json");

// Literals computed with Foundry `cast` 1.5.1, not ethers, from the type string
// and the baseline message:
//
//   cast keccak "SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)"
//   cast keccak $(cast abi-encode "f(bytes32,address,uint256,address,uint64)" <typehash> \
//     0x70997970C51812dc3A010C7d01b50e0d17dc79C8 8453 0x4444444444444444444444444444444444444444 1900000000000)
//   cast keccak 0x1901<domain separator><struct hash>
//
// The domain separator is the bid's (`bid-vectors.test.ts`): one domain, two types.
// A vector regenerated from a wrong encoding moves with the code; these do not.
const ENCODE_TYPE =
  "SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)";
const TYPE_HASH = "0x58ca0802ee89a606fbacd85e86f9621ab5d3c71bdbcbb7715fe0ee93e72fd497";
const DOMAIN_SEPARATOR = "0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b";
const BASELINE_STRUCT_HASH = "0xa0056d5b651b30c723c309669e53ccbbc23910d067216cfe4b67188db56a0628";
const BASELINE_DIGEST = "0x09f9f814171ae0c4d0e3ee92a7118f53ce907433162ded5927457f18c09ca84e";

interface Vector {
  name: string;
  why: string;
  registration: SolverRegistration;
  message: SolverRegistrationMessage;
  signing_domain: ethers.TypedDataDomain;
  expected_struct_hash: string;
  expected_digest: string;
  signed_digest: string;
  signer_private_key: string;
  signer_address: string;
  expected_signature: string;
  verify_at_ms: number;
  expected_verify: "ok" | "signature_mismatch";
  expected_outcome: "admitted" | "registration_stale" | "signature_mismatch";
}

interface VectorFile {
  domain: { name: string; version: string };
  primary_type: string;
  types: unknown;
  encode_type: string;
  typehash: string;
  domain_separator: string;
  max_age_ms: number;
  vectors: Vector[];
}

const fixture: VectorFile = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
const byName = (name: string) => fixture.vectors.find((v) => v.name === name)!;

describe("SolverRegistration conformance vectors", () => {
  it("pins the domain, type string, type hash and domain separator by value", () => {
    expect(fixture.domain).toEqual({ name: "RiddlerSolver", version: "2" });
    expect(SOLVER_REGISTRATION_DOMAIN).toEqual({ name: "RiddlerSolver", version: "2" });
    expect(fixture.primary_type).toBe(SOLVER_REGISTRATION_PRIMARY_TYPE);
    expect(fixture.types).toEqual(SOLVER_REGISTRATION_TYPES);
    expect(fixture.encode_type).toBe(ENCODE_TYPE);
    expect(fixture.typehash).toBe(TYPE_HASH);
    expect(fixture.domain_separator).toBe(DOMAIN_SEPARATOR);
    expect(
      ethers.TypedDataEncoder.from(SOLVER_REGISTRATION_TYPES).encodeType(
        SOLVER_REGISTRATION_PRIMARY_TYPE,
      ),
    ).toBe(ENCODE_TYPE);
    expect(ethers.TypedDataEncoder.hashDomain(SOLVER_REGISTRATION_DOMAIN)).toBe(DOMAIN_SEPARATOR);
  });

  it("anchors the baseline to values computed outside ethers", () => {
    const baseline = byName("baseline");
    expect(baseline.expected_struct_hash).toBe(BASELINE_STRUCT_HASH);
    expect(baseline.expected_digest).toBe(BASELINE_DIGEST);
    expect(registrationDigest(baseline.message)).toBe(BASELINE_DIGEST);
  });

  it("covers a valid, a stale and a wrong-domain registration", () => {
    const outcomes = new Set(fixture.vectors.map((v) => v.expected_outcome));
    expect(outcomes).toEqual(new Set(["admitted", "registration_stale", "signature_mismatch"]));
    const names = fixture.vectors.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(fixture.vectors.map((v) => [v.name, v] as const))(
    "%s: digest, signature and outcome",
    async (_name, v) => {
      expect(v.registration).toEqual({ ...v.message, signature: v.expected_signature });
      expect(registrationDigest(v.message)).toBe(v.expected_digest);
      const { types } = registrationTypedData(v.message);
      expect(
        ethers.TypedDataEncoder.hashStruct(SOLVER_REGISTRATION_PRIMARY_TYPE, types, v.message),
      ).toBe(v.expected_struct_hash);
      expect(ethers.TypedDataEncoder.hash(v.signing_domain, types, v.message)).toBe(
        v.signed_digest,
      );

      const wallet = new ethers.Wallet(v.signer_private_key);
      expect(wallet.address).toBe(v.signer_address);
      expect(ethers.recoverAddress(v.signed_digest, v.expected_signature)).toBe(wallet.address);

      const recovered = ethers.recoverAddress(v.expected_digest, v.expected_signature);
      expect(recovered === wallet.address ? "ok" : "signature_mismatch").toBe(v.expected_verify);

      if (v.expected_verify === "ok") {
        // signRegistration is deterministic (RFC 6979): it reproduces the bytes.
        const signed = await signRegistration(wallet, {
          bondChainId: v.message.bondChainId,
          bond: v.message.bond,
          issuedAtMs: v.message.issuedAtMs,
        });
        expect(signed).toEqual(v.registration);
      } else {
        expect(v.signed_digest).not.toBe(v.expected_digest);
      }

      // The venue's order: freshness first, then the signature.
      const fresh = Math.abs(v.verify_at_ms - v.message.issuedAtMs) <= fixture.max_age_ms;
      const outcome = !fresh
        ? "registration_stale"
        : v.expected_verify === "ok"
          ? "admitted"
          : "signature_mismatch";
      expect(outcome).toBe(v.expected_outcome);
    },
  );
});
