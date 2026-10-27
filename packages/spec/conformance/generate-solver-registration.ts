#!/usr/bin/env node
// Generates `conformance/solver-registration.json`: the cross-implementation
// vector set for solver registration (SOLVER-RFC.md §3.1), EIP-712 domain
// RiddlerSolver/2 (the bid's domain):
//
//   SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)
//
// `@xochi/solver-sdk`'s `registrationTypedData` / `signRegistration` are the
// REFERENCE; the Riddler server's `POST /solver/register` verifier is held to this
// file. Each vector carries the domain separator, type hash, struct hash and digest
// so a port that disagrees can tell whether its type string, domain or data
// encoding is at fault. Signatures are 65-byte r||s||v, low-s, lowercase.
//
// Two kinds of negative vector, both with a GENUINE signature by the named key:
//   - wrong domain: signed over the same message under another domain, so it
//     recovers to some other address under RiddlerSolver/2 (`signature_mismatch`);
//   - stale: signed correctly, presented at `verify_at_ms` past the venue's
//     freshness window (`registration_stale`), which is checked BEFORE the
//     signature. `max_age_ms` is that window: the venue's default
//     (`SOLVER_REGISTRATION_MAX_AGE_MS`, 120 s), inclusive, either side of its
//     clock.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as a solver.
//
// Run: npm run generate:solver-registration

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";
import {
  registrationTypedData,
  signRegistration,
  SOLVER_REGISTRATION_DOMAIN,
  SOLVER_REGISTRATION_PRIMARY_TYPE,
  SOLVER_REGISTRATION_TYPE,
  SOLVER_REGISTRATION_TYPES,
} from "@xochi/solver-sdk";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #1 and #2). NOT SECRET. NEVER USE.
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const MAX_AGE_MS = 120_000;
const BOND_CHAIN_ID = 8453;
const BOND = ethers.getAddress("0x4444444444444444444444444444444444444444");
const ISSUED_AT_MS = 1_900_000_000_000;

type Outcome = "admitted" | "registration_stale" | "signature_mismatch";

type Case = {
  name: string;
  why: string;
  key: string;
  issuedAtMs: number;
  verifyAtMs: number;
  // Omitted: the venue's domain, through `signRegistration`.
  signingDomain?: ethers.TypedDataDomain;
  outcome: Outcome;
};

const base = { key: TEST_KEY_1, issuedAtMs: ISSUED_AT_MS, verifyAtMs: ISSUED_AT_MS };

const CASES: Case[] = [
  {
    name: "baseline",
    why: "A fresh registration for the venue's bond, presented at the instant it was issued.",
    ...base,
    outcome: "admitted",
  },
  {
    name: "second-solver",
    why: "Same fields, another key: the recovered signer is the solverId.",
    ...base,
    key: TEST_KEY_2,
    outcome: "admitted",
  },
  {
    name: "window-edge-past",
    why: "Presented exactly max_age_ms after issuedAtMs: the bound is inclusive.",
    ...base,
    verifyAtMs: ISSUED_AT_MS + MAX_AGE_MS,
    outcome: "admitted",
  },
  {
    name: "window-edge-future",
    why: "issuedAtMs exactly max_age_ms ahead of the venue's clock: the window is two-sided, so a signer clock running fast is admitted up to the same bound.",
    ...base,
    verifyAtMs: ISSUED_AT_MS - MAX_AGE_MS,
    outcome: "admitted",
  },
  {
    name: "stale",
    why: "Presented 1 ms past the window. The signature is genuine; freshness is checked before it, and the refusal is permanent for this signature (sign a fresh one).",
    ...base,
    verifyAtMs: ISSUED_AT_MS + MAX_AGE_MS + 1,
    outcome: "registration_stale",
  },
  {
    name: "wrong-domain-version",
    why: 'Signed under RiddlerSolver/"1" (the retired bid domain): a genuine signature that recovers to another address under RiddlerSolver/"2".',
    ...base,
    signingDomain: { name: "RiddlerSolver", version: "1" },
    outcome: "signature_mismatch",
  },
  {
    name: "wrong-domain-chain-id",
    why: "Signed under a domain that adds chainId (the bond's). The domain has no chainId: a port that adds one recovers to another address.",
    ...base,
    signingDomain: { name: "RiddlerSolver", version: "2", chainId: BOND_CHAIN_ID },
    outcome: "signature_mismatch",
  },
  {
    name: "max-issued-at",
    why: "issuedAtMs = 2^53-1, the widest a JSON number carries exactly (the member is uint64; 2^53 is refused as malformed).",
    ...base,
    issuedAtMs: Number.MAX_SAFE_INTEGER,
    verifyAtMs: Number.MAX_SAFE_INTEGER,
    outcome: "admitted",
  },
  {
    name: "zero-issued-at",
    why: "issuedAtMs = 0 is well-formed; only freshness decides it.",
    ...base,
    issuedAtMs: 0,
    verifyAtMs: 0,
    outcome: "admitted",
  },
];

const encoder = ethers.TypedDataEncoder.from(SOLVER_REGISTRATION_TYPES);
const encodeType = encoder.encodeType(SOLVER_REGISTRATION_PRIMARY_TYPE);
if (encodeType !== SOLVER_REGISTRATION_TYPE) throw new Error(`type string drift: ${encodeType}`);

const vectors = [];
for (const c of CASES) {
  const wallet = new ethers.Wallet(c.key);
  const fields = { bondChainId: BOND_CHAIN_ID, bond: BOND, issuedAtMs: c.issuedAtMs };
  const reference = await signRegistration(wallet, fields);
  const { domain, types, message } = registrationTypedData(reference);
  const signingDomain = c.signingDomain ?? domain;
  const signature = c.signingDomain
    ? ethers.Signature.from(
        await wallet.signTypedData(signingDomain, types, message),
      ).serialized.toLowerCase()
    : reference.signature;
  const recovered = ethers.verifyTypedData(domain, types, message, signature);
  const verifies = recovered === wallet.address;
  if (verifies !== (c.outcome !== "signature_mismatch")) {
    throw new Error(`${c.name}: recovery ${recovered} disagrees with outcome ${c.outcome}`);
  }
  vectors.push({
    name: c.name,
    why: c.why,
    registration: { ...message, signature },
    message,
    signing_domain: signingDomain,
    expected_struct_hash: ethers.TypedDataEncoder.hashStruct(
      SOLVER_REGISTRATION_PRIMARY_TYPE,
      types,
      message,
    ),
    expected_digest: ethers.TypedDataEncoder.hash(domain, types, message),
    signed_digest: ethers.TypedDataEncoder.hash(signingDomain, types, message),
    signer_private_key: c.key,
    signer_address: wallet.address,
    expected_signature: signature,
    verify_at_ms: c.verifyAtMs,
    expected_verify: verifies ? "ok" : "signature_mismatch",
    expected_outcome: c.outcome,
  });
}

const out = {
  $schema: "./solver-registration.schema.json",
  description:
    `EIP-712 ${SOLVER_REGISTRATION_TYPE} vectors (SOLVER-RFC §3.1). Reference: @xochi/solver-sdk ` +
    "registrationTypedData/signRegistration. expected_digest is under the venue's domain; " +
    "signed_digest under signing_domain (they differ only in the wrong-domain vectors). " +
    "expected_outcome is what a venue whose SolverBond is (bondChainId, bond), whose clock reads " +
    "verify_at_ms and whose window is max_age_ms answers, the key's stake being sufficient. " +
    "signer_private_key values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: SOLVER_REGISTRATION_DOMAIN,
  primary_type: SOLVER_REGISTRATION_PRIMARY_TYPE,
  types: SOLVER_REGISTRATION_TYPES,
  encode_type: encodeType,
  typehash: ethers.keccak256(ethers.toUtf8Bytes(encodeType)),
  domain_separator: ethers.TypedDataEncoder.hashDomain(SOLVER_REGISTRATION_DOMAIN),
  max_age_ms: MAX_AGE_MS,
  vectors,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "solver-registration.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
