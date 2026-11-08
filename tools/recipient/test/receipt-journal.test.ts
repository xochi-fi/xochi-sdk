// The receipt journal (review C1, H2, M1, L4): every payout a receipt ever signed stays bound to
// its intent, terms and operation; backups carry the records and the enrolled binding digest;
// a receipt run holds the fund-movement lock.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { signRecipientDigest } from "../src/core/account.js";
import { backupContents, openBackup, sealBackup } from "../src/core/backup.js";
import { signPaymentReceipt, type ReceiptRecord } from "../src/core/receipt.js";
import { openNodeJournals } from "../src/node/data-dir.js";
import { NodeKeystoreCrypto } from "../src/node/sealed.js";
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
const crypto = new NodeKeystoreCrypto();
/** A fresh data directory's journals, through the CLI's Node adapter. */
const journals = (label: string) =>
  openNodeJournals(join(mkdtempSync(join(tmpdir(), `${label}-`)), "d"));

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
      bindingId: "TEST-ONLY-binding",
      legacyBinding: false,
      alreadySpentBy: [],
      request: submission,
    },
    challenge,
  };
}

describe("receipt journal", () => {
  it("records the payout, terms and signed request privately, then the acceptance; no secret", async () => {
    const journal = journals("receipts").receipts;
    expect(await journal.read(INTENT)).toBeNull();
    const { entry } = await signed(INTENT);
    await journal.begin(entry);
    expect(await journal.read(INTENT)).toMatchObject({ status: "submitting", txHash: hex("a7") });
    await journal.complete(INTENT, hex("dd"), "2026-11-08T00:00:00.000Z");
    const file = journal.path(INTENT);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
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
    const journal = journals("receipts").receipts;
    const first = await signed(INTENT);
    await journal.begin(first.entry);
    await expect(journal.begin(first.entry)).rejects.toThrow(/already/);
    await journal.retry(INTENT, first.entry.request, [hex("5e"), hex("5f")]);
    expect(await journal.read(INTENT)).toMatchObject({ alreadySpentBy: [hex("5e"), hex("5f")] });
    expect((await journal.read(INTENT))!.attempts).toHaveLength(2);
    const otherTx = await signed(INTENT, hex("b2"));
    await expect(journal.retry(INTENT, otherTx.entry.request, [])).rejects.toThrow(/recorded/);
    const otherTerms = await signed("another-intent");
    await expect(journal.retry(INTENT, otherTerms.entry.request, [])).rejects.toThrow(/recorded/);
    await journal.complete(INTENT, hex("dd"), "2026-11-08T00:00:00.000Z");
    await expect(journal.retry(INTENT, first.entry.request, [])).rejects.toThrow(
      /already accepted/,
    );
  });

  it("names every payout and every terms digest another intent's receipt holds", async () => {
    const journal = journals("receipts").receipts;
    await journal.begin((await signed("intent-a", hex("a1"))).entry);
    const b = await signed("intent-b", hex("b2"));
    await journal.begin(b.entry);
    await journal.complete("intent-b", hex("dd"), "2026-11-08T00:00:00.000Z");
    expect([...(await journal.receiptedTxHashes("intent-a"))]).toEqual([hex("b2")]);
    expect([...(await journal.receiptedTxHashes("intent-c"))].sort()).toEqual([
      hex("a1"),
      hex("b2"),
    ]);
    expect(
      await journal.intentPinning(
        { termsDigest: b.entry.termsDigest, operationId: hex("01") },
        "x",
      ),
    ).toBe("intent-b");
    expect(
      await journal.intentPinning(
        { termsDigest: hex("01"), operationId: b.entry.operationId },
        "x",
      ),
    ).toBe("intent-b");
    expect(await journal.intentPinning(b.entry, "intent-b")).toBeNull();
  });

  it("restores records into an empty directory only", async () => {
    const source = journals("receipts").receipts;
    await source.begin((await signed(INTENT)).entry);
    const restored = journals("restored").receipts;
    await restored.restore(await source.records());
    expect(await restored.records()).toEqual(await source.records());
    await expect(restored.restore(await source.records())).rejects.toThrow(/empty/);
  });
});

describe("backup", () => {
  it("carries the receipt records and the enrolled binding id and digest through seal and open", async () => {
    const journal = journals("receipts").receipts;
    await journal.begin((await signed(INTENT)).entry);
    const contents = backupContents(
      corridor,
      TEST_SECRETS,
      E.account,
      null,
      null,
      1_800_000_000,
      { operations: [], exits: [], receipts: await journal.records() },
      { id: "TEST-ONLY-binding", digest: E.bindingDigest },
    );
    const opened = await openBackup((await sealBackup(contents, PASS, crypto)).bytes, PASS, crypto);
    expect(opened.journals.receipts).toEqual(await journal.records());
    expect(opened.bindingDigest).toBe(E.bindingDigest);
    expect(opened.bindingId).toBe("TEST-ONLY-binding");
  });

  it("opens an earlier backup without receipts or binding", async () => {
    const earlier = backupContents(corridor, TEST_SECRETS, E.account, null, null, 1_800_000_000);
    const { bindingDigest: _digest, bindingId: _id, ...plain } = earlier;
    const json = { ...plain, journals: { operations: [], exits: [] } };
    const sealed = await sealBackup(json as unknown as typeof earlier, PASS, crypto);
    const opened = await openBackup(sealed.bytes, PASS, crypto);
    expect(opened.journals.receipts).toEqual([]);
    expect(opened.bindingDigest ?? null).toBeNull();
    expect(opened.bindingId ?? null).toBeNull();
  });
});

describe("receipt run and the fund-movement lock", () => {
  it("blocks a spend while a receipt runs, naming the run, and releases on end", async () => {
    const operations = journals("operations").operations;
    const run = await operations.beginReceipt(INTENT);
    await expect(operations.begin("spend", { amount: "1" })).rejects.toThrow(
      `a receipt run (pid ${process.pid} on ${hostname()}) holds the fund-movement lock; wait for it`,
    );
    await operations.endReceipt(run.id);
    expect((await operations.records()).find((r) => r.id === run.id)?.status).toBe("aborted");
    const spend = await operations.begin("spend", { amount: "1" });
    await operations.update(spend.id, { status: "aborted" });
  });

  it("refuses a receipt run while a spend is unresolved", async () => {
    const operations = journals("operations").operations;
    await operations.begin("spend", { amount: "1" });
    await expect(operations.beginReceipt(INTENT)).rejects.toThrow(/spend/);
  });

  it("recovers the lock of a receipt run whose process is gone", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const operations = journals("operations").operations;
    const crashed = await operations.beginReceipt(INTENT, { pid: dead, host: hostname() });
    const spend = await operations.begin("spend", { amount: "1" });
    expect((await operations.get(crashed.id)).status).toBe("aborted");
    await operations.update(spend.id, { status: "aborted" });
  });

  it("never recovers a live receipt run's lock, even after a hostname change", async () => {
    const operations = journals("operations").operations;
    const run = await operations.beginReceipt(INTENT, {
      pid: process.pid,
      host: "renamed-host.invalid",
    });
    const directory = dirname(operations.path(run.id));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "unrelated.txt"), "");
    await expect(operations.beginReceipt("another-intent")).rejects.toThrow(/receipt/);
    await expect(operations.begin("spend", { amount: "1" })).rejects.toThrow(/receipt/);
  });

  it("restores an unfinished receipt run as aborted, with no lock (it moved no funds)", async () => {
    const source = journals("operations").operations;
    const run = await source.beginReceipt(INTENT);
    const restored = journals("restored").operations;
    await restored.restore(await source.records());
    expect((await restored.get(run.id)).status).toBe("aborted");
    expect(await restored.unresolved()).toBeNull();
    const spend = await restored.begin("spend", { amount: "1" });
    await restored.update(spend.id, { status: "aborted" });
  });

  it("releases a receipt run's lock for the operator only once its process is gone, or forced", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const gone = journals("operations").operations;
    const crashed = await gone.beginReceipt(INTENT, { pid: dead, host: hostname() });
    await gone.releaseReceiptLock(crashed.id);
    expect((await gone.get(crashed.id)).status).toBe("aborted");

    const operations = journals("operations").operations;
    const live = await operations.beginReceipt(INTENT);
    await expect(operations.releaseReceiptLock(live.id)).rejects.toThrow(
      `receipt run pid ${process.pid} on ${hostname()} is still running`,
    );
    expect((await operations.get(live.id)).status).toBe("building");
    await operations.releaseReceiptLock(live.id, { force: true });
    expect((await operations.get(live.id)).status).toBe("aborted");
    await expect(operations.releaseReceiptLock(live.id)).rejects.toThrow(
      /not an unfinished receipt run/,
    );
    // The released run's own end does not throw over its result.
    await expect(operations.endReceipt(live.id)).resolves.toBeUndefined();
    const spend = await operations.begin("spend", { amount: "1" });
    await expect(operations.releaseReceiptLock(spend.id)).rejects.toThrow(
      /not an unfinished receipt run/,
    );
    await expect(operations.endReceipt(live.id)).resolves.toBeUndefined();
    await operations.update(spend.id, { status: "aborted" });
  });
});
