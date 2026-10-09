#!/usr/bin/env node
// Generates `conformance/solver-bid-v2.json`: the cross-implementation vector set
// for SolverBid v2 sealing (SOLVER-RFC.md §5.1), EIP-712 domain RiddlerSolver/2:
//
//   SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,
//             uint64 validUntilMs,uint64 minExclusiveMs)
//
// `@xochi/solver-sdk`'s `bidTypedData` / `signBid` are the REFERENCE; the Riddler
// server (bid intake and the escrow node's FillAuthorizer) is held to this file.
// Each vector carries the domain separator, type hash, struct hash and digest so a
// port that disagrees can tell whether its type string, domain or data encoding is
// at fault. Signatures are 65-byte r||s||v, low-s, lowercase.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as a solver.
//
// Run: npm run generate:solver-bid-v2

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";
import {
  bidTypedData,
  signBid,
  MAX_BID_MS,
  SOLVER_BID_DOMAIN,
  SOLVER_BID_PRIMARY_TYPE,
  SOLVER_BID_TYPE,
  SOLVER_BID_TYPES,
  ZERO_ORDER_ID,
  type IntentAnnouncement,
} from "@xochi/solver-sdk";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #1 and #2). NOT SECRET. NEVER USE.
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const here = path.dirname(fileURLToPath(import.meta.url));
const orderIds = JSON.parse(fs.readFileSync(path.join(here, "order-id.json"), "utf8")).vectors;
const baselineOrderId: string = orderIds.find((v: { name: string }) => v.name === "baseline-evm-usdc").expected_order_id;
const MAX_UINT256 = (2n ** 256n - 1n).toString();

type Case = {
  name: string;
  why: string;
  key: string;
  orderId: string;
  auctionId: string;
  intentId: string;
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
};

const base = {
  key: TEST_KEY_1,
  orderId: baselineOrderId,
  auctionId: "auction-0001",
  intentId: "intent-0001",
  output: "99700000",
  validUntilMs: 1_900_000_000_000,
  minExclusiveMs: 30_000,
};

const CASES: Case[] = [
  { name: "baseline-escrow", why: "An escrow auction's bid: orderId is the order-id.json baseline.", ...base },
  { name: "second-solver", why: "Same bid, another key: the recovered signer is the solverId.", ...base, key: TEST_KEY_2 },
  {
    name: "non-escrow-zero-order-id",
    why: "A non-escrow auction announces orderId 0x00..00. Well-formed and signable, never awardable.",
    ...base,
    orderId: ZERO_ORDER_ID,
    auctionId: "auction-0002",
    intentId: "intent-0002",
  },
  {
    name: "distinct-order-id",
    why: "Only orderId differs from baseline-escrow: the digest MUST differ (the bid is bound to one order).",
    ...base,
    orderId: "0x" + "ff".repeat(32),
  },
  {
    name: "max-values",
    why: "output = uint256 max (stays a JSON string); validUntilMs/minExclusiveMs = 2^53-1, the widest a JSON number carries exactly (struct members are uint64; 2^53 is refused).",
    ...base,
    output: MAX_UINT256,
    validUntilMs: MAX_BID_MS,
    minExclusiveMs: MAX_BID_MS,
  },
  {
    name: "zero-values-utf8-ids",
    why: "Lower bounds (output 0, validUntilMs 0, minExclusiveMs 0) and multi-byte ids hashed as UTF-8 bytes.",
    ...base,
    output: "0",
    validUntilMs: 0,
    minExclusiveMs: 0,
    auctionId: "auction-ünïcode-\u{1F984}",
    intentId: "intent-\"q\"\\\n",
  },
  {
    name: "empty-ids",
    why: "keccak256(\"\") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 is a well-defined member, not an error: an encoder that drops empty members or substitutes a placeholder diverges here.",
    ...base,
    auctionId: "",
    intentId: "",
  },
  {
    name: "utf8-control-chars-and-slash",
    why: "Tab, CR and '/' must reach keccak as the raw bytes 0x09, 0x0D and 0x2F, never as the escapes a JSON writer emits (\\t, \\r, \\/).",
    ...base,
    auctionId: "auction/with/slashes",
    intentId: "intent-\t\r-0003",
  },
];

function announcementFor(c: Case): IntentAnnouncement {
  return {
    intentId: c.intentId,
    auctionId: c.auctionId,
    orderId: c.orderId,
    fromChainId: 8453,
    toChainId: 10,
    fromToken: "USDC",
    toToken: "USDC",
    swapKind: "exact_input",
    fromAmount: "100000000",
    settlementPreference: "public",
    minOutput: "0",
    opensAt: 0,
    closesAt: 0,
    exclusiveWindowMs: 0,
  };
}

const encoder = ethers.TypedDataEncoder.from(SOLVER_BID_TYPES);
const encodeType = encoder.encodeType(SOLVER_BID_PRIMARY_TYPE);
if (encodeType !== SOLVER_BID_TYPE) throw new Error(`type string drift: ${encodeType}`);

const vectors = [];
for (const c of CASES) {
  const wallet = new ethers.Wallet(c.key);
  const { signature, ...bid } = await signBid(wallet, announcementFor(c), {
    output: c.output,
    validUntilMs: c.validUntilMs,
    minExclusiveMs: c.minExclusiveMs,
  });
  const { domain, types, message } = bidTypedData(bid);
  vectors.push({
    name: c.name,
    why: c.why,
    bid,
    message,
    expected_struct_hash: ethers.TypedDataEncoder.hashStruct(SOLVER_BID_PRIMARY_TYPE, types, message),
    expected_digest: ethers.TypedDataEncoder.hash(domain, types, message),
    signer_private_key: c.key,
    signer_address: wallet.address,
    expected_signature: signature,
  });
}

const out = {
  $schema: "./solver-bid-v2.schema.json",
  description:
    `EIP-712 ${SOLVER_BID_TYPE} vectors (SOLVER-RFC §5.1). Reference: @xochi/solver-sdk bidTypedData/signBid. ` +
    "signer_private_key values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: SOLVER_BID_DOMAIN,
  primary_type: SOLVER_BID_PRIMARY_TYPE,
  types: SOLVER_BID_TYPES,
  encode_type: encodeType,
  typehash: ethers.keccak256(ethers.toUtf8Bytes(encodeType)),
  domain_separator: ethers.TypedDataEncoder.hashDomain(SOLVER_BID_DOMAIN),
  vectors,
};

const target = path.join(here, "solver-bid-v2.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
