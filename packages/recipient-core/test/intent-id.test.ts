import { describe, expect, it } from "vitest";

import { INTENT_ID_GRAMMAR, assertIntentId } from "../src/api.js";
import { ReceiptRecordSchema } from "../src/receipt.js";

// Contract C key grammar: "/"-separated segments of [a-z0-9_][a-z0-9._-]{0,127}, at most 512
// characters. The Node, browser (IndexedDB) and memory stores all enforce exactly this.
const KV_KEY = /^[a-z0-9_][a-z0-9._-]{0,127}(?:\/[a-z0-9_][a-z0-9._-]{0,127})*$/;

const accepted = [
  "xi_0123456789abcdef0123456789abcdef",
  "3f0c2a5e-8d7b-4e1a-9c6f-0b1d2e3f4a5b",
  "_",
  "0",
  "a".repeat(64),
  "_leading-underscore",
];
const refused = [
  "Intent_A1",
  "XI_0123",
  "a".repeat(65),
  "a".repeat(129),
  "-leading-dash",
  "",
  "has.dot",
  "has/slash",
  "has space",
];

describe("core intent id grammar ^[a-z0-9_][a-z0-9_-]{0,63}$", () => {
  it.each(accepted)("accepts %s", (intentId) => {
    expect(assertIntentId(intentId)).toBe(intentId);
    expect(INTENT_ID_GRAMMAR.test(intentId)).toBe(true);
  });

  it.each(refused)("refuses %j with a message naming the grammar", (intentId) => {
    expect(() => assertIntentId(intentId)).toThrow(
      "intent id must be 1-64 characters of a-z, 0-9, '_' and '-', not starting with '-'",
    );
  });

  it("covers the Worker's route grammar ^[a-z0-9_]{1,64}$", () => {
    for (const intentId of ["xi_" + "f".repeat(32), "_".repeat(64), "z", "0_9"]) {
      expect(/^[a-z0-9_]{1,64}$/.test(intentId)).toBe(true);
      expect(INTENT_ID_GRAMMAR.test(intentId)).toBe(true);
    }
  });

  it("every accepted id is a valid receipts/<id>.json storage key (the shared KV rule)", () => {
    for (const intentId of accepted) {
      const key = `receipts/${intentId}.json`;
      expect(KV_KEY.test(key) && key.length <= 512).toBe(true);
    }
  });

  it("the receipt record schema refuses ids outside the grammar", () => {
    for (const intentId of ["Intent_A1", "a".repeat(129), "-x"]) {
      const result = ReceiptRecordSchema.shape.intentId.safeParse(intentId);
      expect(result.success).toBe(false);
    }
    expect(ReceiptRecordSchema.shape.intentId.safeParse("xi_abc").success).toBe(true);
  });
});
