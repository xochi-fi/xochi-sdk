/**
 * Strict parsing of another person's stealth meta-address (Send > Stealth).
 *
 * What must stay true: the canonical `st:eth:0x` form of two compressed
 * secp256k1 public keys parses to exactly those keys, and every other shape is
 * refused with a reason, never repaired into a different recipient.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPROMISED_STEALTH_SPENDING_PUB_KEYS, encodeMetaAddress } from "@xochi/signer";
import { abbreviateMetaAddress, parseStealthMetaAddress } from "./stealthRecipient.js";

interface ReverseVector {
  name: string;
  spending_pub: string;
  viewing_pub: string;
}

const vectors: ReverseVector[] = JSON.parse(
  readFileSync(new URL("../../lib/reverse-stealth-vectors.json", import.meta.url), "utf8"),
);
const v = vectors[0]!;
const ENCODED = encodeMetaAddress({
  spendingPubKey: v.spending_pub,
  viewingPubKey: v.viewing_pub,
  chainId: 1,
});
const SPEND = v.spending_pub.slice(2);
const VIEW = v.viewing_pub.slice(2);
/** x = 5 has no point on secp256k1. */
const OFF_CURVE = `02${"5".padStart(64, "0")}`;

const error = (input: string): string => {
  const check = parseStealthMetaAddress(input);
  if (check.ok) throw new Error(`expected a refusal for ${input}`);
  return check.error;
};

describe("parseStealthMetaAddress", () => {
  it.each(vectors)("parses $name's encoded meta-address to its own keys", (vector) => {
    const encoded = encodeMetaAddress({
      spendingPubKey: vector.spending_pub,
      viewingPubKey: vector.viewing_pub,
      chainId: 1,
    });
    expect(parseStealthMetaAddress(encoded)).toEqual({
      ok: true,
      recipient: {
        encoded,
        spendingPubKey: vector.spending_pub,
        viewingPubKey: vector.viewing_pub,
      },
    });
  });

  it("ignores whitespace around a paste and reads hex case-insensitively", () => {
    const check = parseStealthMetaAddress(`  st:eth:0x${(SPEND + VIEW).toUpperCase()}\n`);
    expect(check.ok && check.recipient.encoded).toBe(ENCODED);
  });

  it("refuses an empty field", () => {
    expect(error("   ")).toMatch(/Paste/);
  });

  it.each([
    ["a plain address", "0x2222222222222222222222222222222222222222"],
    ["another scheme's prefix", `st:base:0x${SPEND}${VIEW}`],
    ["no 0x", `st:eth:${SPEND}${VIEW}`],
    ["an upper-case prefix", `ST:ETH:0x${SPEND}${VIEW}`],
  ])("refuses %s", (_, input) => {
    expect(error(input)).toMatch(/starts with st:eth:0x/);
  });

  it("refuses a body that is not hex", () => {
    expect(error(`st:eth:0x${SPEND}${VIEW.slice(0, -1)}g`)).toMatch(/not hex/);
  });

  it.each([
    ["one key", `st:eth:0x${SPEND}`],
    ["a byte short", `st:eth:0x${SPEND}${VIEW.slice(0, -2)}`],
    ["a byte long", `st:eth:0x${SPEND}${VIEW}00`],
    ["inner whitespace", `st:eth:0x${SPEND} ${VIEW}`],
  ])("refuses %s", (_, input) => {
    expect(parseStealthMetaAddress(input).ok).toBe(false);
  });

  it("names the length it got", () => {
    expect(error(`st:eth:0x${SPEND}`)).toBe(
      "The meta-address is 66 hex characters after st:eth:0x; it must be 132.",
    );
  });

  it.each([
    ["spending", `04${SPEND.slice(2)}${VIEW}`],
    ["viewing", `${SPEND}04${VIEW.slice(2)}`],
  ])("refuses an uncompressed-prefix %s key", (name, body) => {
    expect(error(`st:eth:0x${body}`)).toBe(
      `The ${name} key is not a compressed public key (it must start with 02 or 03).`,
    );
  });

  it.each([
    ["spending", `${OFF_CURVE}${VIEW}`],
    ["viewing", `${SPEND}${OFF_CURVE}`],
  ])("refuses a %s key that is not on the curve", (name, body) => {
    expect(error(`st:eth:0x${body}`)).toBe(`The ${name} key is not a valid secp256k1 public key.`);
  });

  it("refuses a spending key whose private key is public", () => {
    const compromised = COMPROMISED_STEALTH_SPENDING_PUB_KEYS[0]!.slice(2);
    expect(error(`st:eth:0x${compromised}${VIEW}`)).toMatch(/publicly known spending key/);
  });
});

describe("abbreviateMetaAddress", () => {
  it("keeps the prefix and both ends", () => {
    expect(abbreviateMetaAddress(ENCODED)).toBe(
      `st:eth:0x${SPEND.slice(0, 6)}...${VIEW.slice(-6)}`,
    );
  });
});
