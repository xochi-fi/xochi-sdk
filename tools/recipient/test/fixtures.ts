// Deterministic fixtures. Every secret is a TEST ONLY value derived from a label; none is a
// real key and none may be used for anything else.

import { Fr } from "@aztec-labs/aztec.js/fields";
import { keccak256, toHex } from "viem";

import type { AccountSecrets } from "../src/core/account.js";

/** keccak256(label) reduced into the BN254 scalar field. The label must say TEST ONLY. */
export function testField(label: string): string {
  if (!label.includes("TEST ONLY")) throw new Error(`test label must say TEST ONLY: ${label}`);
  return new Fr(BigInt(keccak256(toHex(label))) % Fr.MODULUS).toString();
}

export const TEST_SECRETS: AccountSecrets = {
  secret: testField("xochi-recipient TEST ONLY account secret"),
  salt: testField("xochi-recipient TEST ONLY account salt"),
};

/** A TEST ONLY secp256k1 key for the source wallet. */
export const TEST_SOURCE_KEY = keccak256(toHex("xochi-recipient TEST ONLY source wallet"));
