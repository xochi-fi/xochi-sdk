/**
 * Deposit bindings persisted by builds from before the cutover to
 * `@xochi/signer`: camelCase fields, `resolvedSettlementType` for the resolved
 * settlement, and optionals that were `undefined` and so are absent after the
 * JSON round trip through localStorage.
 *
 * The signatures here are Riddler's, not ours: every record is built from the
 * server-generated deposit attestation vectors (`packages/reference/test/vectors`),
 * so "verifies after migration" means the renamed record signs the exact bytes
 * the producer signed, not bytes this repo agrees with itself about.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { DepositAttestationFields } from "@xochi/signer";
import { verifyStoredDeposit } from "./deposit.js";

interface Vector {
  name: string;
  quote: DepositAttestationFields;
  deposit_attestation: string;
}

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../reference/test/vectors/deposit_attestation.json",
    ),
    "utf-8",
  ),
) as { signer: string; vectors: Vector[] };

const SIGNER = fixture.signer;

/** The record exactly as a pre-cutover build wrote it to localStorage. */
function legacyRecord(v: Vector): { attested: Record<string, unknown>; attestation: string } {
  const q = v.quote;
  return JSON.parse(
    JSON.stringify({
      attested: {
        intentId: q.intent_id,
        quoteId: q.quote_id,
        wallet: q.wallet,
        fromChainId: q.from_chain_id,
        fromToken: q.from_token,
        fromAmount: q.from_amount,
        depositAddress: q.deposit_address,
        depositDeadline: q.deposit_deadline ?? undefined,
        refundAddress: q.refund_address ?? undefined,
        toChainId: q.to_chain_id,
        toToken: q.to_token,
        toAmount: q.to_amount,
        minToAmount: q.min_to_amount,
        recipient: q.recipient,
        stealthSpendingPubKey: q.stealth_spending_pub_key ?? undefined,
        stealthViewingPubKey: q.stealth_viewing_pub_key ?? undefined,
        resolvedSettlementType: q.settlement_preference,
      },
      attestation: v.deposit_attestation,
    }),
  );
}

/** The signed field set, and nothing else the vector's quote carries. */
function signedFields(q: DepositAttestationFields): DepositAttestationFields {
  return {
    intent_id: q.intent_id,
    quote_id: q.quote_id,
    wallet: q.wallet,
    from_chain_id: q.from_chain_id,
    from_token: q.from_token,
    from_amount: q.from_amount,
    deposit_address: q.deposit_address,
    deposit_deadline: q.deposit_deadline,
    refund_address: q.refund_address,
    to_chain_id: q.to_chain_id,
    to_token: q.to_token,
    to_amount: q.to_amount,
    min_to_amount: q.min_to_amount,
    recipient: q.recipient,
    stealth_spending_pub_key: q.stealth_spending_pub_key,
    stealth_viewing_pub_key: q.stealth_viewing_pub_key,
    settlement_preference: q.settlement_preference,
  };
}

function expectedFor(v: Vector) {
  return { intentId: v.quote.intent_id, owner: v.quote.wallet };
}

const withRefund = fixture.vectors.find((v) => v.name === "refund_address_base58_verbatim")!;

describe("verifyStoredDeposit on a pre-cutover camelCase record", () => {
  it("has the vectors it claims to run", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(5);
    expect(withRefund).toBeDefined();
  });

  it.each(fixture.vectors.map((v) => [v.name, v] as const))(
    "%s verifies after migration and comes back in the signer's shape",
    (_name, v) => {
      expect(verifyStoredDeposit(legacyRecord(v), SIGNER, expectedFor(v))).toEqual({
        ok: true,
        stored: { attested: signedFields(v.quote), attestation: v.deposit_attestation },
      });
    },
  );

  it.each([
    ["depositAddress", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
    ["refundAddress", "TQ5NMqJjHEuBSyqAJqiZKYHRLmVYFvQvsP"],
    ["fromAmount", "1000001"],
    ["resolvedSettlementType", "stealth"],
  ])("refuses a migrated record whose %s was edited", (field, value) => {
    const record = legacyRecord(withRefund);
    record.attested[field] = value;
    const result = verifyStoredDeposit(record, SIGNER, expectedFor(withRefund));
    expect(result.ok).toBe(false);
  });

  // An optional the signer bound non-empty, dropped from storage, signs an
  // empty line instead and must not recover.
  it("refuses a migrated record that lost a signed optional", () => {
    const record = legacyRecord(withRefund);
    delete record.attested.refundAddress;
    expect(verifyStoredDeposit(record, SIGNER, expectedFor(withRefund)).ok).toBe(false);
  });

  it.each(["quoteId", "depositAddress", "fromChainId", "resolvedSettlementType"])(
    "refuses a record missing %s before any signature is read",
    (field) => {
      const record = legacyRecord(withRefund);
      delete record.attested[field];
      expect(verifyStoredDeposit(record, SIGNER, expectedFor(withRefund))).toEqual({
        ok: false,
        kind: "unavailable",
        reason: `stored deposit field ${field} is missing`,
      });
    },
  );

  it("refuses a field of the wrong type rather than coercing it", () => {
    const record = legacyRecord(withRefund);
    record.attested.fromChainId = String(withRefund.quote.from_chain_id);
    expect(verifyStoredDeposit(record, SIGNER, expectedFor(withRefund))).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "stored deposit field fromChainId is malformed",
    });
  });

  it("still binds the migrated record to its intent and owner", () => {
    const record = legacyRecord(withRefund);
    expect(
      verifyStoredDeposit(record, SIGNER, { intentId: "xi_other", owner: withRefund.quote.wallet })
        .ok,
    ).toBe(false);
    expect(
      verifyStoredDeposit(record, SIGNER, {
        intentId: withRefund.quote.intent_id,
        owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["no record", null],
    ["a bare string", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"],
    ["no attestation", { attested: { intentId: "xi_1" } }],
    ["loose display fields", { attested: { depositAddress: "T..." }, attestation: "0x00" }],
  ])("refuses %s", (_label, raw) => {
    const result = verifyStoredDeposit(raw, SIGNER, expectedFor(withRefund));
    expect(result.ok).toBe(false);
  });
});
