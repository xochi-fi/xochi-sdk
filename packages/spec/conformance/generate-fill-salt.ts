#!/usr/bin/env node
// Generates `conformance/fill-salt.json`: the venue-side fillSalt/fillId vectors
// (ESCROW-RFC.md §9.4).
//
// The keys below are fixed, PUBLIC TEST keys. Production derives with a KMS key
// that never leaves the venue; these MUST NEVER be used outside tests.
//
// Run: npm run generate:fill-salt -w @xochi/spec

import { computeFillId, deriveFillSalt, FILL_SALT_TAG } from "@xochi/signer";

import { baselineOrderId, writeVectors } from "./_lib.js";

const TEST_KEY = "0x" + "0c".repeat(32);
const TEST_KEY_ALT = "0x" + "0d".repeat(16);

const BASELINE_ORDER_ID = baselineOrderId();

const CASES = [
  { name: "baseline", key: TEST_KEY, orderId: BASELINE_ORDER_ID },
  { name: "other-key", key: TEST_KEY_ALT, orderId: BASELINE_ORDER_ID },
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

writeVectors("fill-salt.json", out);
