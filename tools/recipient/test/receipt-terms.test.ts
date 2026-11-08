// What binds a receipt to its intent (review C1, H1, M2): the Worker's challenge must carry the
// intent's own signed terms for this account's enrolled binding, and only the payout the
// corridor's sender tagged with those terms' order fingerprint may be acknowledged.

import { readFileSync } from "node:fs";
import { hashTypedData, type TypedDataDefinition } from "viem";
import { describe, expect, it } from "vitest";
import { RECIPIENT_ACK_PURPOSES } from "@xochi/signer";

import { signRecipientDigest } from "../src/account.js";
import type { ReceiptChallenge } from "../src/api.js";
import {
  SHIELDED_TERMS_TYPES,
  checkReceiptChallenge,
  selectReceiptTransfer,
  signPaymentReceipt,
} from "../src/receipt.js";
import {
  AMOUNT,
  DEADLINE,
  INTENT,
  UNTAGGED_META,
  challengeFor,
  corridor,
  enrolled,
  expectedFingerprint,
  hex,
  metaFor,
  payoutFor,
  termsDigest,
  termsFor,
  workerVerifies,
} from "./receipt-fixtures.js";

const spec = JSON.parse(
  readFileSync(
    new URL("../../../packages/spec/conformance/shielded-terms.json", import.meta.url),
    "utf8",
  ),
) as {
  terms: {
    vectors: { message: unknown; domain: { chainId: string }; digest: string }[];
  };
};

const E = await enrolled();
const TERMS = termsFor(E);
const CHALLENGE = challengeFor(E, TERMS);
const check = (challenge: ReceiptChallenge, bindingDigest: string | null = E.bindingDigest) =>
  checkReceiptChallenge(corridor, E.account, challenge, { intentId: INTENT, bindingDigest });
/** A challenge whose terms are edited and whose digests still match them. */
const edited = (edit: Parameters<typeof termsFor>[2]) => challengeFor(E, termsFor(E, INTENT, edit));

describe("ShieldedTermsV1 types", () => {
  it("hash the @xochi/spec baseline vector to its digest", () => {
    const vector = spec.terms.vectors[0]!;
    const typed = {
      types: SHIELDED_TERMS_TYPES,
      primaryType: "ShieldedTermsV1",
      domain: { ...vector.domain, chainId: Number(vector.domain.chainId) },
      message: vector.message,
    };
    expect(hashTypedData(typed as unknown as TypedDataDefinition)).toBe(vector.digest);
  });
});

describe("receipt challenge terms", () => {
  it("accept the intent's own terms and name the payout's expected order fingerprint", () => {
    expect(check(CHALLENGE)).toEqual({
      termsDigest: termsDigest(TERMS),
      operationId: CHALLENGE.receipt.operation_id,
      amount: AMOUNT,
      validUntil: DEADLINE,
      orderFingerprint: expectedFingerprint(E, TERMS),
      bindingDigest: E.bindingDigest,
      legacyBinding: false,
    });
  });

  it("refuse terms that do not hash to terms_digest", () => {
    const forged = { ...CHALLENGE, receipt: { ...CHALLENGE.receipt, terms_digest: hex("7e") } };
    expect(() => check(forged)).toThrow(/terms_digest/);
  });

  it("refuse an amount or operation id the terms do not name", () => {
    expect(() =>
      check({ ...CHALLENGE, receipt: { ...CHALLENGE.receipt, amount: (AMOUNT + 1n).toString() } }),
    ).toThrow(/amount/);
    expect(() =>
      check({ ...CHALLENGE, receipt: { ...CHALLENGE.receipt, operation_id: hex("0d") } }),
    ).toThrow(/operation_id/);
  });

  it("refuse terms for another intent, recipient, descriptor, token, network or corridor", () => {
    expect(() =>
      checkReceiptChallenge(corridor, E.account, CHALLENGE, {
        intentId: "another-intent",
        bindingDigest: E.bindingDigest,
      }),
    ).toThrow(/intent/);
    expect(() => check(edited((m) => (m.destination.aztecRecipient = hex("22"))))).toThrow(
      /recipient/,
    );
    expect(() => check(edited((m) => (m.destination.descriptorDigest = hex("d5"))))).toThrow(
      /descriptor/,
    );
    expect(() => check(edited((m) => (m.destination.aztecToken = hex("11"))))).toThrow(/token/);
    expect(() =>
      check(edited((m) => (m.destination.network = { ...m.destination.network, l1ChainId: "5" }))),
    ).toThrow(/network/);
    expect(() =>
      check(
        edited(
          (m) => (m.destination.corridor = { ...m.destination.corridor, corridorRevision: "1" }),
        ),
      ),
    ).toThrow(/corridor/);
  });

  it("refuse terms under another typed-data schema or domain", () => {
    const types = {
      ...SHIELDED_TERMS_TYPES,
      ShieldedTermsV1: SHIELDED_TERMS_TYPES.ShieldedTermsV1.filter((f) => f.name !== "destination"),
    };
    const reshaped = challengeFor(E, { ...TERMS, types } as typeof TERMS);
    expect(() => check(reshaped)).toThrow(/types/);
    const otherDomain = challengeFor(E, { ...TERMS, domain: { ...TERMS.domain, chainId: 5 } });
    expect(() => check(otherDomain)).toThrow(/domain/);
  });

  it("refuse unless the terms and challenge name this data directory's enrolled binding", () => {
    expect(() => check(CHALLENGE, null)).toThrow(/enrolled binding digest is unknown/);
    expect(() => check(CHALLENGE, hex("b1"))).toThrow(/binding/);
    const otherBinding = edited((m) => (m.recipientBindingDigest = hex("b1")));
    expect(() => check(otherBinding)).toThrow(/binding/);
    expect(() =>
      check({ ...CHALLENGE, receipt: { ...CHALLENGE.receipt, binding_digest: hex("b1") } }),
    ).toThrow(/binding/);
  });

  describe("--legacy-binding (a data directory enrolled before the digest was recorded)", () => {
    const legacy = (
      challenge: ReceiptChallenge,
      bindingId: string | null = "TEST-ONLY-binding",
      bindingDigest: string | null = null,
    ) =>
      checkReceiptChallenge(corridor, E.account, challenge, {
        intentId: INTENT,
        bindingDigest,
        bindingId,
        legacyBinding: true,
      });

    it("adopts the challenge's binding digest when its binding id is this data directory's", () => {
      expect(legacy(CHALLENGE)).toMatchObject({
        bindingDigest: E.bindingDigest,
        legacyBinding: true,
        termsDigest: termsDigest(TERMS),
      });
    });

    it("names the flag and its conditions in the refusal without it", () => {
      expect(() => check(CHALLENGE, null)).toThrow(
        /--legacy-binding.*binding_id.*TEST-ONLY|--legacy-binding.*binding id/,
      );
    });

    it("refuses another binding id, an unknown one, or a data directory that knows its digest", () => {
      expect(() => legacy(CHALLENGE, "another-binding")).toThrow(/binding id/);
      expect(() => legacy(CHALLENGE, null)).toThrow(/no enrolled binding id/);
      expect(() => legacy(CHALLENGE, "TEST-ONLY-binding", E.bindingDigest)).toThrow(
        /only for a data directory without a recorded binding digest/,
      );
    });

    it("still requires the terms to name that digest, this account, descriptor, token and network", () => {
      const otherBinding = edited((m) => (m.recipientBindingDigest = hex("b1")));
      expect(() => legacy(otherBinding)).toThrow(/binding/);
      expect(() => legacy(edited((m) => (m.destination.aztecRecipient = hex("22"))))).toThrow(
        /recipient/,
      );
      expect(() => legacy(edited((m) => (m.destination.descriptorDigest = hex("d5"))))).toThrow(
        /descriptor/,
      );
      expect(() => legacy(edited((m) => (m.destination.aztecToken = hex("11"))))).toThrow(/token/);
      expect(() =>
        legacy(
          edited((m) => (m.destination.network = { ...m.destination.network, l1ChainId: "5" })),
        ),
      ).toThrow(/network/);
    });
  });
});

describe("payout selection", () => {
  const fp = expectedFingerprint(E, TERMS);
  const want = { amount: AMOUNT, orderFingerprint: fp, senders: corridor.registeredSenders };
  const none = new Set<string>();
  const auto = { tx: null, untagged: false };

  it("picks the corridor sender's payout tagged with this intent's order fingerprint", () => {
    const chosen = selectReceiptTransfer(
      [
        payoutFor(E, TERMS, { txHash: hex("a1"), amount: AMOUNT - 1n }),
        payoutFor(E, TERMS),
        payoutFor(E, TERMS, { txHash: hex("a2"), meta: metaFor(hex("ee")) }),
      ],
      want,
      none,
      auto,
    );
    expect(chosen).toMatchObject({ tagged: true, transfer: { txHash: hex("a7") } });
  });

  it("never counts a transfer from any other sender, such as the account's own", () => {
    const self = payoutFor(E, TERMS, { from: E.account.descriptor.aztecAddress });
    expect(() => selectReceiptTransfer([self], want, none, auto)).toThrow(
      /no payout from the corridor's sender/,
    );
    expect(() =>
      selectReceiptTransfer([self], want, none, { tx: hex("a7"), untagged: true }),
    ).toThrow(/not from the corridor's sender/);
  });

  it("refuses an untagged payout unless --tx names it with --untagged", () => {
    const untagged = payoutFor(E, TERMS, { meta: UNTAGGED_META });
    expect(() => selectReceiptTransfer([untagged], want, none, auto)).toThrow(/--untagged/);
    expect(() =>
      selectReceiptTransfer([untagged], want, none, { tx: null, untagged: true }),
    ).toThrow(/--untagged needs --tx/);
    expect(
      selectReceiptTransfer([untagged], want, none, { tx: hex("a7"), untagged: true }),
    ).toMatchObject({ tagged: false, transfer: { txHash: hex("a7") } });
    const otherOrder = payoutFor(E, TERMS, { meta: metaFor(hex("ee")) });
    expect(() =>
      selectReceiptTransfer([otherOrder], want, none, { tx: hex("a7"), untagged: true }),
    ).toThrow(/another order/);
  });

  it("refuses --untagged while this intent's tagged payout exists", () => {
    const tagged = payoutFor(E, TERMS);
    const untagged = payoutFor(E, TERMS, { txHash: hex("b2"), meta: UNTAGGED_META });
    expect(() =>
      selectReceiptTransfer([tagged, untagged], want, none, { tx: hex("b2"), untagged: true }),
    ).toThrow(new RegExp(`tagged payout ${hex("a7")}`));
  });

  it("lets --tx pick only among this intent's tagged payouts, never a receipted one", () => {
    const two = [payoutFor(E, TERMS), payoutFor(E, TERMS, { txHash: hex("b2") })];
    expect(() => selectReceiptTransfer(two, want, none, auto)).toThrow(/--tx/);
    expect(
      selectReceiptTransfer(two, want, none, { tx: `0x${"B2".repeat(32)}`, untagged: false }),
    ).toMatchObject({ transfer: { txHash: hex("b2") } });
    expect(() =>
      selectReceiptTransfer(two, want, none, { tx: hex("c3"), untagged: false }),
    ).toThrow(/not a payout of this intent/);
    expect(selectReceiptTransfer(two, want, new Set([hex("a7")]), auto).transfer.txHash).toBe(
      hex("b2"),
    );
    expect(() =>
      selectReceiptTransfer(two, want, new Set([hex("a7")]), { tx: hex("a7"), untagged: false }),
    ).toThrow(/already acknowledged for another intent/);
    expect(() => selectReceiptTransfer(two, want, none, { tx: "0x1234", untagged: false })).toThrow(
      /--tx/,
    );
  });
});

describe("PaymentReceiptAck", () => {
  it("signs the payout so the Worker's verifier accepts it, and only for its settlement", async () => {
    const { submission, digest } = await signPaymentReceipt({
      corridor,
      account: E.account,
      challenge: CHALLENGE,
      transfer: payoutFor(E, TERMS),
      sign: signRecipientDigest,
    });
    expect(submission.acknowledgement.message).toEqual({
      bindingDigest: E.bindingDigest,
      termsDigest: CHALLENGE.receipt.terms_digest,
      operationId: CHALLENGE.receipt.operation_id,
      network: corridor.network,
      txHash: hex("a7"),
      blockNumber: "4242",
      aztecToken: corridor.token.address,
      amount: AMOUNT.toString(),
      aztecRecipient: E.account.descriptor.aztecAddress,
      nonce: CHALLENGE.nonce,
      challengeExpiry: "1900000000",
      purpose: RECIPIENT_ACK_PURPOSES.PaymentReceiptAck,
    });
    const ack = submission.acknowledgement;
    const settled = { txHash: hex("a7"), blockNumber: 4242 };
    expect((await workerVerifies(E, CHALLENGE, ack, settled)).digest).toBe(digest);
    await expect(
      workerVerifies(E, CHALLENGE, ack, { ...settled, txHash: hex("a8") }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });
    await expect(
      workerVerifies(E, CHALLENGE, ack, { ...settled, blockNumber: 4243 }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });
  });
});
