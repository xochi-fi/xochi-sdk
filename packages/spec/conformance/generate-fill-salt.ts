#!/usr/bin/env node
// Generates `conformance/fill-salt.json`: vectors for the venue-side destination
// fill binding (ESCROW-RFC §9.4):
//   fillSalt = HMAC-SHA256(key, utf8("riddler/fill-salt/v1") || orderId[32 raw bytes])
//   fillId   = keccak256(abi.encode(bytes32 orderId, bytes32 fillSalt))
// RiddlerFiller keys single-shot on `fillId`.
//
// The keys below are fixed, PUBLIC TEST keys. Production derives with a KMS key
// that never leaves the venue; these MUST NEVER be used outside tests.
//
// Run: npm run generate:fill-salt

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { computeFillId, deriveFillSalt, FILL_SALT_TAG } from "@xochi/signer";

// PUBLIC TEST KEYS. NOT SECRET. NEVER USE IN PRODUCTION.
const TEST_KEY = "0x" + "0c".repeat(32);
const TEST_KEY_ALT = "0x" + "0d".repeat(16);

const here = path.dirname(fileURLToPath(import.meta.url));
const orderIds = JSON.parse(fs.readFileSync(path.join(here, "order-id.json"), "utf8")).vectors;
const baselineOrderId: string = orderIds.find((v: { name: string }) => v.name === "baseline-evm-usdc").expected_order_id;

const CASES = [
  { name: "baseline", key: TEST_KEY, orderId: baselineOrderId },
  { name: "other-key", key: TEST_KEY_ALT, orderId: baselineOrderId },
  { name: "zero-order-id", key: TEST_KEY, orderId: "0x" + "00".repeat(32) },
  { name: "one-order-id", key: TEST_KEY, orderId: "0x" + "00".repeat(31) + "01" },
  { name: "max-uint256-order-id", key: TEST_KEY, orderId: "0x" + "ff".repeat(32) },
];

const vectors = CASES.map((c) => {
  const salt = deriveFillSalt(c.key, c.orderId);
  return { ...c, expected_fill_salt: salt, expected_fill_id: computeFillId(c.orderId, salt) };
});

const out = {
  $schema: "./fill-salt.schema.json",
  description:
    "Venue-side fillSalt/fillId vectors (ESCROW-RFC §9.4). `key` values are PUBLIC TEST keys; " +
    "production uses a KMS-held key never shared with the solver panel.",
  domain_tag: FILL_SALT_TAG,
  vectors,
};

const target = path.join(here, "fill-salt.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
