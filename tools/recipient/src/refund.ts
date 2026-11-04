// Recipient-owned Oxide portal refund authorization and submission. The fallback signing
// algorithm mirrors zkmoney-public 2764aedc oxide-client/src/sign_migration.ts; verification uses
// the vendored circuit mirror. Real proof generation stays upstream because pxe-bridge does not
// ship the builders or compiled refund circuits. This module never invents or weakens a proof.

import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin";
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon";
import { Fr } from "@aztec-labs/foundation/curves/bn254";
import { GrumpkinScalar, type Point } from "@aztec-labs/foundation/curves/grumpkin";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { deriveKeys, derivePublicKeyFromSecretKey } from "@aztec-labs/stdlib/keys";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseTransaction,
  type Hex,
} from "viem";
import { z } from "zod4";

import type { RecipientAccount } from "./account.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "./corridor.js";
import { OperationJournal } from "./operation-journal.js";
import { assertValidMigrationSignature } from "./oxide/vendor/oxide-lib-tee/migration_signature.js";
import { SCHNORR_CHALLENGE_DST } from "./oxide/vendor/oxide-lib-tee/grumpkin_schnorr_signature.js";
import type {
  FallbackKeyMigrationSignature,
  MigrationSignature,
} from "./oxide/vendor/oxide-lib-tee/migration_signature.js";
import { getUserPayloadHash } from "./oxide/vendor/oxide-lib/content_hash.js";
import {
  buildPlainExecutorCall,
  decodePlainWithdrawalPayload,
} from "./oxide/vendor/oxide-lib/plain_withdrawal_executor.js";
import { DOM_SEP__MIGRATION } from "./oxide/vendor/oxide-lib-tee/oxide_constants.gen.js";

const hex20 = z.string().regex(/^0x[0-9a-f]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const hexBytes = z.string().regex(/^0x(?:[0-9a-f]{2})+$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const nonzeroDecimal = z.string().regex(/^[1-9][0-9]*$/);
const teeSignature = z.string().regex(/^0x[0-9a-f]{130}$/);
const fieldJson = z.string().regex(/^0x[0-9a-f]{64}$/);
const MAX_NOTES = 20;
const MAX_DEPOSITS = 5;
const TWO_POW_128 = 1n << 128n;

const FrozenNotesEvidenceSchema = z
  .object({
    format: z.literal("xochi.shielded.refund-evidence.v1"),
    kind: z.literal("frozen-notes"),
    owner: hex32,
    amount: nonzeroDecimal,
    nullifiers: z.array(hex32).min(1).max(MAX_NOTES),
  })
  .strict();
const FrozenDepositsEvidenceSchema = z
  .object({
    format: z.literal("xochi.shielded.refund-evidence.v1"),
    kind: z.literal("frozen-deposits"),
    owner: hex32,
    amount: nonzeroDecimal,
    nullifiers: z.array(hex32).min(1).max(MAX_DEPOSITS),
  })
  .strict();
const UnprocessedDepositEvidenceSchema = z
  .object({
    format: z.literal("xochi.shielded.refund-evidence.v1"),
    kind: z.literal("unprocessed-deposit"),
    owner: hex32,
    amount: nonzeroDecimal,
    siloedNullifier: hex32,
    messageHash: hex32,
    messageLeafIndex: decimal,
  })
  .strict();
export const RefundEvidenceSchema = z.discriminatedUnion("kind", [
  FrozenNotesEvidenceSchema,
  FrozenDepositsEvidenceSchema,
  UnprocessedDepositEvidenceSchema,
]);
export type RefundEvidence = z.infer<typeof RefundEvidenceSchema>;

const MigrationSignatureJsonSchema = z
  .object({
    kind: z.literal("fallbackKey"),
    fbpkM: z.object({ x: fieldJson, y: fieldJson }).strict(),
    fallbackSignature: z
      .object({ sLo: fieldJson, sHi: fieldJson, eLo: fieldJson, eHi: fieldJson })
      .strict(),
  })
  .strict();
export type MigrationSignatureJson = z.infer<typeof MigrationSignatureJsonSchema>;

export const RefundAuthorizationSchema = z
  .object({
    format: z.literal("xochi.shielded.refund-authorization.v1"),
    corridorId: hex32,
    corridorRevision: z.literal("2"),
    manifestDigest: z.literal("0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e"),
    portal: hex20,
    executor: hex20,
    destination: hex20,
    relayerTip: decimal,
    userPayload: hexBytes,
    userPayloadHash: hex32,
    evidence: RefundEvidenceSchema,
    migrationSignature: MigrationSignatureJsonSchema,
  })
  .strict();
export type RefundAuthorization = z.infer<typeof RefundAuthorizationSchema>;

export const RefundBundleSchema = RefundAuthorizationSchema.extend({
  format: z.literal("xochi.shielded.refund-bundle.v1"),
  proof: hexBytes,
  teeSignature,
}).strict();
export type RefundBundle = z.infer<typeof RefundBundleSchema>;

const PORTAL_ABI = parseAbi([
  "function ROLLUP_VERSION() view returns (uint256)",
  "function ROLLUP() view returns (address)",
  "function L2_TOKEN() view returns (bytes32)",
  "function TEE_REGISTRY() view returns (address)",
  "function TX_AMOUNT_CAP() view returns (uint128)",
  "function $frozen() view returns (bool)",
  "function $isRefundNullifierSpent(bytes32) view returns (bool)",
  "function refundFrozenNotes((address executor,bytes userPayload,bytes relayerPayload,uint256 amount,bytes32[] nullifiers,bytes proof,bytes teeSignature) args)",
  "function refundFrozenDeposits((address executor,bytes userPayload,bytes relayerPayload,uint256 amount,bytes32[] nullifiers,bytes proof,bytes teeSignature) args)",
  "function refundUnprocessedDeposit((address executor,bytes userPayload,bytes relayerPayload,uint256 amount,bytes32 siloedNullifier,bytes32 messageHash,uint256 messageLeafIndex,bytes proof,bytes teeSignature) args)",
]);
const EXECUTOR_ABI = parseAbi(["function PORTAL() view returns (address)"]);

function exactCorridor(corridor: Corridor): void {
  const expected = OXDAI_MAINNET_REV2;
  const checks: [string, string, string][] = [
    ["corridorId", corridor.corridorId, expected.corridorId],
    ["corridorRevision", corridor.corridorRevision, expected.corridorRevision],
    ["manifestDigest", corridor.manifestDigest, expected.manifestDigest],
    ["l1ChainId", corridor.network.l1ChainId, expected.network.l1ChainId],
    ["protocolVersion", corridor.network.protocolVersion, expected.network.protocolVersion],
    ["rollupAddress", corridor.network.rollupAddress, expected.network.rollupAddress],
    ["token.address", corridor.token.address, expected.token.address],
    ["token.classId", corridor.token.classId, expected.token.classId],
    ["token.artifactHash", corridor.token.artifactHash, expected.token.artifactHash],
    ["portal", corridor.token.immutables.portal, expected.token.immutables.portal],
    ["teeRegistry", corridor.token.immutables.teeRegistry, expected.token.immutables.teeRegistry],
    ["oxide.teeRegistry", corridor.oxide.teeRegistry, expected.oxide.teeRegistry],
    [
      "maxNoteAmount",
      corridor.token.immutables.maxNoteAmount,
      expected.token.immutables.maxNoteAmount,
    ],
    ["executor", corridor.oxide.plainWithdrawalExecutor, expected.oxide.plainWithdrawalExecutor],
  ];
  const moved = checks.filter(([, actual, pinned]) => actual !== pinned).map(([name]) => name);
  if (moved.length > 0) throw new Error(`refund corridor pin mismatch: ${moved.join(", ")}`);
}

function ownerInstance(account: RecipientAccount) {
  return {
    contractClassId: account.instance.originalContractClassId,
    salt: account.salt,
    initializationHash: account.instance.initializationHash,
    deployer: account.instance.deployer,
  };
}

function signatureToJson(signature: FallbackKeyMigrationSignature): MigrationSignatureJson {
  return MigrationSignatureJsonSchema.parse({
    kind: signature.kind,
    fbpkM: { x: signature.fbpkM.x.toString(), y: signature.fbpkM.y.toString() },
    fallbackSignature: Object.fromEntries(
      Object.entries(signature.fallbackSignature).map(([name, value]) => [name, value.toString()]),
    ),
  });
}

function signatureFromJson(signature: MigrationSignatureJson): MigrationSignature {
  return {
    kind: "fallbackKey",
    fbpkM: { x: Fr.fromString(signature.fbpkM.x), y: Fr.fromString(signature.fbpkM.y) } as Point,
    fallbackSignature: {
      sLo: Fr.fromString(signature.fallbackSignature.sLo),
      sHi: Fr.fromString(signature.fallbackSignature.sHi),
      eLo: Fr.fromString(signature.fallbackSignature.eLo),
      eHi: Fr.fromString(signature.fallbackSignature.eHi),
    },
  };
}

async function signFallbackMigration(
  privateKey: GrumpkinScalar,
  executor: EthAddress,
  userPayloadHash: Fr,
): Promise<FallbackKeyMigrationSignature> {
  const publicKey = await derivePublicKeyFromSecretKey(privateKey);
  const message = await poseidon2Hash([
    new Fr(DOM_SEP__MIGRATION),
    executor.toField(),
    userPayloadHash,
  ]);
  let nonce = GrumpkinScalar.random();
  while (nonce.isZero()) nonce = GrumpkinScalar.random();
  const point = await Grumpkin.mul(Grumpkin.generator, nonce);
  const challenge = await poseidon2Hash([
    SCHNORR_CHALLENGE_DST,
    point.x,
    publicKey.x,
    publicKey.y,
    message,
  ]);
  const order = GrumpkinScalar.MODULUS;
  const challengeBig = challenge.toBigInt();
  const response = new GrumpkinScalar(
    (((nonce.toBigInt() - ((challengeBig * privateKey.toBigInt()) % order)) % order) + order) %
      order,
  );
  return {
    kind: "fallbackKey",
    fbpkM: publicKey,
    fallbackSignature: {
      sLo: response.lo,
      sHi: response.hi,
      eLo: new Fr(challengeBig & (TWO_POW_128 - 1n)),
      eHi: new Fr(challengeBig >> 128n),
    },
  };
}

function assertEvidence(
  account: RecipientAccount,
  evidence: RefundEvidence,
  corridor: Corridor,
): void {
  if (evidence.owner !== account.address.toString().toLowerCase()) {
    throw new Error("refund evidence is not owned by this recipient account");
  }
  const amount = BigInt(evidence.amount);
  const cap = BigInt(corridor.token.immutables.maxNoteAmount);
  if (amount > cap) throw new Error("refund evidence amount exceeds the pinned portal cap");
  const values =
    evidence.kind === "unprocessed-deposit" ? [evidence.siloedNullifier] : evidence.nullifiers;
  if (new Set(values).size !== values.length || values.some((value) => BigInt(value) === 0n)) {
    throw new Error("refund evidence nullifiers must be unique and nonzero");
  }
}

/** Recomputes the stock Schnorr owner address with immutablesHash=0 and signs its fixed destination. */
export async function authorizeRefund(
  account: RecipientAccount,
  corridor: Corridor,
  evidenceInput: unknown,
  destination: string,
  relayerTip: bigint,
): Promise<RefundAuthorization> {
  exactCorridor(corridor);
  const evidence = RefundEvidenceSchema.parse(evidenceInput);
  assertEvidence(account, evidence, corridor);
  if (relayerTip !== 0n) {
    throw new Error("refund authorization requires a zero relayer tip");
  }
  const executor = EthAddress.fromString(corridor.oxide.plainWithdrawalExecutor);
  const destinationAddress = EthAddress.fromString(destination);
  const executorCall = buildPlainExecutorCall({
    executor,
    recipient: destinationAddress,
    relayerTip,
  });
  const decoded = decodePlainWithdrawalPayload(executorCall.userPayload);
  if (!decoded.recipient.equals(destinationAddress) || decoded.relayerTip !== relayerTip) {
    throw new Error("refund destination payload did not round trip");
  }
  const userPayloadHash = getUserPayloadHash(executorCall.userPayload);
  const { masterFallbackSecretKey, publicKeys } = await deriveKeys(account.secret);
  const signature = await signFallbackMigration(masterFallbackSecretKey, executor, userPayloadHash);
  await assertValidMigrationSignature(
    account.address,
    publicKeys,
    ownerInstance(account),
    executor,
    userPayloadHash,
    signature,
  );
  return RefundAuthorizationSchema.parse({
    format: "xochi.shielded.refund-authorization.v1",
    corridorId: corridor.corridorId,
    corridorRevision: corridor.corridorRevision,
    manifestDigest: corridor.manifestDigest,
    portal: corridor.token.immutables.portal,
    executor: executor.toString().toLowerCase(),
    destination: destinationAddress.toString().toLowerCase(),
    relayerTip: relayerTip.toString(),
    userPayload: `0x${executorCall.userPayload.toString("hex")}`,
    userPayloadHash: userPayloadHash.toString(),
    evidence,
    migrationSignature: signatureToJson(signature),
  });
}

export async function validateRefundAuthorization(
  account: RecipientAccount,
  corridor: Corridor,
  input: unknown,
): Promise<RefundAuthorization> {
  exactCorridor(corridor);
  const authorization = RefundAuthorizationSchema.parse(input);
  assertEvidence(account, authorization.evidence, corridor);
  if (authorization.relayerTip !== "0") {
    throw new Error("refund authorization requires a zero relayer tip");
  }
  if (
    authorization.corridorId !== corridor.corridorId ||
    authorization.manifestDigest !== corridor.manifestDigest ||
    authorization.portal !== corridor.token.immutables.portal ||
    authorization.executor !== corridor.oxide.plainWithdrawalExecutor
  ) {
    throw new Error("refund authorization does not match the pinned corridor");
  }
  const payload = Buffer.from(authorization.userPayload.slice(2), "hex");
  const decoded = decodePlainWithdrawalPayload(payload);
  if (
    decoded.recipient.toString().toLowerCase() !== authorization.destination ||
    decoded.relayerTip.toString() !== authorization.relayerTip ||
    getUserPayloadHash(payload).toString() !== authorization.userPayloadHash
  ) {
    throw new Error("refund destination commitment does not match the signed authorization");
  }
  const { publicKeys } = await deriveKeys(account.secret);
  await assertValidMigrationSignature(
    account.address,
    publicKeys,
    ownerInstance(account),
    EthAddress.fromString(authorization.executor),
    Fr.fromString(authorization.userPayloadHash),
    signatureFromJson(authorization.migrationSignature),
  );
  return authorization;
}

export function refundCalldata(bundle: RefundBundle): Hex {
  const common = {
    executor: bundle.executor as Hex,
    userPayload: bundle.userPayload as Hex,
    relayerPayload: `0x${"0".repeat(64)}` as Hex,
    amount: BigInt(bundle.evidence.amount),
    proof: bundle.proof as Hex,
    teeSignature: bundle.teeSignature as Hex,
  };
  switch (bundle.evidence.kind) {
    case "frozen-notes":
      return encodeFunctionData({
        abi: PORTAL_ABI,
        functionName: "refundFrozenNotes",
        args: [{ ...common, nullifiers: bundle.evidence.nullifiers as readonly Hex[] }],
      });
    case "frozen-deposits":
      return encodeFunctionData({
        abi: PORTAL_ABI,
        functionName: "refundFrozenDeposits",
        args: [{ ...common, nullifiers: bundle.evidence.nullifiers as readonly Hex[] }],
      });
    case "unprocessed-deposit":
      return encodeFunctionData({
        abi: PORTAL_ABI,
        functionName: "refundUnprocessedDeposit",
        args: [
          {
            ...common,
            siloedNullifier: bundle.evidence.siloedNullifier as Hex,
            messageHash: bundle.evidence.messageHash as Hex,
            messageLeafIndex: BigInt(bundle.evidence.messageLeafIndex),
          },
        ],
      });
  }
}

async function assertLiveRefundPins(rpcUrl: string, corridor: Corridor): Promise<void> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const portal = corridor.token.immutables.portal as Hex;
  const executor = corridor.oxide.plainWithdrawalExecutor as Hex;
  const [chainId, rollup, rollupVersion, l2Token, teeRegistry, cap, frozen, executorPortal] =
    await Promise.all([
      client.getChainId(),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "ROLLUP" }),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "ROLLUP_VERSION" }),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "L2_TOKEN" }),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "TEE_REGISTRY" }),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "TX_AMOUNT_CAP" }),
      client.readContract({ address: portal, abi: PORTAL_ABI, functionName: "$frozen" }),
      client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: "PORTAL" }),
    ]);
  const mismatch = [
    chainId !== Number(corridor.network.l1ChainId) && "chainId",
    rollup.toLowerCase() !== corridor.network.rollupAddress && "ROLLUP",
    rollupVersion !== BigInt(corridor.network.protocolVersion) && "ROLLUP_VERSION",
    l2Token.toLowerCase() !== corridor.token.address && "L2_TOKEN",
    teeRegistry.toLowerCase() !== corridor.oxide.teeRegistry && "TEE_REGISTRY",
    cap !== BigInt(corridor.token.immutables.maxNoteAmount) && "TX_AMOUNT_CAP",
    !frozen && "$frozen",
    executorPortal.toLowerCase() !== portal && "executor.PORTAL",
  ].filter((value): value is string => typeof value === "string");
  if (mismatch.length > 0) throw new Error(`refund live pin mismatch: ${mismatch.join(", ")}`);
}

export async function submitRefund(args: {
  account: RecipientAccount;
  corridor: Corridor;
  bundleInput: unknown;
  rawTransaction: string;
  rpcUrl: string;
  journal: OperationJournal;
  assertPins?: (rpcUrl: string, corridor: Corridor) => Promise<void>;
  send?: (rpcUrl: string, rawTransaction: Hex) => Promise<string>;
}): Promise<void> {
  const bundle = RefundBundleSchema.parse(args.bundleInput);
  const {
    proof: _proof,
    teeSignature: _teeSignature,
    format: _bundleFormat,
    ...authorizationFields
  } = bundle;
  await validateRefundAuthorization(args.account, args.corridor, {
    ...authorizationFields,
    format: "xochi.shielded.refund-authorization.v1",
  });
  await (args.assertPins ?? assertLiveRefundPins)(args.rpcUrl, args.corridor);
  const rawTransaction = hexBytes.parse(args.rawTransaction) as Hex;
  const calldata = refundCalldata(bundle);
  const parsed = parseTransaction(rawTransaction);
  if (
    parsed.chainId !== Number(args.corridor.network.l1ChainId) ||
    parsed.to?.toLowerCase() !== bundle.portal ||
    (parsed.value ?? 0n) !== 0n ||
    parsed.data?.toLowerCase() !== calldata.toLowerCase()
  ) {
    throw new Error("signed refund transaction does not exactly match the authorized portal call");
  }
  const txHash = keccak256(rawTransaction);
  const operation = args.journal.beginBroadcast(
    `refund-${bundle.evidence.kind}`,
    {
      bundleDigest: keccak256(Buffer.from(JSON.stringify(bundle))),
      calldataHash: keccak256(calldata),
      portal: bundle.portal,
      kind: bundle.evidence.kind,
    },
    txHash,
  );
  const send = args.send ?? sendRawTransactionOnce;
  try {
    if ((await send(args.rpcUrl, rawTransaction)).toLowerCase() !== txHash) {
      throw new Error("L1 node returned a different refund transaction hash");
    }
  } catch {
    throw args.journal.failOrAbort(operation.id);
  }
}

async function sendRawTransactionOnce(rpcUrl: string, rawTransaction: Hex): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [rawTransaction],
    }),
    redirect: "error",
  });
  if (!response.ok) throw new Error("L1 refund submission transport failed");
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (typeof body.result !== "string" || body.error !== undefined) {
    throw new Error("L1 refund submission outcome is ambiguous");
  }
  return body.result;
}

export type RefundReconciliationObservation = {
  chainId: number;
  transaction: {
    hash: Hex;
    to: Hex | null;
    input: Hex;
    value: bigint;
    blockNumber: bigint | null;
    blockHash: Hex | null;
  };
  receipt: {
    transactionHash: Hex;
    status: "success" | "reverted";
    blockNumber: bigint;
    blockHash: Hex;
  };
  canonicalBlock: {
    number: bigint;
    hash: Hex;
  };
  finalizedBlockNumber: bigint;
};

export function applyRefundReconciliation(
  journal: OperationJournal,
  corridor: Corridor,
  observation: RefundReconciliationObservation,
): "finalized" | "finalized-failed" {
  exactCorridor(corridor);
  const operation = journal.activeUnresolved();
  if (!operation || !operation.kind.startsWith("refund-")) {
    throw new Error("no exact lock-owned unresolved refund operation");
  }
  if (!operation.txHash) throw new Error("refund has no transaction hash; keep it blocked");
  const immutableEvidenceMatches =
    observation.chainId === Number(corridor.network.l1ChainId) &&
    observation.transaction.hash.toLowerCase() === operation.txHash.toLowerCase() &&
    observation.receipt.transactionHash.toLowerCase() === operation.txHash.toLowerCase() &&
    observation.transaction.to?.toLowerCase() === operation.request.portal &&
    observation.transaction.value === 0n &&
    keccak256(observation.transaction.input).toLowerCase() === operation.request.calldataHash &&
    observation.transaction.blockNumber === observation.receipt.blockNumber &&
    observation.transaction.blockHash?.toLowerCase() ===
      observation.receipt.blockHash.toLowerCase() &&
    observation.canonicalBlock.number === observation.receipt.blockNumber &&
    observation.canonicalBlock.hash.toLowerCase() === observation.receipt.blockHash.toLowerCase();
  if (!immutableEvidenceMatches) {
    throw new Error("refund transaction evidence does not match the locked authorization");
  }
  if (observation.receipt.blockNumber > observation.finalizedBlockNumber) {
    throw new Error("refund transaction is not finalized; keep it blocked");
  }
  const receiptEvidence = {
    receiptBlockNumber: observation.receipt.blockNumber.toString(),
    receiptBlockHash: observation.receipt.blockHash,
  };
  if (observation.receipt.status === "reverted") {
    journal.update(operation.id, {
      status: "failed",
      receiptStatus: "finalized-failed",
      error: "operation finalized with a reverted receipt",
      ...receiptEvidence,
    });
    return "finalized-failed";
  }
  journal.update(operation.id, {
    status: "complete",
    receiptStatus: "finalized",
    ...receiptEvidence,
  });
  return "finalized";
}

export async function reconcileRefund(
  journal: OperationJournal,
  rpcUrl: string,
  corridor: Corridor,
): Promise<"finalized" | "finalized-failed"> {
  exactCorridor(corridor);
  const operation = journal.activeUnresolved();
  if (!operation || !operation.kind.startsWith("refund-") || !operation.txHash) {
    throw new Error("no exact lock-owned unresolved refund operation");
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  try {
    const [chainId, transaction, receipt, finalized] = await Promise.all([
      client.getChainId(),
      client.getTransaction({ hash: operation.txHash as Hex }),
      client.getTransactionReceipt({ hash: operation.txHash as Hex }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonicalBlock.hash === null) {
      throw new Error("refund transaction evidence is unavailable; keep it blocked");
    }
    return applyRefundReconciliation(journal, corridor, {
      chainId,
      transaction: {
        hash: transaction.hash,
        to: transaction.to,
        input: transaction.input,
        value: transaction.value,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
      },
      receipt: {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      },
      canonicalBlock: {
        number: canonicalBlock.number,
        hash: canonicalBlock.hash,
      },
      finalizedBlockNumber: finalized.number,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "refund transaction is not finalized; keep it blocked" ||
        error.message === "refund transaction evidence does not match the locked authorization")
    ) {
      throw error;
    }
    throw new Error("refund transaction evidence is unavailable; keep it blocked");
  }
}
