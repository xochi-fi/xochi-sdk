// `xochi-recipient receipt`: the recipient's own PaymentReceiptAck for a shielded payout it
// discovered, found finalized on its node and could spend. Every ack is checked through the
// Worker's verifier (`verifyRecipientAck`) with the expected values the Worker pins.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  AZTEC_RECIPIENT_PROFILES,
  RECIPIENT_ACK_PURPOSES,
  recipientBindingDigest,
  verifyRecipientAck,
  type PaymentReceiptAck,
  type RecipientBinding,
} from "@xochi/signer";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TxStatus } from "@aztec-labs/stdlib/tx";

import {
  deriveRecipientAccount,
  signRecipientDigest,
  type RecipientAccount,
} from "../src/account.js";
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
import { receipt, type Ctx } from "../src/commands.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { buildBinding } from "../src/enrollment.js";
import {
  ReceiptJournal,
  assertReceiptSubject,
  selectReceiptTransfer,
  signPaymentReceipt,
} from "../src/receipt.js";
import { TEST_SECRETS, TEST_SOURCE_KEY } from "./fixtures.js";

const INTENT = "3f0c2a5e-8d7b-4e1a-9c6f-0b1d2e3f4a5b";
const hex = (byte: string) => `0x${byte.repeat(32)}`;

function challengeBody(overrides: Record<string, unknown> = {}) {
  return {
    challenge_id: "TEST-ONLY-receipt-challenge",
    nonce: hex("0f"),
    expires_at: 1_900_000_000,
    receipt: {
      binding_id: "TEST-ONLY-binding",
      binding_digest: hex("b1"),
      terms_digest: hex("7e"),
      operation_id: hex("0d"),
      network: {
        aztecChainId: "1",
        protocolVersion: "2070860440",
        rollupAddress: `0x${"e3".repeat(20)}`,
        l1ChainId: "1",
        genesisOrNetworkDigest: hex("9a"),
      },
      aztec_token: hex("11"),
      aztec_recipient: hex("22"),
      amount: "1000000000000000000",
    },
    ...overrides,
  };
}

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

describe("receipt API", () => {
  it("requests the receipt challenge for the intent with the source-wallet bearer", async () => {
    const seen: Seen[] = [];
    const api = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(201, challengeBody(), seen),
    );
    const challenge = await api.requestReceiptChallenge(INTENT);
    expect(challenge).toEqual(challengeBody());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      `https://api.xochi.fi/api/shielded/operations/${INTENT}/receipt/challenge`,
    );
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.body).toBe("{}");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer TEST ONLY jwt" });
  });

  it("refuses a challenge with an unknown member or a non-decimal amount", async () => {
    const extra = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(201, challengeBody({ binding: {} }), []),
    );
    await expect(extra.requestReceiptChallenge(INTENT)).rejects.toThrow();
    const numeric = challengeBody();
    (numeric.receipt as Record<string, unknown>)["amount"] = 1e18;
    const amount = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(201, numeric, []),
    );
    await expect(amount.requestReceiptChallenge(INTENT)).rejects.toThrow();
  });

  it("never puts a path-shaped intent id into the route", async () => {
    const seen: Seen[] = [];
    const api = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(201, challengeBody(), seen),
    );
    await expect(api.requestReceiptChallenge("../recipients")).rejects.toThrow(/intent id/);
    expect(seen).toEqual([]);
  });

  it("submits the acknowledgement and parses the completed answer", async () => {
    const seen: Seen[] = [];
    const answer = { intent_id: INTENT, status: "completed", receipt_digest: hex("dd") };
    const api = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(200, answer, seen),
    );
    const body = {
      challenge_id: "TEST-ONLY-receipt-challenge",
      acknowledgement: {
        primary_type: "PaymentReceiptAck" as const,
        message: { purpose: "TEST ONLY" },
        signature: `0x${"aa".repeat(64)}`,
      },
    };
    expect(await api.submitReceipt(INTENT, body)).toEqual(answer);
    expect(seen[0]!.url).toBe(`https://api.xochi.fi/api/shielded/operations/${INTENT}/receipt`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(body);
  });

  it("surfaces a refusal with its status", async () => {
    const api = new HttpEnrollmentApi(
      "https://api.xochi.fi",
      "TEST ONLY jwt",
      fetchAnswering(409, { error: "payout not final" }, []),
    );
    await expect(api.requestReceiptChallenge(INTENT)).rejects.toMatchObject({ status: 409 });
  });
});

const corridor = OXDAI_MAINNET_REV2;
const ENROLLMENT_CHALLENGE = {
  challenge_id: "TEST-ONLY-challenge",
  nonce: hex("0e"),
  expires_at: 1_899_999_000,
};
const NOW = 1_899_999_900;
const AMOUNT = 25n * 10n ** 18n;

function payout(overrides: Partial<ReceivedTransfer> = {}): ReceivedTransfer {
  return {
    from: corridor.registeredSenders[0]!,
    to: "",
    amount: AMOUNT,
    meta: [],
    txHash: hex("a7"),
    blockNumber: 4242,
    ...overrides,
  };
}

/** The enrolled binding and a receipt challenge for it, as the Worker would issue them. */
async function enrolled() {
  const account = await deriveRecipientAccount(TEST_SECRETS, corridor);
  const source = privateKeyToAccount(TEST_SOURCE_KEY);
  const binding = buildBinding(corridor, account, source.address, ENROLLMENT_CHALLENGE);
  const challenge: ReceiptChallenge = {
    challenge_id: "TEST-ONLY-receipt-challenge",
    nonce: hex("0f"),
    expires_at: 1_900_000_000,
    receipt: {
      binding_id: "TEST-ONLY-binding",
      binding_digest: recipientBindingDigest(binding, corridor.environment, corridor.network),
      terms_digest: hex("7e"),
      operation_id: hex("0d"),
      network: { ...corridor.network },
      aztec_token: corridor.token.address,
      aztec_recipient: account.descriptor.aztecAddress,
      amount: AMOUNT.toString(),
    },
  };
  return { account, binding, challenge };
}

/** The Worker's check: `verifyRecipientAck` with the values it pins from D1 and the node. */
async function workerVerifies(
  binding: RecipientBinding,
  account: RecipientAccount,
  challenge: ReceiptChallenge,
  ack: { message: unknown; signature: string },
  settled: { txHash: string; blockNumber: number },
) {
  return verifyRecipientAck("PaymentReceiptAck", ack.message as PaymentReceiptAck, ack.signature, {
    binding,
    descriptor: account.descriptor,
    profile: AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"],
    environment: corridor.environment,
    network: corridor.network,
    expected: {
      nonce: challenge.nonce,
      termsDigest: challenge.receipt.terms_digest,
      operationId: challenge.receipt.operation_id,
      txHash: settled.txHash,
      blockNumber: settled.blockNumber,
      amount: challenge.receipt.amount,
    },
    now: NOW,
    consumeReplayKey: async () => true,
  });
}

describe("PaymentReceiptAck", () => {
  it("signs the discovered payout so the Worker's verifier accepts it", async () => {
    const { account, binding, challenge } = await enrolled();
    const { submission, digest } = await signPaymentReceipt({
      corridor,
      account,
      challenge,
      transfer: payout(),
      sign: signRecipientDigest,
    });
    expect(submission.challenge_id).toBe(challenge.challenge_id);
    expect(submission.acknowledgement.primary_type).toBe("PaymentReceiptAck");
    expect(submission.acknowledgement.message).toEqual({
      bindingDigest: challenge.receipt.binding_digest,
      termsDigest: challenge.receipt.terms_digest,
      operationId: challenge.receipt.operation_id,
      network: corridor.network,
      txHash: hex("a7"),
      blockNumber: "4242",
      aztecToken: corridor.token.address,
      amount: AMOUNT.toString(),
      aztecRecipient: account.descriptor.aztecAddress,
      nonce: challenge.nonce,
      challengeExpiry: "1900000000",
      purpose: RECIPIENT_ACK_PURPOSES.PaymentReceiptAck,
    });
    const verified = await workerVerifies(binding, account, challenge, submission.acknowledgement, {
      txHash: hex("a7"),
      blockNumber: 4242,
    });
    expect(verified.digest).toBe(digest);
    expect(verified.nonce).toBe(challenge.nonce);
  });

  it("is refused by the Worker for any other settlement transaction or block", async () => {
    const { account, binding, challenge } = await enrolled();
    const { submission } = await signPaymentReceipt({
      corridor,
      account,
      challenge,
      transfer: payout(),
      sign: signRecipientDigest,
    });
    await expect(
      workerVerifies(binding, account, challenge, submission.acknowledgement, {
        txHash: hex("a8"),
        blockNumber: 4242,
      }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });
    await expect(
      workerVerifies(binding, account, challenge, submission.acknowledgement, {
        txHash: hex("a7"),
        blockNumber: 4243,
      }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });
  });

  it("refuses to sign a payout whose amount is not the challenge's", async () => {
    const { account, challenge } = await enrolled();
    await expect(
      signPaymentReceipt({
        corridor,
        account,
        challenge,
        transfer: payout({ amount: AMOUNT - 1n }),
        sign: signRecipientDigest,
      }),
    ).rejects.toThrow(/amount/);
  });
});

describe("receipt subject", () => {
  it("accepts the challenge for this account, token, network and binding", async () => {
    const { account, challenge } = await enrolled();
    expect(() =>
      assertReceiptSubject(corridor, account, challenge.receipt, "TEST-ONLY-binding"),
    ).not.toThrow();
    expect(() => assertReceiptSubject(corridor, account, challenge.receipt, null)).not.toThrow();
  });

  it("refuses a challenge for another recipient, token, network or binding", async () => {
    const { account, challenge } = await enrolled();
    const subject = challenge.receipt;
    expect(() =>
      assertReceiptSubject(corridor, account, { ...subject, aztec_recipient: hex("22") }, null),
    ).toThrow(/recipient/);
    expect(() =>
      assertReceiptSubject(corridor, account, { ...subject, aztec_token: hex("11") }, null),
    ).toThrow(/token/);
    expect(() =>
      assertReceiptSubject(
        corridor,
        account,
        { ...subject, network: { ...subject.network, protocolVersion: "1" } },
        null,
      ),
    ).toThrow(/network/);
    expect(() => assertReceiptSubject(corridor, account, subject, "another-binding")).toThrow(
      /binding/,
    );
    expect(() =>
      assertReceiptSubject(corridor, account, { ...subject, amount: "0" }, null),
    ).toThrow(/amount/);
  });
});

describe("payout selection", () => {
  const none = new Set<string>();

  it("picks the one discovered payout of exactly the challenge amount", () => {
    const chosen = selectReceiptTransfer(
      [
        payout({ amount: AMOUNT - 1n, txHash: hex("a1") }),
        payout(),
        payout({ amount: AMOUNT + 1n }),
      ],
      AMOUNT,
      none,
      null,
    );
    expect(chosen.txHash).toBe(hex("a7"));
  });

  it("refuses when no payout of the amount was discovered", () => {
    expect(() =>
      selectReceiptTransfer([payout({ amount: AMOUNT - 1n })], AMOUNT, none, null),
    ).toThrow(/no discovered payout of 25000000000000000000/);
  });

  it("requires --tx when more than one unused payout matches, and honours it", () => {
    const two = [payout(), payout({ txHash: hex("b2"), blockNumber: 4300 })];
    expect(() => selectReceiptTransfer(two, AMOUNT, none, null)).toThrow(
      new RegExp(`2 discovered payouts.*${hex("a7")}.*${hex("b2")}.*--tx`),
    );
    expect(selectReceiptTransfer(two, AMOUNT, none, `0x${"B2".repeat(32)}`)).toMatchObject({
      txHash: hex("b2"),
      blockNumber: 4300,
    });
  });

  it("skips a payout already journaled as another intent's receipt", () => {
    const two = [payout(), payout({ txHash: hex("b2") })];
    expect(selectReceiptTransfer(two, AMOUNT, new Set([hex("a7")]), null).txHash).toBe(hex("b2"));
    expect(() => selectReceiptTransfer(two, AMOUNT, new Set([hex("a7")]), hex("a7"))).toThrow(
      /already receipted for another intent/,
    );
    expect(() => selectReceiptTransfer([payout()], AMOUNT, new Set([hex("a7")]), null)).toThrow(
      /no discovered payout/,
    );
  });

  it("refuses a --tx that is not a discovered payout of the amount", () => {
    expect(() => selectReceiptTransfer([payout()], AMOUNT, none, hex("c3"))).toThrow(
      /no discovered payout in/,
    );
    expect(() => selectReceiptTransfer([payout({ amount: 5n })], AMOUNT, none, hex("a7"))).toThrow(
      /carries 5, not 25000000000000000000/,
    );
    expect(() => selectReceiptTransfer([payout()], AMOUNT, none, "0x1234")).toThrow(/--tx/);
  });
});

describe("receipt journal", () => {
  async function signed() {
    const { account, challenge } = await enrolled();
    return signPaymentReceipt({
      corridor,
      account,
      challenge,
      transfer: payout(),
      sign: signRecipientDigest,
    });
  }
  const fresh = () => new ReceiptJournal(join(mkdtempSync(join(tmpdir(), "receipts-")), "r"));

  it("records the receipt privately, then its acceptance, with no secret in it", async () => {
    const journal = fresh();
    expect(journal.read(INTENT)).toBeNull();
    const { submission } = await signed();
    journal.begin({
      intentId: INTENT,
      txHash: hex("a7"),
      blockNumber: "4242",
      amount: AMOUNT.toString(),
      request: submission,
    });
    expect(journal.read(INTENT)).toMatchObject({ status: "submitting", txHash: hex("a7") });
    journal.complete(INTENT, hex("dd"), "2026-11-08T00:00:00.000Z");
    const file = join(journal.directory, `${INTENT}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(journal.directory).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "amount",
      "blockNumber",
      "intentId",
      "receipt_digest",
      "request",
      "status",
      "submitted_at",
      "txHash",
    ]);
    expect(stored).toMatchObject({
      intentId: INTENT,
      status: "submitted",
      receipt_digest: hex("dd"),
      submitted_at: "2026-11-08T00:00:00.000Z",
    });
    const text = readFileSync(file, "utf8");
    for (const secret of [TEST_SECRETS.secret, TEST_SECRETS.salt]) {
      expect(text).not.toContain(secret.slice(2));
    }
  });

  it("names every other intent's receipted transaction", async () => {
    const journal = fresh();
    const { submission } = await signed();
    const base = {
      blockNumber: "1",
      amount: "1",
      request: submission,
    };
    journal.begin({ ...base, intentId: "intent-a", txHash: hex("a1") });
    journal.begin({ ...base, intentId: "intent-b", txHash: hex("b2") });
    journal.complete("intent-b", hex("dd"), "2026-11-08T00:00:00.000Z");
    expect([...journal.receiptedTxHashes("intent-a")]).toEqual([hex("b2")]);
    expect([...journal.receiptedTxHashes("intent-c")].sort()).toEqual([hex("a1"), hex("b2")]);
    expect(() => journal.begin({ ...base, intentId: "intent-a", txHash: hex("a1") })).toThrow(
      /already/,
    );
    // A refused retry starts over: the unaccepted record is replaced, an accepted one never.
    journal.begin({ ...base, intentId: "intent-a", txHash: hex("a3") }, { replace: true });
    expect(journal.read("intent-a")).toMatchObject({ status: "submitting", txHash: hex("a3") });
    expect(() =>
      journal.begin({ ...base, intentId: "intent-b", txHash: hex("b2") }, { replace: true }),
    ).toThrow(/already accepted/);
  });

  it("lets one receipt run at a time and recovers a dead run's lock", () => {
    const journal = fresh();
    const release = journal.lock();
    expect(() => journal.lock()).toThrow(/another receipt run/);
    release();
    journal.lock()();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(journal.directory, "active.lock"), JSON.stringify({ pid: dead }));
    const recovered = journal.lock();
    recovered();
    expect(existsSync(join(journal.directory, "active.lock"))).toBe(false);
  });
});

/** The recipient's own node and PXE: discovered payouts, the node's receipt, and spendability. */
class PayoutNode extends DryRunAztec {
  constructor(
    private readonly payouts: ReceivedTransfer[],
    private readonly nodeReceipt: ObservedTxReceipt,
    private readonly spendable = true,
  ) {
    super(corridor);
  }

  override async transfers(): Promise<ReceivedTransfer[]> {
    this.calls.push("transfers");
    return this.payouts;
  }

  override async txReceipt(txHash: string): Promise<ObservedTxReceipt> {
    this.calls.push(`txReceipt(${txHash})`);
    return this.nodeReceipt;
  }

  override async simulateTransfer(
    _account: RecipientAccount,
    _artifact: ContractArtifact,
    to: { toString(): string },
    amount: bigint,
  ): Promise<void> {
    this.calls.push(`simulateTransfer(${to.toString()}, ${amount})`);
    if (!this.spendable) throw new Error("wallet simulation failed");
  }
}

const FINALIZED: ObservedTxReceipt = {
  status: TxStatus.FINALIZED,
  blockNumber: 4242,
  executionSucceeded: true,
};
const ARTIFACT = { name: "OxideToken" } as ContractArtifact;

/** The Worker: issues `challenge` and accepts only an ack its own verifier accepts. */
class Worker implements ReceiptApi {
  readonly calls: string[] = [];
  readonly bodies: ReceiptSubmission[] = [];
  refuseNext: EnrollmentApiError | null = null;

  constructor(
    private readonly binding: RecipientBinding,
    private readonly account: RecipientAccount,
    private readonly challenge: ReceiptChallenge,
    private readonly settled: { txHash: string; blockNumber: number },
  ) {}

  async requestReceiptChallenge(intentId: string): Promise<ReceiptChallenge> {
    this.calls.push(`challenge ${intentId}`);
    return this.challenge;
  }

  async submitReceipt(intentId: string, body: ReceiptSubmission): Promise<ReceiptResult> {
    this.calls.push(`submit ${intentId}`);
    this.bodies.push(body);
    const refusal = this.refuseNext;
    this.refuseNext = null;
    if (refusal) throw refusal;
    const verified = await workerVerifies(
      this.binding,
      this.account,
      this.challenge,
      body.acknowledgement as { message: unknown; signature: string },
      this.settled,
    );
    return { intent_id: intentId, status: "completed", receipt_digest: verified.digest };
  }
}

describe("receipt command", () => {
  async function setup(
    options: {
      payouts?: ReceivedTransfer[];
      node?: ObservedTxReceipt;
      spendable?: boolean;
      expiresAt?: number;
    } = {},
  ) {
    const { account, binding, challenge } = await enrolled();
    const issued = { ...challenge, expires_at: options.expiresAt ?? challenge.expires_at };
    const port = new PayoutNode(
      options.payouts ?? [payout()],
      options.node ?? FINALIZED,
      options.spendable,
    );
    const lines: string[] = [];
    const ctx: Ctx = { corridor, port, log: (line) => lines.push(line) };
    const worker = new Worker(binding, account, issued, { txHash: hex("a7"), blockNumber: 4242 });
    const journal = new ReceiptJournal(join(mkdtempSync(join(tmpdir(), "receipts-")), "r"));
    const run = (tx: string | null = null) =>
      receipt(ctx, worker, account, ARTIFACT, journal, {
        intentId: INTENT,
        tx,
        knownBindingId: "TEST-ONLY-binding",
        dryRun: false,
      });
    return { account, port, worker, journal, lines, run };
  }

  it("signs the payout it found finalized and spendable, and journals the Worker's answer", async () => {
    const { account, port, worker, journal, run } = await setup();
    const record = await run();
    expect(worker.calls).toEqual([`challenge ${INTENT}`, `submit ${INTENT}`]);
    expect(port.calls).toEqual([
      "transfers",
      `txReceipt(${hex("a7")})`,
      `simulateTransfer(${account.address.toString()}, ${AMOUNT})`,
    ]);
    expect(record).toMatchObject({
      intentId: INTENT,
      status: "submitted",
      txHash: hex("a7"),
      blockNumber: "4242",
      amount: AMOUNT.toString(),
    });
    expect(journal.read(INTENT)).toEqual(record);
    expect(existsSync(join(journal.directory, "active.lock"))).toBe(false);
  });

  it("refuses to sign a payout its node has not finalized, reverted, or in another block", async () => {
    for (const node of [
      { ...FINALIZED, status: TxStatus.PROVEN },
      { ...FINALIZED, executionSucceeded: false },
      { ...FINALIZED, blockNumber: 4243 },
    ]) {
      const { worker, journal, run } = await setup({ node });
      await expect(run()).rejects.toThrow(/not finalized|reverted|block 4243/);
      expect(worker.bodies).toEqual([]);
      expect(journal.read(INTENT)).toBeNull();
    }
  });

  it("refuses to sign when this PXE cannot spend the amount", async () => {
    const { worker, journal, run } = await setup({ spendable: false });
    await expect(run()).rejects.toThrow(/cannot spend/);
    expect(worker.bodies).toEqual([]);
    expect(journal.read(INTENT)).toBeNull();
  });

  it("refuses to sign once the challenge has expired", async () => {
    const { worker, port, run } = await setup({ expiresAt: 1 });
    await expect(run()).rejects.toThrow(/expired/);
    expect(worker.bodies).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("passes over a payout another intent's receipt names", async () => {
    const { journal, worker, run } = await setup({
      payouts: [payout({ txHash: hex("b2") }), payout()],
    });
    const other = await signPaymentReceipt({
      corridor,
      account: await deriveRecipientAccount(TEST_SECRETS, corridor),
      challenge: (await enrolled()).challenge,
      transfer: payout({ txHash: hex("b2") }),
      sign: signRecipientDigest,
    });
    journal.begin({
      intentId: "another-intent",
      txHash: hex("b2"),
      blockNumber: "4242",
      amount: AMOUNT.toString(),
      request: other.submission,
    });
    expect(await run()).toMatchObject({ txHash: hex("a7") });
    expect(worker.calls).toEqual([`challenge ${INTENT}`, `submit ${INTENT}`]);
  });

  it("answers an accepted receipt from the journal without any call", async () => {
    const { port, worker, run } = await setup();
    const first = await run();
    worker.calls.length = 0;
    port.calls.length = 0;
    expect(await run()).toEqual(first);
    expect(worker.calls).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("resends the exact recorded body after a lost answer, and starts over if it is refused", async () => {
    const { worker, journal, run } = await setup();
    worker.refuseNext = new EnrollmentApiError(503, "unavailable", "POST receipt");
    await expect(run()).rejects.toThrow(/503/);
    expect(journal.read(INTENT)).toMatchObject({ status: "submitting" });

    worker.calls.length = 0;
    expect(await run()).toMatchObject({ status: "submitted" });
    expect(worker.calls).toEqual([`submit ${INTENT}`]);
    expect(worker.bodies[1]).toEqual(worker.bodies[0]);

    const again = await setup();
    again.worker.refuseNext = new EnrollmentApiError(503, "unavailable", "POST receipt");
    await expect(again.run()).rejects.toThrow(/503/);
    again.worker.refuseNext = new EnrollmentApiError(409, "challenge expired", "POST receipt");
    again.worker.calls.length = 0;
    expect(await again.run()).toMatchObject({ status: "submitted" });
    expect(again.worker.calls).toEqual([
      `submit ${INTENT}`,
      `challenge ${INTENT}`,
      `submit ${INTENT}`,
    ]);
  });

  it("dry run: walks the challenge and the PXE read, writes nothing, stops at no payout", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, corridor);
    const port = new DryRunAztec(corridor);
    const api = new DryRunEnrollmentApi(Math.floor(Date.now() / 1000), null, {
      binding_id: "dry-run-binding",
      aztec_recipient: account.descriptor.aztecAddress,
      aztec_token: corridor.token.address,
      network: corridor.network,
    });
    const journal = new ReceiptJournal(join(mkdtempSync(join(tmpdir(), "receipts-")), "r"));
    await expect(
      receipt({ corridor, port, log: () => {} }, api, account, ARTIFACT, journal, {
        intentId: INTENT,
        tx: null,
        knownBindingId: null,
        dryRun: true,
      }),
    ).rejects.toThrow(/no discovered payout of 1 base units/);
    expect(api.calls).toEqual([
      `POST /api/shielded/operations/${INTENT}/receipt/challenge {} (synthetic challenge for 1 base unit)`,
    ]);
    expect(port.calls).toEqual([
      `wallet.getPrivateEvents(OxideToken::Transfer, { contractAddress: ${corridor.token.address}, scopes: [${account.address.toString()}] }) (synthetic: none)`,
    ]);
    expect(existsSync(journal.directory)).toBe(false);
  });
});
