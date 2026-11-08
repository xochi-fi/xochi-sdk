// `xochi-recipient receipt`: the recipient's own PaymentReceiptAck for a shielded payout it
// discovered, found finalized on its node and could spend. Every ack is checked through the
// Worker's verifier (`verifyRecipientAck`) with the expected values the Worker pins.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TxStatus } from "@aztec-labs/stdlib/tx";

import type { RecipientAccount } from "../src/core/account.js";
import {
  DryRunEnrollmentApi,
  EnrollmentApiError,
  HttpEnrollmentApi,
  type ReceiptApi,
  type ReceiptChallenge,
  type ReceiptResult,
  type ReceiptSubmission,
} from "../src/core/api.js";
import { DryRunAztec, type ObservedTxReceipt, type ReceivedTransfer } from "../src/core/chain.js";
import { receipt, type Ctx, type ReceiptRequest } from "../src/core/commands.js";
import type { OperationJournal } from "../src/core/operation-journal.js";
import { openNodeJournals, systemClock } from "../src/node/data-dir.js";
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
    expect(refusal(400, "receipt_challenge_unknown").rejectsReceipt).toBe(true);
    for (const kept of [
      refusal(409, "payout_not_final"),
      refusal(409, "receipt_tx_conflict"),
      refusal(409),
      refusal(400),
      refusal(409, "receipt_challenge_unknown"),
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
  blockHash: hex("b1"),
  executionSucceeded: true,
};
const ARTIFACT = { name: "OxideToken" } as ContractArtifact;

/** The recipient's own node and PXE: discovered payouts, node receipts and spendability. */
class PayoutNode extends DryRunAztec {
  simulationError: Error | null = null;
  /** The PXE's balance after sync; 0 unless a test sets it. */
  balanceValue = 0n;
  balanceError: Error | null = null;

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

  override async balance(): Promise<bigint> {
    if (this.balanceError) throw this.balanceError;
    return this.balanceValue;
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
    this.lockHeldAtSubmit.push((await this.operations.unresolved())?.kind === "receipt");
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
  const { operations, receipts } = openNodeJournals(temp("data"));
  const worker = new Worker(events, operations, CHALLENGE);
  const ctx: Ctx = { corridor, port, log: (line) => lines.push(line), clock: systemClock };
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
        alreadySpent: false,
        bindingDigest: enrolledAccount.bindingDigest,
        bindingId: "TEST-ONLY-binding",
        legacyBinding: false,
        rememberBindingDigest: () => {
          throw new Error("TEST ONLY: no binding to remember");
        },
        dryRun: false,
        ...request,
      },
    );
  return { events, lines, port, operations, receipts, worker, run };
}

/** A completed spend of `amount` in the fund-movement journal, mined in `txHash`. */
async function completedSpend(
  operations: OperationJournal,
  txHash: string,
  amount = AMOUNT,
): Promise<void> {
  const spend = await operations.begin("spend", { amount: amount.toString() });
  await operations.update(spend.id, { status: "broadcast", txHash });
  await operations.update(spend.id, { status: "complete", txHash });
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
      alreadySpentBy: [],
      bindingId: "TEST-ONLY-binding",
    });
    expect(await receipts.read(INTENT)).toEqual(record);
    expect(worker.lockHeldAtSubmit).toEqual([true]);
    expect(await operations.unresolved()).toBeNull();
  });

  it("refuses while a spend, exit or refund is unresolved, before any call", async () => {
    const { events, operations, run } = await setup();
    await operations.begin("spend", { amount: "1" });
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
      expect(await receipts.read(INTENT)).toBeNull();
    }
  });

  it("reports a failed spend simulation with its cause and signs nothing", async () => {
    const { port, receipts, worker, run } = await setup();
    port.simulationError = new Error("TEST ONLY note missing");
    await expect(run()).rejects.toThrow(/simulation failed: TEST ONLY note missing/);
    expect(worker.bodies).toEqual([]);
    expect(await receipts.read(INTENT)).toBeNull();
  });

  it("reports the simulation cause first when reading the balance then fails too", async () => {
    const { port, run } = await setup();
    port.simulationError = new Error("TEST ONLY note missing");
    port.balanceError = new Error("TEST ONLY node down");
    await expect(run({ alreadySpent: true })).rejects.toThrow(
      "simulation failed: TEST ONLY note missing; reading the balance then failed too: TEST ONLY node down; receipt not signed",
    );
  });

  it("with --already-spent, signs a payout this account spent after it landed, and records the spend", async () => {
    const { port, operations, receipts, run } = await setup();
    port.simulationError = new Error("TEST ONLY balance too low");
    await completedSpend(operations, hex("5e"));
    port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: 5000 };
    await expect(run()).rejects.toThrow(/--already-spent/);
    expect(await receipts.read(INTENT)).toBeNull();
    const record = await run({ alreadySpent: true });
    expect(record).toMatchObject({ status: "submitted", alreadySpentBy: [hex("5e")] });
  });

  it("with --already-spent, counts every spend and exit after the payout together with the balance", async () => {
    const { port, operations, run } = await setup();
    port.simulationError = new Error("TEST ONLY balance too low");
    port.balanceValue = AMOUNT / 5n;
    await completedSpend(operations, hex("51"), (AMOUNT * 2n) / 5n);
    await completedSpend(operations, hex("52"), (AMOUNT * 2n) / 5n);
    await completedSpend(operations, hex("50"), AMOUNT);
    port.nodeReceipts[hex("51")] = { ...FINALIZED, blockNumber: 5000 };
    port.nodeReceipts[hex("52")] = { ...FINALIZED, blockNumber: 5001 };
    port.nodeReceipts[hex("50")] = { ...FINALIZED, blockNumber: 4000 };
    await expect(run()).rejects.toThrow(/--already-spent/);
    expect(await run({ alreadySpent: true })).toMatchObject({
      status: "submitted",
      alreadySpentBy: [hex("51"), hex("52")],
    });
  });

  it("refuses --already-spent unless the balance and the spends after the payout cover it", async () => {
    for (const [block, amount] of [
      [4000, AMOUNT],
      [5000, AMOUNT - 1n],
    ] as const) {
      const { port, operations, run } = await setup();
      port.simulationError = new Error("TEST ONLY balance too low");
      await completedSpend(operations, hex("5e"), amount);
      port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: block };
      await expect(run()).rejects.toThrow(/simulation failed/);
      await expect(run()).rejects.not.toThrow(/--already-spent/);
      await expect(run({ alreadySpent: true })).rejects.toThrow(
        /do not cover the 25000000000000000000 base units/,
      );
    }
  });

  it("never offers --already-spent when the balance still covers the amount", async () => {
    const { port, operations, run } = await setup();
    port.simulationError = new Error("TEST ONLY node unreachable");
    port.balanceValue = AMOUNT;
    await completedSpend(operations, hex("5e"));
    port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: 5000 };
    await expect(run()).rejects.toThrow(/simulation failed: TEST ONLY node unreachable/);
    await expect(run()).rejects.not.toThrow(/--already-spent/);
    await expect(run({ alreadySpent: true })).rejects.toThrow(
      /balance still covers the amount: the simulation failed for another reason/,
    );
  });

  it("records --already-spent on a re-signed attempt too", async () => {
    const { port, operations, receipts, worker, run } = await setup();
    worker.refusals.push(refusal(503));
    await expect(run()).rejects.toThrow(/503/);
    expect(await receipts.read(INTENT)).toMatchObject({ alreadySpentBy: [] });
    port.simulationError = new Error("TEST ONLY balance too low");
    await completedSpend(operations, hex("5e"));
    port.nodeReceipts[hex("5e")] = { ...FINALIZED, blockNumber: 5000 };
    worker.refusals.push(refusal(409, "receipt_ack_rejected"));
    expect(await run({ alreadySpent: true })).toMatchObject({
      status: "submitted",
      alreadySpentBy: [hex("5e")],
    });
  });

  it("--legacy-binding: saves the recorded binding id and digest only once Xochi accepts", async () => {
    const remembered: [string, string][] = [];
    const { lines, receipts, worker, run } = await setup();
    const legacy = {
      bindingDigest: null,
      rememberBindingDigest: (digest: string, bindingId: string) => {
        remembered.push([digest, bindingId]);
      },
    };
    await expect(run(legacy)).rejects.toThrow(/--legacy-binding/);
    expect(await receipts.read(INTENT)).toBeNull();
    worker.refusals.push(refusal(503));
    await expect(run({ ...legacy, legacyBinding: true })).rejects.toThrow(/503/);
    expect(remembered).toEqual([]);
    expect(await receipts.read(INTENT)).toMatchObject({ bindingId: "TEST-ONLY-binding" });
    expect(lines).toContain(
      `receipt: --legacy-binding: signing under binding TEST-ONLY-binding, digest ${E.bindingDigest} (saved to state.json once Xochi accepts the receipt)`,
    );
    // A mistyped --binding-id on the resend is refused, not saved.
    await expect(
      run({ ...legacy, legacyBinding: true, bindingId: "TEST-ONLY-typo" }),
    ).rejects.toThrow(
      "binding id TEST-ONLY-typo is not the recorded receipt's binding id TEST-ONLY-binding",
    );
    const record = await run({ ...legacy, bindingId: null });
    expect(record).toMatchObject({ status: "submitted", legacyBinding: true });
    expect(remembered).toEqual([[E.bindingDigest, "TEST-ONLY-binding"]]);
  });

  it("never acknowledges an untagged payout", async () => {
    const { worker, run } = await setup([payoutFor(E, TERMS, { meta: UNTAGGED_META })]);
    await expect(run()).rejects.toThrow(/no payout of this intent/);
    await expect(run({ tx: hex("a7") })).rejects.toThrow(/not a payout of this intent/);
    expect(worker.bodies).toEqual([]);
  });

  it("signs again under a new challenge when Xochi purged the recorded one", async () => {
    const { events, receipts, worker, run } = await setup();
    worker.refusals.push(refusal(401));
    await expect(run()).rejects.toThrow(/401/);
    worker.refusals.push(refusal(400, "receipt_challenge_unknown"));
    events.length = 0;
    expect(await run()).toMatchObject({ status: "submitted", txHash: hex("a7") });
    expect(events.filter((e) => e.startsWith("challenge") || e.startsWith("submit"))).toEqual([
      `submit ${INTENT}`,
      `challenge ${INTENT}`,
      `submit ${INTENT}`,
    ]);
    expect((await receipts.read(INTENT))!.attempts).toHaveLength(2);
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
    expect((await receipts.read(INTENT))!.attempts).toHaveLength(1);

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
    expect((await receipts.read(INTENT))!.attempts).toHaveLength(2);
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
        { corridor, port: second.port, log: () => {}, clock: systemClock },
        second.worker,
        E.account,
        ARTIFACT,
        { receipts, operations },
        {
          intentId: other,
          tx: null,
          alreadySpent: false,
          bindingDigest: E.bindingDigest,
          bindingId: "TEST-ONLY-binding",
          legacyBinding: false,
          rememberBindingDigest: () => undefined,
          dryRun: false,
        },
      ),
    ).rejects.toThrow(new RegExp(`intent ${INTENT}`));
  });

  it("dry run: walks the PXE read and stops before any challenge, writing nothing", async () => {
    const port = new DryRunAztec(corridor);
    const api = new DryRunEnrollmentApi(Math.floor(Date.now() / 1000));
    const { receipts, operations } = openNodeJournals(temp("data"));
    await expect(
      receipt(
        { corridor, port, log: () => {}, clock: systemClock },
        api,
        E.account,
        ARTIFACT,
        { receipts, operations },
        {
          intentId: INTENT,
          tx: null,
          alreadySpent: false,
          bindingDigest: E.bindingDigest,
          bindingId: "TEST-ONLY-binding",
          legacyBinding: false,
          rememberBindingDigest: () => undefined,
          dryRun: true,
        },
      ),
    ).rejects.toThrow(/no payout from the corridor's sender/);
    expect(api.calls).toEqual([]);
    expect(port.calls).toHaveLength(1);
    expect(existsSync(dirname(receipts.path(INTENT)))).toBe(false);
    expect(await operations.records()).toEqual([]);
  });
});
