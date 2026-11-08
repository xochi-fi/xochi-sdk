// The receipt journal (review C1, H2, M1, L4): every payout a receipt ever signed stays bound to
// its intent, terms and operation; backups carry the records and the enrolled binding digest;
// a receipt run holds the fund-movement lock.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { signRecipientDigest } from "../src/account.js";
import { backupContents, openBackup, sealBackup } from "../src/backup.js";
import { OperationJournal } from "../src/operation-journal.js";
import { ReceiptJournal, signPaymentReceipt, type ReceiptRecord } from "../src/receipt.js";
import { TEST_SECRETS } from "./fixtures.js";
import {
  AMOUNT,
  INTENT,
  challengeFor,
  corridor,
  enrolled,
  hex,
  payoutFor,
  termsFor,
} from "./receipt-fixtures.js";

const E = await enrolled();
const PASS = "receipt journal TEST ONLY";
const temp = (label: string) => join(mkdtempSync(join(tmpdir(), `${label}-`)), "d");

/** A signed receipt for `intentId`'s terms and the payout in `txHash`. */
async function signed(intentId: string, txHash = hex("a7")) {
  const terms = termsFor(E, intentId);
  const challenge = challengeFor(E, terms);
  const { submission } = await signPaymentReceipt({
    corridor,
    account: E.account,
    challenge,
    transfer: payoutFor(E, terms, { txHash }),
    sign: signRecipientDigest,
  });
  return {
    entry: {
      intentId,
      termsDigest: challenge.receipt.terms_digest,
      operationId: challenge.receipt.operation_id,
      amount: AMOUNT.toString(),
      txHash,
      blockNumber: "4242",
      legacyBinding: false,
      alreadySpentBy: null,
      request: submission,
    },
    challenge,
  };
}

describe("receipt journal", () => {
  it("records the payout, terms and signed request privately, then the acceptance; no secret", async () => {
    const journal = new ReceiptJournal(temp("receipts"));
    expect(journal.read(INTENT)).toBeNull();
    const { entry } = await signed(INTENT);
    journal.begin(entry);
    expect(journal.read(INTENT)).toMatchObject({ status: "submitting", txHash: hex("a7") });
    journal.complete(INTENT, hex("dd"), "2026-11-08T00:00:00.000Z");
    const file = join(journal.directory, `${INTENT}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(journal.directory).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, "utf8")) as ReceiptRecord;
    expect(stored).toMatchObject({
      intentId: INTENT,
      status: "submitted",
      termsDigest: entry.termsDigest,
      operationId: entry.operationId,
      amount: entry.amount,
      txHash: hex("a7"),
      blockNumber: "4242",
      receipt_digest: hex("dd"),
      submitted_at: "2026-11-08T00:00:00.000Z",
    });
    expect(stored.attempts).toHaveLength(1);
    const text = readFileSync(file, "utf8");
    for (const secret of [TEST_SECRETS.secret, TEST_SECRETS.salt]) {
      expect(text).not.toContain(secret.slice(2));
    }
  });

  it("appends every retry and refuses one for other terms, operation, amount or payout", async () => {
    const journal = new ReceiptJournal(temp("receipts"));
    const first = await signed(INTENT);
    journal.begin(first.entry);
    expect(() => journal.begin(first.entry)).toThrow(/already/);
    journal.retry(INTENT, first.entry.request, hex("5e"));
    expect(journal.read(INTENT)).toMatchObject({ alreadySpentBy: hex("5e") });
    expect(journal.read(INTENT)!.attempts).toHaveLength(2);
    const otherTx = await signed(INTENT, hex("b2"));
    expect(() => journal.retry(INTENT, otherTx.entry.request, null)).toThrow(/recorded/);
    const otherTerms = await signed("another-intent");
    expect(() => journal.retry(INTENT, otherTerms.entry.request, null)).toThrow(/recorded/);
    journal.complete(INTENT, hex("dd"), "2026-11-08T00:00:00.000Z");
    expect(() => journal.retry(INTENT, first.entry.request, null)).toThrow(/already accepted/);
  });

  it("names every payout and every terms digest another intent's receipt holds", async () => {
    const journal = new ReceiptJournal(temp("receipts"));
    journal.begin((await signed("intent-a", hex("a1"))).entry);
    const b = await signed("intent-b", hex("b2"));
    journal.begin(b.entry);
    journal.complete("intent-b", hex("dd"), "2026-11-08T00:00:00.000Z");
    expect([...journal.receiptedTxHashes("intent-a")]).toEqual([hex("b2")]);
    expect([...journal.receiptedTxHashes("intent-c")].sort()).toEqual([hex("a1"), hex("b2")]);
    expect(
      journal.intentPinning({ termsDigest: b.entry.termsDigest, operationId: hex("01") }, "x"),
    ).toBe("intent-b");
    expect(
      journal.intentPinning({ termsDigest: hex("01"), operationId: b.entry.operationId }, "x"),
    ).toBe("intent-b");
    expect(journal.intentPinning(b.entry, "intent-b")).toBeNull();
  });

  it("restores records into an empty directory only", async () => {
    const source = new ReceiptJournal(temp("receipts"));
    source.begin((await signed(INTENT)).entry);
    const restored = new ReceiptJournal(temp("restored"));
    restored.restore(source.records());
    expect(restored.records()).toEqual(source.records());
    expect(() => restored.restore(source.records())).toThrow(/empty/);
  });
});

describe("backup", () => {
  it("carries the receipt records and the enrolled binding id and digest through seal and open", async () => {
    const journal = new ReceiptJournal(temp("receipts"));
    journal.begin((await signed(INTENT)).entry);
    const contents = backupContents(
      corridor,
      TEST_SECRETS,
      E.account,
      null,
      null,
      1_800_000_000,
      { operations: [], exits: [], receipts: journal.records() },
      { id: "TEST-ONLY-binding", digest: E.bindingDigest },
    );
    const opened = openBackup(sealBackup(contents, PASS).bytes, PASS);
    expect(opened.journals.receipts).toEqual(journal.records());
    expect(opened.bindingDigest).toBe(E.bindingDigest);
    expect(opened.bindingId).toBe("TEST-ONLY-binding");
  });

  it("opens an earlier backup without receipts or binding", () => {
    const earlier = backupContents(corridor, TEST_SECRETS, E.account, null, null, 1_800_000_000);
    const { bindingDigest: _digest, bindingId: _id, ...plain } = earlier;
    const json = { ...plain, journals: { operations: [], exits: [] } };
    const opened = openBackup(sealBackup(json as unknown as typeof earlier, PASS).bytes, PASS);
    expect(opened.journals.receipts).toEqual([]);
    expect(opened.bindingDigest ?? null).toBeNull();
    expect(opened.bindingId ?? null).toBeNull();
  });
});

describe("receipt run and the fund-movement lock", () => {
  it("blocks a spend while a receipt runs, and releases on end", () => {
    const operations = new OperationJournal(temp("operations"));
    const run = operations.beginReceipt(INTENT);
    expect(() => operations.begin("spend", { amount: "1" })).toThrow(/receipt/);
    operations.endReceipt(run.id);
    expect(operations.records().find((r) => r.id === run.id)?.status).toBe("aborted");
    const spend = operations.begin("spend", { amount: "1" });
    operations.update(spend.id, { status: "aborted" });
  });

  it("refuses a receipt run while a spend is unresolved", () => {
    const operations = new OperationJournal(temp("operations"));
    operations.begin("spend", { amount: "1" });
    expect(() => operations.beginReceipt(INTENT)).toThrow(/spend/);
  });

  it("recovers the lock of a receipt run whose process is gone", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const operations = new OperationJournal(temp("operations"));
    const crashed = operations.beginReceipt(INTENT, { pid: dead, host: hostname() });
    const spend = operations.begin("spend", { amount: "1" });
    expect(operations.get(crashed.id).status).toBe("aborted");
    operations.update(spend.id, { status: "aborted" });
  });

  it("never recovers a live receipt run's lock, even after a hostname change", () => {
    const operations = new OperationJournal(temp("operations"));
    operations.beginReceipt(INTENT, { pid: process.pid, host: "renamed-host.invalid" });
    writeFileSync(join(operations.directory, "unrelated.txt"), "");
    expect(() => operations.beginReceipt("another-intent")).toThrow(/receipt/);
    expect(() => operations.begin("spend", { amount: "1" })).toThrow(/receipt/);
  });

  it("restores an unfinished receipt run as aborted, with no lock (it moved no funds)", () => {
    const source = new OperationJournal(temp("operations"));
    const run = source.beginReceipt(INTENT);
    const restored = new OperationJournal(temp("restored"));
    restored.restore(source.records());
    expect(restored.get(run.id).status).toBe("aborted");
    expect(restored.unresolved()).toBeNull();
    const spend = restored.begin("spend", { amount: "1" });
    restored.update(spend.id, { status: "aborted" });
  });

  it("lets an operator release a receipt run's lock (operations reconcile)", () => {
    const operations = new OperationJournal(temp("operations"));
    operations.beginReceipt(INTENT);
    const held = operations.activeUnresolved()!;
    operations.releaseReceiptLock(held.id);
    expect(operations.get(held.id).status).toBe("aborted");
    expect(() => operations.releaseReceiptLock(held.id)).toThrow(/not an unfinished receipt run/);
    const spend = operations.begin("spend", { amount: "1" });
    expect(() => operations.releaseReceiptLock(spend.id)).toThrow(/not an unfinished receipt run/);
    operations.update(spend.id, { status: "aborted" });
  });
});
