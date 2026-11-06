#!/usr/bin/env node
// Generates `conformance/slash-attestation.json`: vectors for SolverBond's EIP-712
// SlashAttestation (ESCROW-RFC.md §6), domain RiddlerSolverBond/2, over the fields of
// `SolverBond.SlashClaim` in declaration order. Signatures are 65-byte r||s||v, low-s.
//
// Run: npm run generate:slash-attestation -w @xochi/spec

import { ethers } from "ethers";

import {
  signSlashAttestation,
  SOLVER_BOND_DOMAIN_NAME,
  SOLVER_BOND_DOMAIN_VERSION,
  SLASH_ATTESTATION_TYPEHASH,
  slashAttestationDigest,
  slashAttestationDomainSeparator,
  slashAttestationStructHash,
} from "@xochi/signer";

import { baselineOrderId, HARDHAT_TEST_KEYS, writeVectors } from "./_lib.js";

const [TEST_KEY_0, TEST_KEY_1] = HARDHAT_TEST_KEYS;

const BOND = "0x6666666666666666666666666666666666666666";
const SOLVER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BENEFICIARY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ESCROW = "0x3333333333333333333333333333333333333333";
const MAX = (2n ** 256n - 1n).toString();

const base = {
  orderId: baselineOrderId(),
  solver: SOLVER,
  beneficiary: BENEFICIARY,
  notional: "1000000",
  originChainId: "8453",
  escrow: ESCROW,
  deadline: "1900000000",
};

const CASES = [
  { name: "baseline-base", chainId: "8453", verifyingContract: BOND, claim: base, key: TEST_KEY_0 },
  { name: "second-signer", chainId: "8453", verifyingContract: BOND, claim: base, key: TEST_KEY_1 },
  {
    name: "other-chain-and-bond",
    chainId: "1",
    verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508",
    claim: { ...base, originChainId: "1", escrow: "0x9A676e781A523b5d0C0e43731313A708CB607508" },
    key: TEST_KEY_0,
  },
  {
    name: "zero-notional-zero-deadline",
    chainId: "8453",
    verifyingContract: BOND,
    claim: { ...base, orderId: "0x" + "00".repeat(31) + "01", notional: "0", deadline: "0" },
    key: TEST_KEY_0,
  },
  {
    name: "max-uint256-values",
    chainId: "42161",
    verifyingContract: BOND,
    claim: {
      orderId: "0x" + "ff".repeat(32),
      solver: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
      beneficiary: BENEFICIARY,
      notional: MAX,
      originChainId: MAX,
      escrow: ESCROW,
      deadline: MAX,
    },
    key: TEST_KEY_1,
  },
];

const vectors = [];
for (const c of CASES) {
  const domain = { chainId: c.chainId, verifyingContract: c.verifyingContract };
  vectors.push({
    name: c.name,
    chainId: c.chainId,
    verifyingContract: c.verifyingContract,
    claim: c.claim,
    expected_struct_hash: slashAttestationStructHash(c.claim),
    expected_domain_separator: slashAttestationDomainSeparator(domain),
    expected_digest: slashAttestationDigest(domain, c.claim),
    signer_private_key: c.key,
    signer_address: new ethers.Wallet(c.key).address,
    expected_signature: (
      await signSlashAttestation(new ethers.Wallet(c.key), domain, c.claim)
    ).toLowerCase(),
  });
}

const out = {
  $schema: "./slash-attestation.schema.json",
  description:
    "EIP-712 SlashAttestation(bytes32 orderId,address solver,address beneficiary,uint256 notional," +
    "uint256 originChainId,address escrow,uint256 deadline) vectors for SolverBond. signer_private_key " +
    "values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: { name: SOLVER_BOND_DOMAIN_NAME, version: SOLVER_BOND_DOMAIN_VERSION },
  typehash: SLASH_ATTESTATION_TYPEHASH,
  vectors,
};

writeVectors("slash-attestation.json", out);
