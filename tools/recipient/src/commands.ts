// The tool's steps, written once against `AztecPort` and `EnrollmentApi`, so a dry run walks
// the exact sequence a live run makes. Order follows the round-trip-critical path (xochi#759):
// network, account, senders, token, balance, enrollment; then backup, spend and exit.

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";

import { signRecipientDigest, type RecipientAccount } from "./account.js";
import type { BindingProjection, EnrollmentApi } from "./api.js";
import type { AztecPort, ExitRequest, FeeJuiceClaim } from "./chain.js";
import type { Corridor } from "./corridor.js";
import {
  bindingTypedData,
  buildBinding,
  buildEnrollmentRequest,
  type BindingTypedData,
  type EnrollmentChallenge,
  type WireBinding,
} from "./enrollment.js";
import { assertPinnedNetwork } from "./network.js";
import { assertTokenInstance, tokenImmutables } from "./oxide-token.js";
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
 * Registers the OxideToken at the corridor's address with the hash-checked artifact and runs
 * `store_immutables` with the corridor's `l2TokenImmutables` (never `readOxideTokenImmutables`).
 */
export async function registerToken(ctx: Ctx, artifact: ContractArtifact): Promise<void> {
  await assertTokenInstance(artifact, ctx.corridor);
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
    const fingerprint = orderFingerprintFromMeta(t.meta);
    ctx.log(
      `received: ${formatUnits(t.amount, decimals)} ${symbol} in ${t.txHash} (block ${t.blockNumber}) order fingerprint ${fingerprint ?? "none (not a tagged payout)"}`,
    );
  }
  return balance;
}

export interface PendingEnrollment {
  challenge: EnrollmentChallenge;
  binding: WireBinding;
  typedData: BindingTypedData;
}

/** Requests the challenge and builds the binding the source wallet must sign. */
export async function enrollStart(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  account: RecipientAccount,
  sourceWallet: string,
): Promise<PendingEnrollment> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(sourceWallet))
    throw new Error("source wallet must be a 20-byte 0x address");
  const challenge = await api.challenge();
  const binding = buildBinding(ctx.corridor, account, sourceWallet, challenge);
  const { typedData, digest } = bindingTypedData(ctx.corridor, binding);
  ctx.log(
    `enrollment: challenge ${challenge.challenge_id}, expires ${new Date(challenge.expires_at * 1000).toISOString()}`,
  );
  ctx.log(`enrollment: the source wallet signs RecipientBinding ${digest} (eth_signTypedData_v4)`);
  return { challenge, binding, typedData };
}

/** Signs the authorization and acknowledgements and submits the enrollment. */
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
    sign: signRecipientDigest,
  });
  const projection = await api.enroll(request);
  ctx.log(`enrollment: binding ${projection.binding_id} is ${projection.state}`);
  return projection;
}

/** The binding's state as the Worker projects it; nothing beyond it. */
export async function enrollStatus(
  ctx: EnrollmentCtx,
  api: EnrollmentApi,
  bindingId: string,
): Promise<BindingProjection> {
  const projection = await api.projection(bindingId);
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(to))
    throw new Error("--to must be a 0x-prefixed 32-byte Aztec address");
  if (amount === 0n) throw new Error("--amount must be positive");
  const txHash = await ctx.port.spend(account, artifact, AztecAddress.fromStringUnsafe(to), amount);
  ctx.log(`spend: ${amount} base units to ${to} in ${txHash}`);
  return txHash;
}

/** A withdrawal to L1 DAI through the enclave-signed path; any relayer finalizes it. */
export async function exit(
  ctx: Ctx,
  account: RecipientAccount,
  artifact: ContractArtifact,
  request: ExitRequest,
): Promise<string> {
  const txHash = await ctx.port.exit(account, artifact, request);
  ctx.log(`exit: ${request.amount} base units to L1 ${request.l1Recipient} in ${txHash}`);
  return txHash;
}
