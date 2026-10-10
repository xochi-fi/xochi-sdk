#!/usr/bin/env node
// Generates `conformance/dest-blinding.json`: vectors for the venue-side blinding
// derivation (ESCROW-RFC §2.2):
//   HMAC-SHA256(key, "riddler/dest-blinding/v1" || uint256_be32(fromChainId)
//                    || address_bytes20(escrow) || utf8(intentId))
//
// The key below is a fixed, PUBLIC TEST key. Production derives with a KMS key
// that never leaves the venue; this one MUST NEVER be used outside tests.
//
// Run: npm run generate:dest-blinding

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { DEST_BLINDING_TAG, deriveDestBlinding } from "@xochi/signer";

// PUBLIC TEST KEY. NOT SECRET. NEVER USE IN PRODUCTION.
const TEST_KEY = "0x" + "0b".repeat(32);

const CASES = [
  {
    name: "baseline-base",
    fromChainId: "8453",
    escrow: "0x3333333333333333333333333333333333333333",
    intentId: "intent-0001",
  },
  {
    name: "checksummed-escrow",
    fromChainId: "8453",
    escrow: "0x9A676e781A523b5d0C0e43731313A708CB607508",
    intentId: "intent-0001",
  },
  {
    name: "other-chain",
    fromChainId: "1",
    escrow: "0x3333333333333333333333333333333333333333",
    intentId: "intent-0001",
  },
  {
    name: "unicode-intent-id",
    fromChainId: "8453",
    escrow: "0x3333333333333333333333333333333333333333",
    intentId: "intent-é中文-🔐",
  },
  {
    name: "max-uint256-chain",
    fromChainId: (2n ** 256n - 1n).toString(),
    escrow: "0x3333333333333333333333333333333333333333",
    intentId: "intent " + "0123456789abcdef ".repeat(5),
  },
];

const vectors = CASES.map((c) => ({
  ...c,
  expected_blinding: deriveDestBlinding(TEST_KEY, c.fromChainId, c.escrow, c.intentId),
}));

const out = {
  $schema: "./dest-blinding.schema.json",
  description:
    "Venue-side destination blinding vectors (ESCROW-RFC §2.2). `key` is a PUBLIC TEST key; " +
    "production uses a KMS-held key.",
  domain_tag: DEST_BLINDING_TAG,
  key: TEST_KEY,
  vectors,
};

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "dest-blinding.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
