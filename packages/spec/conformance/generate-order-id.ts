#!/usr/bin/env node
// Generates `conformance/order-id.json`: the cross-implementation vector set for
// the v2 order encoding (ESCROW-RFC §2): canonical keys, the blinded
// `destCommitment`, and `orderId = keccak256(abi.encode(ORDER_TYPEHASH, OrderTerms))`.
//
// `@xochi/signer` is the REFERENCE. TypeScript, Elixir (the Riddler server) and
// Solidity (`RiddlerEscrow`) must all reproduce these bytes. Drift here does not
// fail loudly -- it computes a lock key nobody else can open, which strands
// principal (ESCROW-RFC §11.1 M6.1).
//
// Run: npm run generate:order-id

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  canonicalKey,
  computeDestCommitment,
  computeIntentIdHash,
  computeOrderId,
  DEST_TYPEHASH,
  ORDER_TYPEHASH,
  type DestOpening,
  type OrderTerms,
} from "@xochi/signer";

const MAX_UINT256 = (2n ** 256n - 1n).toString();

type Terms = Omit<OrderTerms, "destCommitment">;

const OPENING: DestOpening = {
  recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  toToken: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  toAmount: "99700000",
  blinding: "0x" + "5a".repeat(32),
  intentId: "intent-0001",
};

const TERMS: Terms = {
  depositor: "0x1111111111111111111111111111111111111111",
  fromChainId: 8453,
  fromToken: "0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5",
  fromAmount: "100000000",
  toChainId: 10,
  fillDeadline: 1900000000,
  escrow: "0x3333333333333333333333333333333333333333",
};

// Canton destinations (ADR-0014): synthetic chain ids cut from each global
// synchronizer's namespace fingerprint, and Canton Coin named by its CIP-56
// instrument admin, the DSO party. TestNet's id is above 2^31.
const CANTON_MAINNET_CHAIN_ID = 253340876;
const CANTON_TESTNET_CHAIN_ID = 4149314359;
const CANTON_MAINNET_CC =
  "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const CANTON_TESTNET_CC =
  "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337";
const CANTON_PARTY = "alice::1220f2fe29866fd6a0009ecc8a64ccdc09f1958bd0f801166baaee469d1251b2eb72";

type Case = { name: string; why: string; opening: DestOpening; terms: Terms };

const CASES: Case[] = [
  {
    name: "baseline-evm-usdc",
    why: "The pinned ESCROW-RFC §2.4 reference vector.",
    opening: OPENING,
    terms: TERMS,
  },
  {
    name: "evm-recipient-checksummed",
    why:
      "A checksummed EVM recipient/toToken/depositor MUST give the same keys and orderId as " +
      "baseline's lowercase forms: an EVM address is keyed by its 20 bytes, never its string.",
    opening: {
      ...OPENING,
      recipient: ethers.getAddress(OPENING.recipient),
      toToken: ethers.getAddress(OPENING.toToken),
    },
    terms: {
      ...TERMS,
      fromToken: ethers.getAddress(TERMS.fromToken),
      escrow: ethers.getAddress(TERMS.escrow),
    },
  },
  {
    name: "tron-base58-recipient",
    why: "A base58 Tron recipient and token are not EVM addresses: keccak of their UTF-8, case-sensitive.",
    opening: {
      ...OPENING,
      recipient: "TXYZopqrstuvwxABCDEFGHijklmnopqrst",
      toToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    },
    terms: { ...TERMS, toChainId: 728126428 },
  },
  {
    name: "canton-party-recipient",
    why: "A Canton party id (hint::fingerprint) is hashed verbatim, colons included.",
    opening: {
      ...OPENING,
      recipient: "alice::1220f2fe29866fd6a0009ecc8a64ccdc09f1958bd0f801166baaee469d1251b2eb72",
      toToken: "Amulet",
    },
    terms: TERMS,
  },
  {
    name: "canton-mainnet-destination",
    why:
      "A Canton MainNet order: a party recipient and the Canton Coin instrument admin (DSO party) " +
      "as toToken, both keccak of their verbatim UTF-8; toChainId is the synthetic id 253340876.",
    opening: { ...OPENING, recipient: CANTON_PARTY, toToken: CANTON_MAINNET_CC },
    terms: { ...TERMS, toChainId: CANTON_MAINNET_CHAIN_ID },
  },
  {
    name: "canton-party-recipient-case",
    why:
      "canton-mainnet-destination with only the party hint's case changed (Alice, not alice). " +
      "Canton party ids are case-sensitive, so recipientKey, destCommitment and orderId MUST all " +
      "differ from it: an implementation that folds case pays a different party.",
    opening: { ...OPENING, recipient: "A" + CANTON_PARTY.slice(1), toToken: CANTON_MAINNET_CC },
    terms: { ...TERMS, toChainId: CANTON_MAINNET_CHAIN_ID },
  },
  {
    name: "canton-testnet-destination",
    why:
      "A Canton TestNet order (Base Sepolia origin): toChainId 4149314359 is above 2^31, so it " +
      "catches an int32 chain id; toToken is TestNet's own DSO party.",
    opening: { ...OPENING, recipient: CANTON_PARTY, toToken: CANTON_TESTNET_CC },
    terms: { ...TERMS, fromChainId: 84532, toChainId: CANTON_TESTNET_CHAIN_ID },
  },
  {
    name: "bytes32-hex-recipient",
    why:
      "A 0x-prefixed 32-byte string (Solana/Sui style) is NOT an EVM address: it is hashed as " +
      "a string, never decoded as bytes32 or truncated to 20 bytes.",
    opening: { ...OPENING, recipient: "0x" + "ab".repeat(32) },
    terms: TERMS,
  },
  {
    name: "symbol-to-token",
    why: 'A symbol toToken ("Amulet") takes the hashed path, case-sensitive.',
    opening: { ...OPENING, toToken: "Amulet" },
    terms: TERMS,
  },
  {
    name: "zero-amounts",
    why: "Zero toAmount and fromAmount encode as distinct values, never elided.",
    opening: { ...OPENING, toAmount: "0" },
    terms: { ...TERMS, fromAmount: "0" },
  },
  {
    name: "max-uint256-amounts-and-deadline",
    why: "toAmount, fromAmount and fillDeadline at 2^256-1: catches 64-bit truncation.",
    opening: { ...OPENING, toAmount: MAX_UINT256 },
    terms: { ...TERMS, fromAmount: MAX_UINT256, fillDeadline: MAX_UINT256 },
  },
  {
    name: "unicode-intent-id",
    why: "intentIdHash is keccak of UTF-8 BYTES; multibyte chars catch codepoint-based encoders.",
    opening: { ...OPENING, intentId: "intent-é中文-🔐" },
    terms: TERMS,
  },
  {
    name: "long-multiword-strings",
    why: "Strings longer than 32 bytes, with spaces: hashing is over the whole verbatim UTF-8.",
    opening: {
      ...OPENING,
      recipient: "a long recipient string that spans " + "0123456789abcdef".repeat(4),
      intentId: "intent " + "0123456789abcdef ".repeat(5),
    },
    terms: TERMS,
  },
  {
    name: "high-bit-blinding",
    why: "A blinding with the top bit set: catches signed-integer or truncating bytes32 handling.",
    opening: { ...OPENING, blinding: "0x" + "ff" + "00".repeat(30) + "01" },
    terms: TERMS,
  },
];

const vectors = CASES.map(({ name, why, opening, terms }) => {
  const destCommitment = computeDestCommitment(opening);
  return {
    name,
    why,
    opening: {
      recipient: opening.recipient,
      toToken: opening.toToken,
      toAmount: String(opening.toAmount),
      blinding: opening.blinding.toLowerCase(),
      intentId: opening.intentId,
    },
    expected_recipient_key: canonicalKey(opening.recipient),
    expected_to_token_key: canonicalKey(opening.toToken),
    expected_intent_id_hash: computeIntentIdHash(opening.intentId),
    expected_dest_commitment: destCommitment,
    terms: {
      depositor: terms.depositor,
      fromChainId: String(terms.fromChainId),
      fromToken: terms.fromToken,
      fromAmount: String(terms.fromAmount),
      toChainId: String(terms.toChainId),
      fillDeadline: String(terms.fillDeadline),
      escrow: terms.escrow,
    },
    expected_order_id: computeOrderId({ ...terms, destCommitment }),
  };
});

const out = {
  $schema: "./order-id.schema.json",
  description:
    "Cross-implementation vectors for the v2 order encoding (ESCROW-RFC §2): canonicalKey, " +
    "destCommitment = keccak256(abi.encode(DEST_TYPEHASH, recipientKey, toTokenKey, toAmount, " +
    "blinding, intentIdHash)) and orderId = keccak256(abi.encode(ORDER_TYPEHASH, depositor, " +
    "fromChainId, fromToken, fromAmount, toChainId, fillDeadline, escrow, destCommitment)). " +
    "Each vector's orderId uses its own expected_dest_commitment. Reference: @xochi/signer.",
  typehashes: { DEST_TYPEHASH, ORDER_TYPEHASH },
  vectors,
};

const dir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(dir, "order-id.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
for (const v of vectors) console.log(`  ${v.name.padEnd(34)} ${v.expected_order_id}`);
