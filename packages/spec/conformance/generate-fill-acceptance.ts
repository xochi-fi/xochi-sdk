#!/usr/bin/env node
// Generates `conformance/fill-acceptance.json`: vectors for SolverBond v2's EIP-712
// FillAcceptance (SOLVER-RFC §5.3, ESCROW-RFC §6.1), domain RiddlerSolverBond/2:
//
//   FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,
//                  uint256 deadline,bytes32 fillAuth)
//
// `fillAuth` is the RiddlerFiller EIP-712 digest of the issued FillAuth (domain
// RiddlerFiller/1 on the destination chain), so every vector carries BOTH steps: the
// FillAuth preimage with its domain and `expected_fill_auth_digest`, then the
// acceptance over it. A port that disagrees can tell which step is at fault.
// Signatures are 65-byte r||s||v, low-s. The solver (= FillAuth.filler) signs;
// SolverBond v2 ecrecovers it in `proposeSlash`, and the Riddler server verifies it
// at `POST /solver/awards/:auctionId/accept`.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as a solver.
//
// Run: npm run generate:fill-acceptance

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  FILL_ACCEPTANCE_DOMAIN_NAME,
  FILL_ACCEPTANCE_DOMAIN_VERSION,
  FILL_ACCEPTANCE_TYPE,
  FILL_ACCEPTANCE_TYPEHASH,
  FILL_AUTH_DOMAIN_NAME,
  FILL_AUTH_DOMAIN_VERSION,
  FILL_AUTH_TYPEHASH,
  fillAcceptanceDigest,
  fillAcceptanceDomainSeparator,
  fillAcceptanceOf,
  fillAcceptanceStructHash,
  fillAuthDigest,
  signFillAcceptance,
  type FillAuth,
} from "@xochi/signer";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #1 and #2). NOT SECRET. NEVER USE.
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const here = path.dirname(fileURLToPath(import.meta.url));
const orderIds = JSON.parse(fs.readFileSync(path.join(here, "order-id.json"), "utf8")).vectors;
const baselineOrderId: string = orderIds.find((v: { name: string }) => v.name === "baseline-evm-usdc").expected_order_id;

// The fixed bond deployment the baseline vectors are signed on.
const BOND_CHAIN_ID = "8453";
const BOND = "0x6666666666666666666666666666666666666666";
const ESCROW = "0x3333333333333333333333333333333333333333";
const FILLER_CONTRACT = "0x4444444444444444444444444444444444444444";
const TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const TOKEN = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const MAX = (2n ** 256n - 1n).toString();
const addr = (k: string) => new ethers.Wallet(k).address;

type Order = { orderId: string; originChainId: string; escrow: string };
type FillerDomain = { chainId: string; verifyingContract: string };
type Case = {
  name: string;
  chainId: string;
  verifyingContract: string;
  order: Order;
  fillerDomain: FillerDomain;
  fillAuth: FillAuth & { amount: string; deadline: string };
  key: string;
};

const order: Order = { orderId: baselineOrderId, originChainId: "8453", escrow: ESCROW };
const fillerDomain: FillerDomain = { chainId: "10", verifyingContract: FILLER_CONTRACT };
const fillAuth = {
  fillId: "0x" + "ab".repeat(32),
  filler: addr(TEST_KEY_1),
  to: TO,
  token: TOKEN,
  amount: "99700000",
  deadline: "1900000000",
};
const base = { chainId: BOND_CHAIN_ID, verifyingContract: BOND, order, fillerDomain, fillAuth, key: TEST_KEY_1 };

const CASES: Case[] = [
  { name: "baseline-base-to-optimism", ...base },
  { ...base, name: "second-solver", fillAuth: { ...fillAuth, filler: addr(TEST_KEY_2) }, key: TEST_KEY_2 },
  { ...base, name: "other-bond-domain", chainId: "1", verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508" },
  // Same FillAuth fields, another RiddlerFiller domain: only `fillAuth` moves.
  { ...base, name: "other-filler-domain", fillerDomain: { chainId: "42161", verifyingContract: "0x5555555555555555555555555555555555555555" } },
  { ...base, name: "same-chain-fill", fillerDomain: { ...fillerDomain, chainId: "8453" }, fillAuth: { ...fillAuth, deadline: "1" } },
  {
    ...base,
    name: "zero-amount-zero-ids",
    order: { ...order, orderId: "0x" + "00".repeat(32) },
    fillAuth: { ...fillAuth, fillId: "0x" + "00".repeat(32), amount: "0", deadline: "0" },
  },
  {
    ...base,
    name: "max-uint256-values",
    chainId: "42161",
    order: { orderId: "0x" + "ff".repeat(32), originChainId: MAX, escrow: ESCROW },
    fillerDomain: { chainId: MAX, verifyingContract: FILLER_CONTRACT },
    fillAuth: {
      fillId: "0x" + "ff".repeat(32),
      filler: addr(TEST_KEY_1),
      to: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
      token: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
      amount: MAX,
      deadline: MAX,
    },
  },
];

const vectors = [];
for (const c of CASES) {
  const domain = { chainId: c.chainId, verifyingContract: c.verifyingContract };
  const wallet = new ethers.Wallet(c.key);
  if (wallet.address !== c.fillAuth.filler) throw new Error(`${c.name}: signer must be the filler`);
  const acceptance = fillAcceptanceOf(c.order, c.fillerDomain, c.fillAuth);
  vectors.push({
    name: c.name,
    chainId: c.chainId,
    verifyingContract: c.verifyingContract,
    fill_auth_domain: c.fillerDomain,
    fill_auth: c.fillAuth,
    expected_fill_auth_digest: fillAuthDigest(c.fillerDomain, c.fillAuth),
    acceptance,
    expected_struct_hash: fillAcceptanceStructHash(acceptance),
    expected_domain_separator: fillAcceptanceDomainSeparator(domain),
    expected_digest: fillAcceptanceDigest(domain, acceptance),
    signer_private_key: c.key,
    signer_address: wallet.address,
    expected_signature: (await signFillAcceptance(wallet, domain, acceptance)).toLowerCase(),
  });
}

const out = {
  $schema: "./fill-acceptance.schema.json",
  description:
    `EIP-712 ${FILL_ACCEPTANCE_TYPE} vectors for SolverBond v2, where fillAuth is the RiddlerFiller ` +
    "EIP-712 digest of the issued FillAuth (fill_auth + fill_auth_domain -> expected_fill_auth_digest). " +
    "Signed by the filler (the solver's one key). signer_private_key values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: { name: FILL_ACCEPTANCE_DOMAIN_NAME, version: FILL_ACCEPTANCE_DOMAIN_VERSION },
  type: FILL_ACCEPTANCE_TYPE,
  typehash: FILL_ACCEPTANCE_TYPEHASH,
  fill_auth_domain: { name: FILL_AUTH_DOMAIN_NAME, version: FILL_AUTH_DOMAIN_VERSION },
  fill_auth_type: "FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)",
  fill_auth_typehash: FILL_AUTH_TYPEHASH,
  vectors,
};

const target = path.join(here, "fill-acceptance.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
