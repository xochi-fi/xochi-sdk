// The tool's steps, written once against `AztecPort` and `EnrollmentApi`, so a dry run walks
// the exact sequence a live run makes. Order follows the round-trip-critical path (xochi#759):
// network, account, senders, token, balance, enrollment; then backup, spend and exit.

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { hashRecipientDescriptor } from "@xochi/signer";

import { signRecipientDigest, type RecipientAccount } from "./account.js";
import type { BindingProjection, EnrollmentApi } from "./api.js";
import type { AztecPort, ExitRequest, ExitResult, FeeJuiceClaim } from "./chain.js";
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

export interface Ctx {
  corridor: Corridor;
  port: AztecPort;
  log: (line: string) => void;
}

/** Enrollment touches no node: only the corridor record and the enrollment API. */
export type EnrollmentCtx = Pick<Ctx, "corridor" | "log">;

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
 * 2026-11-02); without one the account pays from its own Fee Juice.
 */
export async function setupAccount(
  ctx: Ctx,
  account: RecipientAccount,
  claim: FeeJuiceClaim | null,
): Promise<void> {
  await ctx.port.addAccount(account);
  const state = await ctx.port.accountState(account.address);
  if (state.initialized && state.published) {
    ctx.log(`account: ${account.address.toString()} published and initialized`);
    return;
  }
  if (state.initialized) {
    throw new Error(
      `account ${account.address.toString()} is initialized but its instance is not published; RecipientDeployment stays pending. Publish the instance (it is not redeployed: the constructor already ran).`,
    );
  }
  const txHash = await ctx.port.deployAccount(account, claim);
  ctx.log(`account: deployed ${account.address.toString()} in ${txHash}`);
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
 * with the corridor's `l2TokenImmutables` (never `readOxideTokenImmutables`).
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
  return Math.floor(Date.now() / 1000);
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

/** Signs and submits the authorization plus the exact acknowledgement set the Worker requires. */
export async function enrollSubmit(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  account: RecipientAccount,
  pending: PendingEnrollment,
  sourceSignature: string,
  backupCommitment: string,
): Promise<BindingProjection> {
  const request = await buildEnrollmentRequest({
    corridor: ctx.corridor,
    account,
    challenge: pending.challenge,
    binding: pending.binding,
    sourceSignature,
    backupCommitment,
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

/** A private OXDAI transfer through the enclave-signed path (#739, #740). */
export async function spend(
  ctx: Ctx,
  account: RecipientAccount,
  artifact: ContractArtifact,
  to: string,
  amount: bigint,
): Promise<string> {
  if (!anyCaseHex32.safeParse(to).success)
    throw new Error("--to must be a 0x-prefixed 32-byte Aztec address");
  if (amount === 0n) throw new Error("--amount must be positive");
  const recipient = AztecAddress.fromStringUnsafe(to);
  if (recipient.isZero() || !(await recipient.isValid())) {
    throw new Error("--to must be a valid, nonzero Aztec address");
  }
  const txHash = await ctx.port.spend(account, artifact, recipient, amount);
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
