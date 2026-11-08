// The tool's steps, written once against `AztecPort`, `EnrollmentApi` and `ReceiptApi`, so a dry
// run walks the exact sequence a live run makes. Order follows the round-trip-critical path
// (xochi#759): network, account, senders, token, balance, enrollment; then backup, spend and
// exit; `receipt` once a shielded payout has landed.

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { TxStatus } from "@aztec-labs/stdlib/tx";
import { hashRecipientDescriptor } from "@xochi/signer";

import { signRecipientDigest, type RecipientAccount } from "./account.js";
import {
  EnrollmentApiError,
  assertIntentId,
  type BindingProjection,
  type EnrollmentApi,
  type ReceiptApi,
  type ReceiptChallenge,
  type ReceiptSubmission,
} from "./api.js";
import { backupAcknowledgement, type BackupMode } from "./backup-mode.js";
import type {
  AztecPort,
  ExitRequest,
  ExitResult,
  FeeJuiceClaim,
  ReceivedTransfer,
} from "./chain.js";
import { anyCaseEvm, anyCaseHex32, type Corridor } from "./corridor.js";
import {
  bindingTypedData,
  buildBinding,
  buildEnrollmentRequest,
  signTokenRegistrationAck,
  type BindingTypedData,
  type EnrollmentChallenge,
  type SignedAck,
  type WireBinding,
} from "./enrollment.js";
import { assertPinnedNetwork } from "./network.js";
import { tokenImmutables } from "./oxide-token.js";
import { orderFingerprintFromMeta } from "./order-fingerprint.js";
import type { OperationJournal } from "./operation-journal.js";
import type { Clock } from "./ports.js";
import {
  assertCorridorPayoutDiscovered,
  checkReceiptChallenge,
  selectReceiptTransfer,
  signPaymentReceipt,
  type ReceiptJournal,
  type ReceiptRecord,
} from "./receipt.js";

export interface Ctx {
  corridor: Corridor;
  port: AztecPort;
  log: (line: string) => void;
  clock: Clock;
}

/** Enrollment touches no node: only the corridor record and the enrollment API. */
export type EnrollmentCtx = Pick<Ctx, "corridor" | "log">;

const unixSeconds = (clock: Clock) => Math.floor(clock.nowMs() / 1000);

/** Refuses any node that is not the corridor's network, before anything else runs. */
export async function checkNetwork(ctx: Ctx): Promise<void> {
  assertPinnedNetwork(await ctx.port.observeNetwork(), ctx.corridor);
  ctx.log(
    `network: pinned (${ctx.corridor.name}, rollup version ${ctx.corridor.network.protocolVersion})`,
  );
}

/**
 * Adds the account to the PXE and, unless it is already initialized, publishes its instance and
 * runs its constructor. `claim` is Xochi's sponsored Fee Juice claim (xochi#759 decision
 * 2026-11-02); without one the account pays from its own Fee Juice. Returns the deployment's
 * transaction hash, or null when the account was already published and initialized.
 */
export async function setupAccount(
  ctx: Ctx,
  account: RecipientAccount,
  claim: FeeJuiceClaim | null,
): Promise<string | null> {
  await ctx.port.addAccount(account);
  const state = await ctx.port.accountState(account.address);
  if (state.initialized && state.published) {
    ctx.log(`account: ${account.address.toString()} published and initialized`);
    return null;
  }
  if (state.initialized) {
    throw new Error(
      `account ${account.address.toString()} is initialized but its instance is not published; RecipientDeployment stays pending. Publish the instance (it is not redeployed: the constructor already ran).`,
    );
  }
  const txHash = await ctx.port.deployAccount(account, claim);
  ctx.log(`account: deployed ${account.address.toString()} in ${txHash}`);
  return txHash;
}

/** `registerSender` for exactly the corridor's senders, then reads them back. */
export async function registerSenders(ctx: Ctx): Promise<void> {
  for (const sender of ctx.corridor.registeredSenders) {
    await ctx.port.registerSender(AztecAddress.fromStringUnsafe(sender));
  }
  const registered = new Set(await ctx.port.registeredSenders());
  const missing = ctx.corridor.registeredSenders.filter((s) => !registered.has(s));
  if (missing.length > 0) throw new Error(`senders not registered: ${missing.join(", ")}`);
  ctx.log(`senders: registered ${ctx.corridor.registeredSenders.join(", ")}`);
}

/**
 * Registers the prevalidated OxideToken at the corridor's address and runs `store_immutables`
 * with the corridor's `l2TokenImmutables` (never `readOxideTokenImmutables`). Returns when, in
 * unix seconds.
 */
export async function registerToken(ctx: Ctx, artifact: ContractArtifact): Promise<number> {
  const token = AztecAddress.fromStringUnsafe(ctx.corridor.token.address);
  if (!(await ctx.port.tokenLockedToArtifact(artifact, token))) {
    throw new Error(
      `token ${token.toString()} is not published and locked to the pinned OxideToken class`,
    );
  }
  await ctx.port.registerToken(artifact, tokenImmutables(ctx.corridor), token);
  ctx.log(
    `token: registered ${token.toString()} (class ${ctx.corridor.token.classId}) and stored its immutables`,
  );
  return unixSeconds(ctx.clock);
}

const formatUnits = (amount: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const fraction = (amount % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${amount / unit}.${fraction}` : `${amount / unit}`;
};

/**
 * The OXDAI balance after sync, and each received transfer with the order fingerprint its
 * meta carries. A note without a valid enclave signature is dropped by the token's own
 * handler during sync, so it is never counted here.
 */
export async function showBalance(
  ctx: Ctx,
  artifact: ContractArtifact,
  account: RecipientAccount,
): Promise<bigint> {
  const token = AztecAddress.fromStringUnsafe(ctx.corridor.token.address);
  const { decimals, symbol } = ctx.corridor.token.immutables;
  const balance = await ctx.port.balance(artifact, token, account.address);
  ctx.log(`balance: ${formatUnits(balance, decimals)} ${symbol}`);
  for (const t of await ctx.port.transfers(artifact, token, account.address)) {
    let fingerprint: string;
    try {
      fingerprint = orderFingerprintFromMeta(t.meta) ?? "none (not a tagged payout)";
    } catch (error) {
      // One malformed tagged meta must not hide the other payouts: name it and go on.
      fingerprint = `unreadable (${error instanceof Error ? error.message : String(error)})`;
    }
    ctx.log(
      `received: ${formatUnits(t.amount, decimals)} ${symbol} in ${t.txHash} (block ${t.blockNumber}) order fingerprint ${fingerprint}`,
    );
  }
  return balance;
}

export interface PendingEnrollment {
  challenge: EnrollmentChallenge;
  binding: WireBinding;
  typedData: BindingTypedData;
  /** Signed at start for an OxideToken corridor (xochi#753); the next backup carries it. */
  tokenRegistrationAck: SignedAck | null;
}

/**
 * Requests the challenge, builds the binding the source wallet must sign and, for an
 * OxideToken corridor, signs the `TokenRegistrationAck` (run after `setup` registered the
 * token), so the backup written before `enroll submit` carries it.
 */
export async function enrollStart(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  account: RecipientAccount,
  sourceWallet: string,
  tokenRegisteredAt: number | null,
): Promise<PendingEnrollment> {
  if (!anyCaseEvm.safeParse(sourceWallet).success)
    throw new Error("source wallet must be a 20-byte 0x address");
  const challenge = await api.challenge();
  const binding = buildBinding(ctx.corridor, account, sourceWallet, challenge);
  const { typedData, digest } = bindingTypedData(ctx.corridor, binding);
  // The ack asserts the PXE registered the token and stored its immutables: signed only after
  // this data directory recorded a successful `registerToken`.
  const tokenRegistrationAck =
    tokenRegisteredAt === null
      ? null
      : await signTokenRegistrationAck(ctx.corridor, account, binding, signRecipientDigest);
  ctx.log(
    `enrollment: challenge ${challenge.challenge_id}, expires ${new Date(challenge.expires_at * 1000).toISOString()}`,
  );
  ctx.log(`enrollment: the source wallet signs RecipientBinding ${digest} (eth_signTypedData_v4)`);
  if (tokenRegistrationAck) {
    ctx.log("enrollment: TokenRegistrationAck signed; write the backup now so it carries it");
  } else if (tokenRegisteredAt === null) {
    ctx.log(
      "enrollment: TokenRegistrationAck not signed: the token is not registered here yet (run setup)",
    );
  }
  return { challenge, binding, typedData, tokenRegistrationAck };
}

/**
 * Signs and submits the authorization plus the exact acknowledgement set the Worker requires.
 * `backup` is how the keys are kept: the sealed backup file's commitment (the CLI) or the
 * passkey (`backup-mode.ts`).
 */
export async function enrollSubmit(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  account: RecipientAccount,
  pending: PendingEnrollment,
  sourceSignature: string,
  backup: BackupMode,
): Promise<BindingProjection> {
  const acknowledged = backupAcknowledgement(backup);
  const request = await buildEnrollmentRequest({
    corridor: ctx.corridor,
    account,
    challenge: pending.challenge,
    binding: pending.binding,
    sourceSignature,
    backupCommitment: acknowledged.backupCommitment,
    backupFormatId: acknowledged.backupFormatId,
    backupPasskey: acknowledged.backupPasskey,
    tokenRegistrationAck: pending.tokenRegistrationAck,
    sign: signRecipientDigest,
  });
  const projection = await api.enroll(request);
  if (
    projection.descriptor_digest.toLowerCase() !== pending.binding.descriptorDigest.toLowerCase()
  ) {
    throw new Error("enrollment API returned a projection for a different recipient descriptor");
  }
  ctx.log(`enrollment: binding ${projection.binding_id} is ${projection.state}`);
  return projection;
}

/** The binding's state as the Worker projects it; nothing beyond it. */
export async function enrollStatus(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  bindingId: string,
  account: RecipientAccount,
): Promise<BindingProjection> {
  const projection = await api.projection(bindingId);
  if (projection.binding_id !== bindingId) {
    throw new Error("enrollment API returned a different binding id");
  }
  if (
    projection.descriptor_digest.toLowerCase() !==
    hashRecipientDescriptor(account.descriptor).toLowerCase()
  ) {
    throw new Error("enrollment API returned a projection for a different recipient descriptor");
  }
  ctx.log(`enrollment: binding ${projection.binding_id} is ${projection.state}`);
  return projection;
}

/**
 * A private OXDAI transfer through the enclave-signed path (#739, #740). `claim` pays its fee
 * with a sponsored Fee Juice claim; without one the account pays from its own Fee Juice.
 */
export async function spend(
  ctx: Ctx,
  account: RecipientAccount,
  artifact: ContractArtifact,
  to: string,
  amount: bigint,
  claim: FeeJuiceClaim | null = null,
): Promise<string> {
  if (!anyCaseHex32.safeParse(to).success)
    throw new Error("--to must be a 0x-prefixed 32-byte Aztec address");
  if (amount === 0n) throw new Error("--amount must be positive");
  const recipient = AztecAddress.fromStringUnsafe(to);
  if (recipient.isZero() || !(await recipient.isValid())) {
    throw new Error("--to must be a valid, nonzero Aztec address");
  }
  const txHash = await ctx.port.spend(account, artifact, recipient, amount, claim);
  ctx.log(`spend: ${amount} base units to ${to} in ${txHash}`);
  return txHash;
}

/**
 * A withdrawal to L1 DAI through the enclave-signed path; any relayer finalizes it for the
 * relayer tip, so a zero tip is refused (nobody relays it, and only the owner could finalize).
 * Each withdrawal's finalization data and L1 operation id are logged; the caller persists them.
 */
export async function exit(
  ctx: Ctx,
  account: RecipientAccount,
  artifact: ContractArtifact,
  request: ExitRequest,
): Promise<ExitResult> {
  if (!anyCaseEvm.safeParse(request.l1Recipient).success) {
    throw new Error("--l1-recipient must be a 20-byte 0x address");
  }
  if (request.amount === 0n) throw new Error("--amount must be positive");
  if (request.relayerTip === 0n) {
    throw new Error(
      "--relayer-tip must be positive: a finalization request with no tip may never be relayed",
    );
  }
  const result = await ctx.port.exit(account, artifact, request);
  ctx.log(
    `exit: ${request.amount} base units to L1 ${request.l1Recipient} in ${result.txHash}; recipient receives ${result.recipientAmount ?? "unknown (dry-run)"} base units after executor fee ${result.executorFee ?? "unknown (dry-run)"} and relayer tip ${request.relayerTip}`,
  );
  for (const w of result.withdrawals) {
    ctx.log(
      `exit: withdrawal ${w.withdrawalIndex} operationId ${w.operationId ?? "none (not broadcast)"} finalizationData ${w.finalizationData}`,
    );
  }
  return result;
}

export interface ReceiptRequest {
  intentId: string;
  /** `--tx`: the payout transaction, when more than one payout of the intent matches. */
  tx: string | null;
  /** `--already-spent`: this account spent the payout after it landed (recorded). */
  alreadySpent: boolean;
  /** The RecipientBinding digest this data directory enrolled, if it knows it. */
  bindingDigest: string | null;
  /** The binding id this data directory enrolled (`state.json` `bindingId`), if any. */
  bindingId: string | null;
  /** `--legacy-binding`: adopt the challenge's digest for `bindingId` (no digest recorded). */
  legacyBinding: boolean;
  /**
   * Saves the binding digest and id of an accepted `--legacy-binding` receipt (from its record),
   * so later runs need no flag.
   */
  rememberBindingDigest: (digest: string, bindingId: string) => void | Promise<void>;
  /** Dry run: nothing is locked or written. */
  dryRun: boolean;
}

export interface ReceiptJournals {
  receipts: ReceiptJournal;
  /** The fund-movement journal: its lock is held for the run (`beginReceipt`). */
  operations: OperationJournal;
}

function assertUnexpired(clock: Clock, challenge: ReceiptChallenge): void {
  if (challenge.expires_at <= unixSeconds(clock)) {
    throw new Error(
      `receipt challenge ${challenge.challenge_id} expired at ${new Date(challenge.expires_at * 1000).toISOString()}; run receipt again`,
    );
  }
}

/** Runs `step` under the fund-movement lock (a dry run takes none). */
async function underReceiptLock<T>(
  journals: ReceiptJournals,
  request: ReceiptRequest,
  step: (request: ReceiptRequest) => Promise<T>,
): Promise<T> {
  const intentId = assertIntentId(request.intentId);
  const run = request.dryRun ? null : await journals.operations.beginReceipt(intentId);
  try {
    return await step({ ...request, intentId });
  } finally {
    if (run) await journals.operations.endReceipt(run.id);
  }
}

/**
 * The recipient's PaymentReceiptAck for a shielded payout (design "independently discovered and
 * spendable"), under the fund-movement lock: sync this PXE's payouts; request the Worker's
 * receipt challenge and check its terms (`checkReceiptChallenge`); select the corridor sender's
 * payout tagged with the terms' order fingerprint; require the node's receipt for it to be
 * finalized, successful and in the discovered block; simulate spending the amount; only then
 * sign, journal and post. An accepted receipt is answered from the journal. An unaccepted one is
 * resent byte for byte, and signed again under a new challenge only after Xochi rejects it
 * outright, for the same terms, operation, amount and payout.
 */
export async function receipt(
  ctx: Ctx,
  api: ReceiptApi,
  account: RecipientAccount,
  artifact: ContractArtifact,
  journals: ReceiptJournals,
  request: ReceiptRequest,
): Promise<ReceiptRecord | null> {
  return underReceiptLock(journals, request, async (locked) => {
    const recorded = await recordedReceipt(ctx, journals.receipts, locked);
    if (recorded?.status === "submitted") return recorded;
    return postReceipt(ctx, api, account, artifact, journals, locked, recorded);
  });
}

/**
 * `receipt`'s steps up to the POST (the browser's first half): under the fund-movement lock,
 * every check, then the signed request journaled `submitting` before this resolves. An intent
 * whose receipt is already recorded is answered from the journal; `submitReceipt` posts it.
 */
export async function signReceipt(
  ctx: Ctx,
  api: ReceiptApi,
  account: RecipientAccount,
  artifact: ContractArtifact,
  journals: ReceiptJournals,
  request: ReceiptRequest,
): Promise<ReceiptRecord> {
  if (request.dryRun) throw new Error("signReceipt journals its receipt: no dry run");
  return underReceiptLock(journals, request, async (locked) => {
    const recorded = await recordedReceipt(ctx, journals.receipts, locked);
    if (recorded) return recorded;
    await signReceiptAttempt(ctx, api, account, artifact, journals, locked, null);
    const signed = await journals.receipts.read(locked.intentId);
    if (!signed) throw new Error(`intent ${locked.intentId}'s receipt record was not written`);
    return signed;
  });
}

/**
 * `receipt`'s POST (the browser's second half): sends the recorded receipt's last request byte
 * for byte; only an outright rejection signs it again under a new challenge, for the recorded
 * terms and payout, and posts that.
 */
export async function submitReceipt(
  ctx: Ctx,
  api: ReceiptApi,
  account: RecipientAccount,
  artifact: ContractArtifact,
  journals: ReceiptJournals,
  request: ReceiptRequest,
): Promise<ReceiptRecord> {
  if (request.dryRun) throw new Error("submitReceipt posts a journaled receipt: no dry run");
  return underReceiptLock(journals, request, async (locked) => {
    const recorded = await recordedReceipt(ctx, journals.receipts, locked);
    if (!recorded) {
      throw new Error(`intent ${locked.intentId} has no signed receipt: sign it first`);
    }
    if (recorded.status === "submitted") return recorded;
    const accepted = await postReceipt(ctx, api, account, artifact, journals, locked, recorded);
    if (!accepted) throw new Error(`intent ${locked.intentId}'s receipt was not recorded`);
    return accepted;
  });
}

/** The intent's receipt record, refused when the request names another payout or binding. */
async function recordedReceipt(
  ctx: Ctx,
  receipts: ReceiptJournal,
  request: ReceiptRequest,
): Promise<ReceiptRecord | null> {
  const { intentId } = request;
  const recorded = await receipts.read(intentId);
  if (recorded?.status === "submitted") {
    ctx.log(
      `receipt: intent ${intentId} already accepted (payout ${recorded.txHash}, receipt_digest ${recorded.receipt_digest})`,
    );
    return recorded;
  }
  if (recorded && request.tx !== null && request.tx.toLowerCase() !== recorded.txHash) {
    throw new Error(
      `--tx ${request.tx} is not this intent's recorded payout ${recorded.txHash}; a receipt never moves to another payout`,
    );
  }
  if (recorded && request.bindingId !== null && request.bindingId !== recorded.bindingId) {
    throw new Error(
      `binding id ${request.bindingId} is not the recorded receipt's binding id ${recorded.bindingId}`,
    );
  }
  return recorded;
}

/** Resends a recorded receipt, else (or after an outright rejection) signs one and posts it. */
async function postReceipt(
  ctx: Ctx,
  api: ReceiptApi,
  account: RecipientAccount,
  artifact: ContractArtifact,
  journals: ReceiptJournals,
  request: ReceiptRequest,
  recorded: ReceiptRecord | null,
): Promise<ReceiptRecord | null> {
  const { intentId } = request;
  if (recorded) {
    ctx.log(`receipt: resending the recorded receipt for payout ${recorded.txHash}`);
    try {
      const result = await api.submitReceipt(intentId, recorded.attempts.at(-1)!.request);
      return await accept(ctx, journals.receipts, request, result.intent_id, result.receipt_digest);
    } catch (error) {
      if (!(error instanceof EnrollmentApiError && error.rejectsReceipt)) throw error;
      ctx.log(
        `receipt: Xochi rejected the recorded receipt (${error.status} ${error.category}); signing it again under a new challenge, for the same payout and terms`,
      );
    }
  }
  const submission = await signReceiptAttempt(
    ctx,
    api,
    account,
    artifact,
    journals,
    request,
    recorded,
  );
  const result = await api.submitReceipt(intentId, submission);
  return accept(ctx, journals.receipts, request, result.intent_id, result.receipt_digest);
}

/**
 * Syncs, takes a new challenge, checks it, selects the payout, requires it finalized and
 * spendable, signs, and journals the signed request (a dry run journals nothing).
 */
async function signReceiptAttempt(
  ctx: Ctx,
  api: ReceiptApi,
  account: RecipientAccount,
  artifact: ContractArtifact,
  { receipts, operations }: ReceiptJournals,
  request: ReceiptRequest,
  recorded: ReceiptRecord | null,
): Promise<ReceiptSubmission> {
  const { intentId } = request;
  // Sync before the challenge: the challenge expires, a first sync may be slow.
  const token = AztecAddress.fromStringUnsafe(ctx.corridor.token.address);
  const transfers = await ctx.port.transfers(artifact, token, account.address);
  assertCorridorPayoutDiscovered(transfers, ctx.corridor.registeredSenders);

  const challenge = await api.requestReceiptChallenge(intentId);
  assertUnexpired(ctx.clock, challenge);
  const checked = checkReceiptChallenge(ctx.corridor, account, challenge, {
    intentId,
    bindingDigest: request.bindingDigest,
    bindingId: request.bindingId,
    legacyBinding: request.legacyBinding,
  });
  const pinnedBy = await receipts.intentPinning(checked, intentId);
  if (pinnedBy !== null) {
    throw new Error(
      `receipt refused: intent ${pinnedBy}'s receipt already holds these terms or this operation`,
    );
  }
  if (
    recorded &&
    (recorded.termsDigest !== checked.termsDigest ||
      recorded.operationId !== checked.operationId ||
      recorded.amount !== checked.amount.toString())
  ) {
    throw new Error(
      `receipt refused: the new challenge's terms, operation or amount differ from the recorded receipt of intent ${intentId}`,
    );
  }
  if (checked.legacyBinding) {
    ctx.log(
      `receipt: --legacy-binding: signing under binding ${challenge.receipt.binding_id}, digest ${checked.bindingDigest} (saved to state.json once Xochi accepts the receipt)`,
    );
  }
  ctx.log(
    `receipt: challenge ${challenge.challenge_id} for intent ${intentId}: ${checked.amount} base units, terms ${checked.termsDigest}, order fingerprint ${checked.orderFingerprint}`,
  );

  const transfer = selectReceiptTransfer(
    transfers,
    {
      amount: checked.amount,
      orderFingerprint: checked.orderFingerprint,
      senders: ctx.corridor.registeredSenders,
    },
    await receipts.receiptedTxHashes(intentId),
    recorded?.txHash ?? request.tx,
  );
  const node = await ctx.port.txReceipt(transfer.txHash);
  if (node.status !== TxStatus.FINALIZED) {
    throw new Error(
      `payout ${transfer.txHash} is ${node.status} on this node, not finalized; run receipt again once it is`,
    );
  }
  if (!node.executionSucceeded) {
    throw new Error(`payout ${transfer.txHash} reverted on this node; nothing to acknowledge`);
  }
  if (node.blockNumber !== transfer.blockNumber) {
    throw new Error(
      `payout ${transfer.txHash} was discovered in block ${transfer.blockNumber}, but this node puts it in block ${node.blockNumber}`,
    );
  }
  ctx.log(
    `receipt: payout ${transfer.txHash} (block ${transfer.blockNumber}) finalized on this node`,
  );

  const alreadySpentBy = await assertSpendable(ctx, operations, account, artifact, transfer, {
    amount: checked.amount,
    alreadySpent: request.alreadySpent,
  });

  assertUnexpired(ctx.clock, challenge);
  const { submission, digest } = await signPaymentReceipt({
    corridor: ctx.corridor,
    account,
    challenge,
    transfer,
    sign: signRecipientDigest,
  });
  ctx.log(`receipt: signed PaymentReceiptAck ${digest}`);
  if (!request.dryRun) {
    if (recorded) {
      await receipts.retry(intentId, submission, alreadySpentBy);
    } else {
      await receipts.begin({
        intentId,
        termsDigest: checked.termsDigest,
        operationId: checked.operationId,
        amount: checked.amount.toString(),
        txHash: transfer.txHash,
        blockNumber: String(transfer.blockNumber),
        bindingId: challenge.receipt.binding_id,
        legacyBinding: checked.legacyBinding,
        alreadySpentBy,
        request: submission,
      });
    }
  }
  return submission;
}

/**
 * Simulates spending `amount` in this PXE. When that fails, `--already-spent` lets the payout
 * count as received only if the balance no longer covers the amount and the balance plus this
 * account's completed spends and exits mined after the payout do; those transactions are
 * returned for the record. Otherwise nothing is signed.
 */
async function assertSpendable(
  ctx: Ctx,
  operations: OperationJournal,
  account: RecipientAccount,
  artifact: ContractArtifact,
  transfer: ReceivedTransfer,
  { amount, alreadySpent }: { amount: bigint; alreadySpent: boolean },
): Promise<string[]> {
  try {
    await ctx.port.simulateTransfer(account, artifact, account.address, amount);
    ctx.log(`receipt: ${amount} base units spendable (simulated in this PXE; nothing sent)`);
    return [];
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const token = AztecAddress.fromStringUnsafe(ctx.corridor.token.address);
    let balance: bigint;
    try {
      balance = await ctx.port.balance(artifact, token, account.address);
    } catch (balanceError) {
      throw new Error(
        `simulation failed: ${cause}; reading the balance then failed too: ${balanceError instanceof Error ? balanceError.message : String(balanceError)}; receipt not signed`,
        { cause: error },
      );
    }
    const spends = balance < amount ? await spendsAfter(ctx, operations, transfer.blockNumber) : [];
    const spent = spends.reduce((sum, s) => sum + s.amount, 0n);
    const covered = balance < amount && balance + spent >= amount;
    const named = spends.map((s) => `${s.kind} ${s.txHash}`).join(", ");
    if (!alreadySpent) {
      throw new Error(
        `simulation failed: ${cause}; receipt not signed${
          covered
            ? `. The balance (${balance}) no longer covers the amount, and this account's ${named} mined after the payout make up the difference: if they spent the payout, run receipt again with --already-spent`
            : ""
        }`,
        { cause: error },
      );
    }
    if (balance >= amount) {
      throw new Error(
        `simulation failed: ${cause}; --already-spent refused: this PXE's balance still covers the amount: the simulation failed for another reason`,
        { cause: error },
      );
    }
    if (!covered) {
      throw new Error(
        `simulation failed: ${cause}; --already-spent refused: the balance (${balance}) plus this account's completed spends and exits mined after the payout's block ${transfer.blockNumber} (${spent}) do not cover the ${amount} base units`,
        { cause: error },
      );
    }
    ctx.log(
      `receipt: simulation failed (${cause}); --already-spent: this account's ${named} spent the payout after it landed, recorded with the receipt`,
    );
    return spends.map((s) => s.txHash);
  }
}

/** This account's completed, successful spends and exits mined after `block`, in block order. */
async function spendsAfter(
  ctx: Ctx,
  operations: OperationJournal,
  block: number,
): Promise<{ kind: string; txHash: string; amount: bigint }[]> {
  const spends: { kind: string; txHash: string; amount: bigint; block: number }[] = [];
  for (const record of await operations.records()) {
    if ((record.kind !== "spend" && record.kind !== "exit") || record.status !== "complete") {
      continue;
    }
    const amount = record.request["amount"];
    if (!record.txHash || amount === undefined) continue;
    const node = await ctx.port.txReceipt(record.txHash);
    if (node.executionSucceeded && node.blockNumber !== null && node.blockNumber > block) {
      spends.push({
        kind: record.kind,
        txHash: record.txHash,
        amount: BigInt(amount),
        block: node.blockNumber,
      });
    }
  }
  return spends.sort((a, b) => a.block - b.block || a.txHash.localeCompare(b.txHash));
}

async function accept(
  ctx: Ctx,
  receipts: ReceiptJournal,
  request: ReceiptRequest,
  answeredIntentId: string,
  receiptDigest: string,
): Promise<ReceiptRecord | null> {
  if (answeredIntentId !== request.intentId) {
    throw new Error(`the Worker answered for intent ${answeredIntentId}, not ${request.intentId}`);
  }
  ctx.log(`receipt: intent ${request.intentId} completed; receipt_digest ${receiptDigest}`);
  if (request.dryRun) return null;
  const record = await receipts.complete(
    request.intentId,
    receiptDigest,
    new Date(ctx.clock.nowMs()).toISOString(),
  );
  if (record.legacyBinding && request.bindingDigest === null) {
    const adopted = record.attempts.at(-1)!.request.acknowledgement.message.bindingDigest;
    await request.rememberBindingDigest(adopted, record.bindingId);
    ctx.log(
      `receipt: binding ${record.bindingId} digest ${adopted} saved to state.json; later runs need no flag`,
    );
  }
  return record;
}
