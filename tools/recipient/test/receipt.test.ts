// `xochi-recipient receipt`: the recipient's own PaymentReceiptAck for a shielded payout it
// discovered, found finalized on its node and could spend. Every ack is checked through the
// Worker's verifier (`verifyRecipientAck`) with the expected values the Worker pins.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TxStatus } from "@aztec-labs/stdlib/tx";

import type { RecipientAccount } from "../src/account.js";
import {
  DryRunEnrollmentApi,
  EnrollmentApiError,
  HttpEnrollmentApi,
  type ReceiptApi,
  type ReceiptChallenge,
  type ReceiptResult,
  type ReceiptSubmission,
} from "../src/api.js";
import { DryRunAztec, type ObservedTxReceipt, type ReceivedTransfer } from "../src/chain.js";
import { receipt, type Ctx, type ReceiptRequest } from "../src/commands.js";
import { OperationJournal } from "../src/operation-journal.js";
import { ReceiptJournal } from "../src/receipt.js";
import {
  AMOUNT,
  INTENT,
  UNTAGGED_META,
  challengeFor,
  corridor,
  enrolled,
  hex,
  payoutFor,
  termsFor,
  workerVerifies,
  type Enrolled,
} from "./receipt-fixtures.js";

const E = await enrolled();
const TERMS = termsFor(E);
const CHALLENGE = challengeFor(E, TERMS);
const temp = (label: string) => join(mkdtempSync(join(tmpdir(), `${label}-`)), "d");
const refusal = (status: number, category?: string) =>
  new EnrollmentApiError(
    status,
    JSON.stringify({ success: false, error: "TEST ONLY", error_category: category }),
    "POST receipt",
  );

interface Seen {
  url: string;
  init: RequestInit;
}

function fetchAnswering(status: number, body: unknown, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const http = (status: number, body: unknown, seen: Seen[] = []) =>
  new HttpEnrollmentApi(
    "https://api.xochi.fi",
    "TEST ONLY jwt",
    fetchAnswering(status, body, seen),
  );

describe("receipt API", () => {
  it("requests the receipt challenge for the intent with the source-wallet bearer", async () => {
    const seen: Seen[] = [];
    expect(await http(201, CHALLENGE, seen).requestReceiptChallenge(INTENT)).toEqual(CHALLENGE);
    expect(seen[0]!.url).toBe(
      `https://api.xochi.fi/api/shielded/operations/${INTENT}/receipt/challenge`,
    );
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: "{}", redirect: "error" });
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer TEST ONLY jwt" });
  });

  it("refuses a challenge without terms, with an unknown member, or a non-decimal amount", async () => {
    const { terms: _terms, ...bare } = CHALLENGE.receipt;
    await expect(
      http(201, { ...CHALLENGE, receipt: bare }).requestReceiptChallenge(INTENT),
    ).rejects.toThrow();
    await expect(
      http(201, { ...CHALLENGE, binding: {} }).requestReceiptChallenge(INTENT),
    ).rejects.toThrow();
    const numeric = { ...CHALLENGE, receipt: { ...CHALLENGE.receipt, amount: 1e18 } };
    await expect(http(201, numeric).requestReceiptChallenge(INTENT)).rejects.toThrow();
  });

  it("never puts a path-shaped intent id into the route", async () => {
    const seen: Seen[] = [];
    await expect(http(201, CHALLENGE, seen).requestReceiptChallenge("../x")).rejects.toThrow(
      /intent id/,
    );
    expect(seen).toEqual([]);
  });

  it("submits the acknowledgement and parses the completed answer", async () => {
    const seen: Seen[] = [];
    const answer = { intent_id: INTENT, status: "completed", receipt_digest: hex("dd") };
    const body = {
      challenge_id: "TEST-ONLY-receipt-challenge",
      acknowledgement: {
        primary_type: "PaymentReceiptAck" as const,
        message: { purpose: "TEST ONLY" },
        signature: `0x${"aa".repeat(64)}`,
      },
    };
    expect(await http(200, answer, seen).submitReceipt(INTENT, body)).toEqual(answer);
    expect(seen[0]!.url).toBe(`https://api.xochi.fi/api/shielded/operations/${INTENT}/receipt`);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(body);
  });

  it("names a refusal's status and category; only an outright rejection allows starting over", async () => {
    const body = { success: false, error: "TEST ONLY", error_category: "receipt_ack_rejected" };
    await expect(
      http(409, body).submitReceipt(INTENT, {} as ReceiptSubmission),
    ).rejects.toMatchObject({
      status: 409,
      category: "receipt_ack_rejected",
      rejectsReceipt: true,
    });
    expect(refusal(410, "receipt_challenge_expired").rejectsReceipt).toBe(true);
    expect(refusal(409, "receipt_challenge_consumed").rejectsReceipt).toBe(true);
    for (const kept of [
      refusal(409, "payout_not_final"),
      refusal(409, "receipt_tx_conflict"),
      refusal(409),
      refusal(429, "receipt_ack_rejected"),
      refusal(401),
      refusal(503),
      new EnrollmentApiError(409, "<html>proxy</html>", "POST receipt"),
    ]) {
      expect(kept.rejectsReceipt).toBe(false);
    }
  });
});

const FINALIZED: ObservedTxReceipt = {
  status: TxStatus.FINALIZED,
  blockNumber: 4242,
  executionSucceeded: true,
};
const ARTIFACT = { name: "OxideToken" } as ContractArtifact;

/** The recipient's own node and PXE: discovered payouts, node receipts and spendability. */
class PayoutNode extends DryRunAztec {
  simulationError: Error | null = null;

  constructor(
    private readonly events: string[],
    public payouts: ReceivedTransfer[],
    public nodeReceipts: Record<string, ObservedTxReceipt> = {},
  ) {
    super(corridor);
  }

  override async transfers(): Promise<ReceivedTransfer[]> {
    this.events.push("transfers");
    return this.payouts;
  }

  override async txReceipt(txHash: string): Promise<ObservedTxReceipt> {
    this.events.push(`txReceipt ${txHash}`);
    return this.nodeReceipts[txHash] ?? FINALIZED;
  }

  override async simulateTransfer(
    _account: RecipientAccount,
    _artifact: ContractArtifact,
    to: { toString(): string },
    amount: bigint,
  ): Promise<void> {
    this.events.push(`simulate ${to.toString()} ${amount}`);
    if (this.simulationError) throw this.simulationError;
  }
}

/** The Worker: issues `challenge` and accepts only an ack its own verifier accepts. */
class Worker implements ReceiptApi {
  readonly bodies: ReceiptSubmission[] = [];
  readonly refusals: EnrollmentApiError[] = [];
  lockHeldAtSubmit: boolean[] = [];

  constructor(
    private readonly events: string[],
    private readonly operations: OperationJournal,
    public challenge: ReceiptChallenge,
    private readonly settled = { txHash: hex("a7"), blockNumber: 4242 },
  ) {}

  async requestReceiptChallenge(intentId: string): Promise<ReceiptChallenge> {
    this.events.push(`challenge ${intentId}`);
    return this.challenge;
  }

  async submitReceipt(intentId: string, body: ReceiptSubmission): Promise<ReceiptResult> {
    this.events.push(`submit ${intentId}`);
    this.bodies.push(body);
    this.lockHeldAtSubmit.push(this.operations.unresolved()?.kind === "receipt");
    const refused = this.refusals.shift();
    if (refused) throw refused;
    const ack = body.acknowledgement as { message: unknown; signature: string };
    const verified = await workerVerifies(E, this.challenge, ack, this.settled);
    return { intent_id: intentId, status: "completed", receipt_digest: verified.digest };
  }
}

function setup(payouts: ReceivedTransfer[] = [payoutFor(E, TERMS)], enrolledAccount: Enrolled = E) {
  const events: string[] = [];
  const lines: string[] = [];
  const port = new PayoutNode(events, payouts);
  const operations = new OperationJournal(temp("operations"));
  const receipts = new ReceiptJournal(temp("receipts"));
  const worker = new Worker(events, operations, CHALLENGE);
  const ctx: Ctx = { corridor, port, log: (line) => lines.push(line) };
  const run = (request: Partial<ReceiptRequest> = {}) =>
    receipt(
      ctx,
      worker,
      enrolledAccount.account,
      ARTIFACT,
      { receipts, operations },
      {
        intentId: INTENT,
        tx: null,
        untagged: false,
        alreadySpent: false,
        bindingDigest: enrolledAccount.bindingDigest,
        dryRun: false,
        ...request,
      },
    );
  return { events, lines, port, operations, receipts, worker, run };
}

/** A completed spend in the fund-movement journal, mined in `txHash`. */
function completedSpend(operations: OperationJournal, txHash: string): void {
  const spend = operations.begin("spend", { amount: AMOUNT.toString() });
  operations.update(spend.id, { status: "broadcast", txHash });
  operations.update(spend.id, { status: "complete", txHash });
}

describe("receipt command", () => {
  it("syncs before the challenge, then signs the tagged payout found finalized and spendable", async () => {
    const { events, operations, receipts, worker, run } = await setup();
    const record = await run();
    expect(events).toEqual([
      "transfers",
      `challenge ${INTENT}`,
      `txReceipt ${hex("a7")}`,
      `simulate ${E.account.address.toString()} ${AMOUNT}`,
      `submit ${INTENT}`,
    ]);
    expect(record).toMatchObject({
      intentId: INTENT,
      status: "submitted",
      termsDigest: CHALLENGE.receipt.terms_digest,
      operationId: CHALLENGE.receipt.operation_id,
      txHash: hex("a7"),
      blockNumber: "4242",
      untagged: false,
      alreadySpentBy: null,
    });
    expect(receipts.read(INTENT)).toEqual(record);
    expect(worker.lockHeldAtSubmit).toEqual([true]);
    expect(operations.unresolved()).toBeNull();
  });

  it("refuses while a spend, exit or refund is unresolved, before any call", async () => {
    const { events, operations, run } = await setup();
    operations.begin("spend", { amount: "1" });
    await expect(run()).rejects.toThrow(/spend/);
    expect(events).toEqual([]);
  });

  it("stops before requesting a challenge when no corridor payout was discovered", async () => {
    const { events, run } = await setup([
      payoutFor(E, TERMS, { from: E.account.descriptor.aztecAddress }),
    ]);
    await expect(run()).rejects.toThrow(/no payout from the corridor's sender/);
    expect(events).toEqual(["transfers"]);
  });

  it("refuses to sign a payout its node has not finalized, reverted, or in another block", async () => {
    for (const node of [
      { ...FINALIZED, status: TxStatus.PROVEN },
      { ...FINALIZED, executionSucceeded: false },
      { ...FINALIZED, blockNumber: 4243 },
    ]) {
      const { port, receipts, worker, run } = await setup();
      port.nodeReceipts[hex("a7")] = node;
      await expect(run()).rejects.toThrow(/not finalized|reverted|block 4243/);
      expect(worker.bodies).toEqual([]);
      expect(receipts.read(INTENT)).toBeNull();
    }
  });

  it("reports a failed spend simulation with its cause and signs nothing", async () => {
    const { port, receipts, worker, run } = await setup();
    port.simulationError = new Error("TEST ONLY note missing");
    await expect(run()).rejects.toThrow(/simulation failed: TEST ONLY note missing/);
    expect(worker.bodies).toEqual([]);
    expect(receipts.read(INTENT)).toBeNull();
  });

  it("with --already-spent, signs a payout this account spent after it landed, and records the spend", async () => {
    const { port, operations, receipts, run } = await setup();
    port.simulationError = new Error("TEST ONLY balance too low");
    completedSpend(operations, hex("5e"));
    port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: 5000 };
    await expect(run()).rejects.toThrow(/--already-spent/);
    expect(receipts.read(INTENT)).toBeNull();
    const record = await run({ alreadySpent: true });
    expect(record).toMatchObject({ status: "submitted", alreadySpentBy: hex("5e") });
  });

  it("refuses --already-spent without a spend or exit mined after the payout", async () => {
    const { port, operations, run } = await setup();
    port.simulationError = new Error("TEST ONLY balance too low");
    completedSpend(operations, hex("5e"));
    port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: 4000 };
    await expect(run({ alreadySpent: true })).rejects.toThrow(/no completed spend or exit/);
  });

  it("acknowledges an untagged payout only as --tx HASH --untagged, and says so", async () => {
    const { lines, run } = await setup([payoutFor(E, TERMS, { meta: UNTAGGED_META })]);
    await expect(run()).rejects.toThrow(/--untagged/);
    const record = await run({ tx: hex("a7"), untagged: true });
    expect(record).toMatchObject({ status: "submitted", untagged: true });
    expect(lines.some((line) => /WARNING: payout .* carries no order fingerprint/.test(line))).toBe(
      true,
    );
  });

  it("answers an accepted receipt from the journal without any call", async () => {
    const { events, run } = await setup();
    const first = await run();
    events.length = 0;
    expect(await run()).toEqual(first);
    expect(events).toEqual([]);
  });

  it("resends the exact recorded request until Xochi accepts it or rejects it outright", async () => {
    const { events, receipts, worker, run } = await setup();
    worker.refusals.push(refusal(503), refusal(409, "payout_not_final"), refusal(429));
    await expect(run()).rejects.toThrow(/503/);
    for (const status of [/409/, /429/]) {
      events.length = 0;
      await expect(run()).rejects.toThrow(status);
      expect(events).toEqual([`submit ${INTENT}`]);
    }
    expect(new Set(worker.bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(receipts.read(INTENT)!.attempts).toHaveLength(1);

    worker.refusals.push(refusal(410, "receipt_challenge_expired"));
    events.length = 0;
    expect(await run()).toMatchObject({ status: "submitted", txHash: hex("a7") });
    expect(events).toEqual([
      `submit ${INTENT}`,
      "transfers",
      `challenge ${INTENT}`,
      `txReceipt ${hex("a7")}`,
      `simulate ${E.account.address.toString()} ${AMOUNT}`,
      `submit ${INTENT}`,
    ]);
    expect(receipts.read(INTENT)!.attempts).toHaveLength(2);
  });

  it("never starts over with other terms or another payout for the same intent", async () => {
    const { port, worker, run } = await setup([
      payoutFor(E, TERMS),
      payoutFor(E, TERMS, { txHash: hex("b2") }),
    ]);
    await expect(run()).rejects.toThrow(/--tx/);
    worker.refusals.push(refusal(503));
    await expect(run({ tx: hex("a7") })).rejects.toThrow(/503/);
    await expect(run({ tx: hex("b2") })).rejects.toThrow(/--tx .* recorded payout/);

    worker.refusals.push(refusal(409, "receipt_ack_rejected"));
    const moved = termsFor(E, INTENT, (m) => (m.settlementServiceDeadline = "1900007200"));
    worker.challenge = challengeFor(E, moved);
    port.payouts = [payoutFor(E, moved)];
    await expect(run()).rejects.toThrow(/differ from the recorded/);
  });

  it("refuses terms whose operation another intent's receipt already holds", async () => {
    const { receipts, operations, run } = await setup();
    await run();
    const other = "another-intent";
    const reused = termsFor(E, other, (m) => (m.operationId = TERMS.message.operationId));
    const second = setup([payoutFor(E, reused, { txHash: hex("b2") })]);
    second.worker.challenge = challengeFor(E, reused);
    await expect(
      receipt(
        { corridor, port: second.port, log: () => {} },
        second.worker,
        E.account,
        ARTIFACT,
        { receipts, operations },
        {
          intentId: other,
          tx: null,
          untagged: false,
          alreadySpent: false,
          bindingDigest: E.bindingDigest,
          dryRun: false,
        },
      ),
    ).rejects.toThrow(new RegExp(`intent ${INTENT}`));
  });

  it("dry run: walks the PXE read and stops before any challenge, writing nothing", async () => {
    const port = new DryRunAztec(corridor);
    const api = new DryRunEnrollmentApi(Math.floor(Date.now() / 1000));
    const receipts = new ReceiptJournal(temp("receipts"));
    const operations = new OperationJournal(temp("operations"));
    await expect(
      receipt(
        { corridor, port, log: () => {} },
        api,
        E.account,
        ARTIFACT,
        { receipts, operations },
        {
          intentId: INTENT,
          tx: null,
          untagged: false,
          alreadySpent: false,
          bindingDigest: E.bindingDigest,
          dryRun: true,
        },
      ),
    ).rejects.toThrow(/no payout from the corridor's sender/);
    expect(api.calls).toEqual([]);
    expect(port.calls).toHaveLength(1);
    expect(existsSync(receipts.directory)).toBe(false);
    expect(operations.records()).toEqual([]);
  });
});
