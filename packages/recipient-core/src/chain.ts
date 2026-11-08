// Every Aztec node and PXE operation the tool performs goes through `AztecPort`. The live
// port runs it on an `EmbeddedWallet` (aztec.js 6.0.0) against the node the recipient chose;
// the dry-run port records the same calls, in the same order, and performs none of them. The
// commands (`commands.ts`) run unchanged on either, so `--dry-run` shows the exact sequence a
// live run makes.

import { NO_FROM } from "@aztec-labs/aztec.js/account";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { BatchCall, Contract, toSimulateOptions } from "@aztec-labs/aztec.js/contracts";
import { FeeJuicePaymentMethodWithClaim, type FeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";
import { ContractInitializationStatus } from "@aztec-labs/aztec.js/wallet";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { EthAddress } from "@aztec-labs/stdlib/block";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { TxHash, TxStatus } from "@aztec-labs/stdlib/tx";
import { bytesToHex } from "@noble/hashes/utils";
// The vendored finalization-data codec reads a Buffer; Aztec takes it from the `buffer` package.
import { Buffer } from "buffer";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";

import type { RecipientAccount } from "./account.js";
import type { Corridor } from "./corridor.js";
import type { ObservedNetwork } from "./network.js";
import type { OperationJournal, OperationRecord } from "./operation-journal.js";
import { createSingleAttemptAztecNodeBroadcaster, NodeSubmission } from "./node-submission.js";
import type { AttestationVerifier, HttpFetch } from "./ports.js";
import type { WalletStorage } from "./wallet-storage.js";
import { durablyIncluded } from "./reconciliation.js";
import {
  createSubmissionDiagnosticState,
  safeOperationError,
  type SubmissionDiagnosticState,
} from "./safe-diagnostic.js";
import { assertL1Pinned, OxideFleetRegistry, viemL1Reader } from "./oxide/enclave.js";
import { oxidePins } from "./oxide/pins.js";
import { transferEventMetadata } from "./oxide-token.js";
import { buildPlainWithdrawal } from "./oxide/vendor/oxide-client/executors/plain_withdrawal_executor.js";
import { plainWithdrawalNetAmount } from "./oxide/vendor/oxide-lib/plain_withdrawal_executor.js";
import { FleetSigner } from "./oxide/vendor/oxide-client/fleet_signer.js";
import { buildSeedCapsule } from "./oxide/vendor/oxide-client/capsules.js";
import {
  submit,
  getTransferMetaLen,
  type Operation,
  type SubmitResult,
} from "./oxide/vendor/oxide-client/l2_operations.js";
import type { L1OperationBroadcaster } from "./oxide/vendor/oxide-client/broadcaster_calls.js";
import { buildSpendMetadata } from "./oxide/vendor/oxide-client/spend_metadata.js";
import {
  registerOxideTokenWithArtifact,
  isOxideTokenLockedToArtifact,
} from "./oxide/vendor/oxide-client/token_registration.js";
import {
  tokenImmutablesAbiArg,
  type OxideTokenImmutables,
} from "./oxide/vendor/oxide-lib/token_immutables.js";
import {
  computeL1OperationId,
  L1OperationCondition,
} from "./oxide/vendor/oxide-lib/l1_operation_calldata.js";
import {
  decodeFinalizationData,
  encodeFinalizationData,
} from "./oxide/vendor/oxide-lib/withdrawal_finalization_data.js";

/** A Fee Juice claim bridged from L1 to the recipient account, supplied by Xochi (sponsored). */
export interface FeeJuiceClaim {
  claimAmount: string;
  claimSecret: string;
  messageLeafIndex: string;
}

export interface ReceivedTransfer {
  from: string;
  to: string;
  amount: bigint;
  meta: bigint[];
  txHash: string;
  blockNumber: number;
}

/** What the node's `getTxReceipt` says about one transaction. */
export interface ObservedTxReceipt {
  status: TxStatus;
  /** Null until the transaction is in a block. */
  blockNumber: number | null;
  /** The including block's hash; null until the transaction is in a block. */
  blockHash: string | null;
  executionSucceeded: boolean;
}

export interface ExitRequest {
  l1Recipient: string;
  amount: bigint;
  proverTip: bigint;
  relayerTip: bigint;
  maxExecutorFee: bigint;
  broadcasterArtifact: ContractArtifact;
  /** Pays the exit's fee by claiming bridged Fee Juice in the same tx (mainnet has no sponsored FPC). */
  feeJuiceClaim?: FeeJuiceClaim;
}

export interface WithdrawalRecord {
  txHash: string;
  withdrawalIndex: number;
  /** The broadcast finalization request's L1 operation id; null if none was broadcast. */
  operationId: string | null;
  /** `encodeFinalizationData` of the enclave-signed finalization data, 0x hex. */
  finalizationData: string;
}

export interface ExitResult {
  txHash: string;
  /** Decimal base units read from the deployed executor immediately before submission. */
  executorFee: string | null;
  /** Decimal base units the L1 recipient receives after prover tip, executor fee and relayer tip. */
  recipientAmount: string | null;
  withdrawals: WithdrawalRecord[];
}

export interface AztecPort {
  readonly mode: "live" | "dry-run";
  /** Network identity; `node_getNodeInfo` and block 1's header. */
  observeNetwork(): Promise<ObservedNetwork>;
  /** Adds the account to the PXE (`createSchnorrAccount`). */
  addAccount(account: RecipientAccount): Promise<void>;
  accountState(address: AztecAddress): Promise<{ initialized: boolean; published: boolean }>;
  /**
   * Publishes the instance and runs the constructor; returns the tx hash. `beforeSubmit` runs
   * with the tx hash before the node can receive it (its record must be durable when it resolves).
   */
  deployAccount(
    account: RecipientAccount,
    claim: FeeJuiceClaim | null,
    beforeSubmit?: (txHash: string) => Promise<void>,
  ): Promise<string>;
  registerSender(sender: AztecAddress): Promise<void>;
  registeredSenders(): Promise<string[]>;
  tokenLockedToArtifact(artifact: ContractArtifact, token: AztecAddress): Promise<boolean>;
  /** `registerContract` plus `store_immutables` (a utility call, no tx). */
  registerToken(
    artifact: ContractArtifact,
    immutables: OxideTokenImmutables,
    token: AztecAddress,
  ): Promise<void>;
  balance(artifact: ContractArtifact, token: AztecAddress, owner: AztecAddress): Promise<bigint>;
  transfers(
    artifact: ContractArtifact,
    token: AztecAddress,
    owner: AztecAddress,
  ): Promise<ReceivedTransfer[]>;
  /**
   * A transfer through the enclave-signed path; returns the tx hash. `claim` pays the fee by
   * claiming bridged Fee Juice in the same tx (Xochi-sponsored); null pays from own Fee Juice.
   */
  spend(
    account: RecipientAccount,
    artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
    claim?: FeeJuiceClaim | null,
  ): Promise<string>;
  /** The node's latest block number (`node.getBlockNumber`). */
  blockNumber(): Promise<number>;
  /** The node's receipt for `txHash` (`node.getTxReceipt`). */
  txReceipt(txHash: string): Promise<ObservedTxReceipt>;
  /**
   * Simulates, in this PXE only, a private transfer of `amount` from `account` to `to`: the
   * simulate pass of the enclave-signed path, without the enclave, a proof or a send. Throws if
   * this account's notes cannot pay it.
   */
  simulateTransfer(
    account: RecipientAccount,
    artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
  ): Promise<void>;
  /**
   * A withdrawal to L1 through the enclave-signed path. Returns the tx hash and, per
   * withdrawal, the finalization data and the broadcast L1 operation id: the record anyone
   * needs to finalize it on L1.
   */
  exit(
    account: RecipientAccount,
    artifact: ContractArtifact,
    request: ExitRequest,
  ): Promise<ExitResult>;
  close(): Promise<void>;
}

export async function failOrAbortWithSafeDiagnostic(
  journal: OperationJournal,
  operationId: string,
  error: unknown,
  diagnosticState: SubmissionDiagnosticState,
): Promise<Error> {
  const initialMessage = diagnosticState.submissionBoundaryReached
    ? "operation outcome requires transaction reconciliation"
    : "operation failed before Aztec node submission";
  const safeError = safeOperationError(initialMessage, error, diagnosticState);
  try {
    const journalError = await journal.failOrAbort(
      operationId,
      diagnosticState.submissionBoundaryReached,
    );
    return safeOperationError(journalError.message, safeError, diagnosticState);
  } catch {
    const cleanupMessage = diagnosticState.submissionBoundaryReached
      ? "operation journal update failed after Aztec node submission; reconciliation remains required"
      : "operation journal abort or lock release failed before Aztec node submission; restart before moving funds";
    return safeOperationError(cleanupMessage, safeError, diagnosticState);
  }
}

export async function sanitizeFundMovementFailure(
  journal: OperationJournal,
  operation: OperationRecord | null,
  error: unknown,
  diagnosticState: SubmissionDiagnosticState,
): Promise<Error> {
  return operation === null
    ? safeOperationError(
        "recipient operation failed before Aztec node submission",
        error,
        diagnosticState,
      )
    : failOrAbortWithSafeDiagnostic(journal, operation.id, error, diagnosticState);
}

export async function beginExitAfterExecutorFeeCheck(
  journal: OperationJournal,
  accountAddress: string,
  request: ExitRequest,
  executorFee: bigint,
): Promise<{ operation: OperationRecord; recipientAmount: bigint }> {
  if (executorFee > request.maxExecutorFee) {
    throw new Error("live executor fee exceeds --max-executor-fee; exit not started");
  }
  const netAmount = plainWithdrawalNetAmount(request.amount, request.proverTip, executorFee);
  if (request.relayerTip >= netAmount) {
    throw new Error(
      `--relayer-tip must be less than the post-fee amount ${netAmount}; the recipient must receive funds`,
    );
  }
  const recipientAmount = netAmount - request.relayerTip;
  const operation = await journal.begin("exit", {
    from: accountAddress,
    l1Recipient: request.l1Recipient,
    amount: request.amount.toString(),
    proverTip: request.proverTip.toString(),
    relayerTip: request.relayerTip.toString(),
    maxExecutorFee: request.maxExecutorFee.toString(),
    executorFee: executorFee.toString(),
    recipientAmount: recipientAmount.toString(),
  });
  return { operation, recipientAmount };
}

function feeJuiceClaimPayment(
  account: RecipientAccount,
  claim: FeeJuiceClaim,
): FeeJuicePaymentMethodWithClaim {
  return new FeeJuicePaymentMethodWithClaim(account.address, {
    claimAmount: BigInt(claim.claimAmount),
    claimSecret: Fr.fromString(claim.claimSecret),
    messageLeafIndex: BigInt(claim.messageLeafIndex),
  });
}

/**
 * The L1 operation id of an exit withdrawal's broadcast finalization request: the operation
 * `buildFinalizationRequestOperation` builds (portal target, payout token, the encoded
 * finalization data as calldata, message-in-outbox condition) for the exit transaction `txHash`.
 */
export function finalizationRequestOperationId(
  corridor: Corridor,
  finalizationData: string,
  txHash: string,
): string {
  const decoded = decodeFinalizationData(Buffer.from(finalizationData.slice(2), "hex"));
  return computeL1OperationId(
    {
      target: EthAddress.fromString(corridor.token.immutables.portal),
      payoutToken: EthAddress.fromString(corridor.oxide.payoutToken),
      calldata: encodeFinalizationData(decoded),
      condition: L1OperationCondition.messageInOutbox(),
    },
    TxHash.fromString(txHash),
  );
}

type JournaledWithdrawal = NonNullable<OperationRecord["withdrawals"]>[number];

/** An exit's journaled withdrawals, each naming its L1 operation id (derived where absent). */
export function withdrawalsWithOperationIds(
  corridor: Corridor,
  withdrawals: readonly JournaledWithdrawal[],
  txHash: string,
): (JournaledWithdrawal & { operationId: string | null })[] {
  return withdrawals.map((withdrawal) => ({
    ...withdrawal,
    operationId:
      withdrawal.operationId === undefined
        ? finalizationRequestOperationId(corridor, withdrawal.finalizationData, txHash)
        : withdrawal.operationId,
  }));
}

/**
 * The `NodeSubmission` hook spend and exit run before `sendTx`: the operation's record names the
 * transaction hash and is durable (the `update` resolved) before the node can receive it. An
 * exit's record also names each prepared withdrawal's L1 operation id (it needs the hash), so a
 * crash after the broadcast keeps it.
 */
export function recordBroadcastBeforeSend(
  journal: OperationJournal,
  operationId: string,
  corridor: Corridor,
): (txHash: TxHash) => Promise<void> {
  return async (txHash) => {
    const hash = txHash.toString();
    const { kind, withdrawals } = await journal.get(operationId);
    await journal.update(operationId, {
      status: "broadcast",
      txHash: hash,
      ...(kind === "exit" && withdrawals
        ? { withdrawals: withdrawalsWithOperationIds(corridor, withdrawals, hash) }
        : {}),
    });
  };
}

export interface LiveAztecOptions {
  nodeUrl: string;
  /** Where the PXE and wallet DB live; `scope` names this recipient's stores. */
  walletStorage: WalletStorage;
  scope: string;
  corridor: Corridor;
  /** Read only by spend and exit (TeeRegistry, portal and executor reads). */
  l1RpcUrl: string | null;
  /** The fund-movement journal spend and exit write before any broadcast. */
  journal: OperationJournal;
  /** Checks the enclave's Nitro attestation before any key is sealed to it. */
  attestation: AttestationVerifier;
  /** The single-attempt `sendTx` and L1 reads; defaults to the global `fetch`. */
  fetch?: HttpFetch;
}

/**
 * Live port. Node reads go through the Aztec SDK's retrying JSON-RPC client (global `fetch`);
 * the one write, `sendTx`, through the single-attempt transport (`NodeSubmission`).
 */
export class LiveAztec implements AztecPort {
  readonly mode = "live";
  private readonly corridor: Corridor;
  private readonly l1RpcUrl: string | null;
  private readonly operationJournal: OperationJournal;
  private readonly attestation: AttestationVerifier;
  private readonly fetchImpl: HttpFetch | undefined;

  private constructor(
    private readonly wallet: EmbeddedWallet,
    private readonly node: AztecNode,
    private readonly nodeSubmission: NodeSubmission,
    options: LiveAztecOptions,
  ) {
    this.corridor = options.corridor;
    this.l1RpcUrl = options.l1RpcUrl;
    this.operationJournal = options.journal;
    this.attestation = options.attestation;
    this.fetchImpl = options.fetch;
  }

  static async connect(options: LiveAztecOptions): Promise<LiveAztec> {
    const rawNode = createAztecNodeClient(options.nodeUrl);
    const nodeSubmission = new NodeSubmission(
      rawNode,
      createSingleAttemptAztecNodeBroadcaster(options.nodeUrl, options.fetch),
    );
    const network = options.corridor.network;
    const storage = await options.walletStorage.embeddedWalletOptions(options.scope, {
      l1ChainId: Number(network.l1ChainId),
      rollupAddress: network.rollupAddress,
    });
    let wallet: EmbeddedWallet;
    try {
      wallet = await EmbeddedWallet.create(nodeSubmission.node, {
        pxe: { ...storage.pxe, proverEnabled: true },
        walletDb: storage.walletDb,
      });
    } catch (error) {
      // The stores were opened for this wallet (browser: they hold OPFS pool locks).
      const closing = await Promise.allSettled(
        [storage.pxe.store, storage.walletDb.store].map((store) => store?.close()),
      );
      const failures = closing.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], "wallet creation and store close failed");
      }
      throw error;
    }
    return new LiveAztec(wallet, nodeSubmission.node, nodeSubmission, options);
  }

  async blockNumber(): Promise<number> {
    return Number(await this.node.getBlockNumber());
  }

  async observeNetwork(): Promise<ObservedNetwork> {
    const [info, block1] = await Promise.all([
      this.node.getNodeInfo(),
      this.node.getBlockData(BlockNumber(1)),
    ]);
    if (!block1) throw new Error("the node has no block 1; it cannot prove the network identity");
    return {
      l1ChainId: String(info.l1ChainId),
      rollupVersion: String(info.rollupVersion),
      rollupAddress: info.l1ContractAddresses.rollupAddress.toString(),
      block1LastArchiveRoot: block1.header.lastArchive.root.toString(),
      nodeVersion: info.nodeVersion,
    };
  }

  async addAccount(account: RecipientAccount): Promise<void> {
    const manager = await this.wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    );
    if (!manager.address.equals(account.address)) {
      throw new Error(
        `the wallet derived ${manager.address.toString()}, not ${account.address.toString()}`,
      );
    }
  }

  async accountState(address: AztecAddress): Promise<{ initialized: boolean; published: boolean }> {
    const metadata = await this.wallet.getContractMetadata(address);
    return {
      initialized: metadata.initializationStatus === ContractInitializationStatus.INITIALIZED,
      published: metadata.isContractPublished,
    };
  }

  async deployAccount(
    account: RecipientAccount,
    claim: FeeJuiceClaim | null,
    beforeSubmit?: (txHash: string) => Promise<void>,
  ): Promise<string> {
    const manager = await this.wallet.createSchnorrAccount(
      account.secret,
      account.salt,
      account.signingKey,
    );
    const deploy = await manager.getDeployMethod();
    const paymentMethod = claim ? feeJuiceClaimPayment(account, claim) : undefined;
    const send = () =>
      deploy.send({
        from: NO_FROM,
        fee: paymentMethod ? { paymentMethod } : {},
        // The stock class is already published on Aztec mainnet; the instance is not, and
        // RecipientDeployment needs it published and initialized (pxe-bridge aztec-client.ts).
        skipClassPublication: true,
        skipInstancePublication: false,
      });
    const result = beforeSubmit
      ? await this.nodeSubmission.run(
          async (txHash) => beforeSubmit(txHash.toString()),
          send,
          createSubmissionDiagnosticState("deploy"),
        )
      : await send();
    return result.receipt.txHash.toString();
  }

  async registerSender(sender: AztecAddress): Promise<void> {
    await this.wallet.registerSender(sender, `corridor-sender-${sender.toString().slice(0, 10)}`);
  }

  async registeredSenders(): Promise<string[]> {
    return (await this.wallet.getAddressBook()).map((entry) => entry.item.toString().toLowerCase());
  }

  tokenLockedToArtifact(artifact: ContractArtifact, token: AztecAddress): Promise<boolean> {
    return isOxideTokenLockedToArtifact(this.node, artifact, token);
  }

  async registerToken(
    artifact: ContractArtifact,
    immutables: OxideTokenImmutables,
    token: AztecAddress,
  ): Promise<void> {
    await registerOxideTokenWithArtifact(this.wallet, artifact, immutables, token);
  }

  async balance(
    artifact: ContractArtifact,
    token: AztecAddress,
    owner: AztecAddress,
  ): Promise<bigint> {
    const contract = Contract.at(token, artifact, this.wallet);
    const { result } = await contract.methods["balance_of"]!(owner).simulate({ from: owner });
    return BigInt(result as bigint);
  }

  async transfers(
    artifact: ContractArtifact,
    token: AztecAddress,
    owner: AztecAddress,
  ): Promise<ReceivedTransfer[]> {
    const events = await this.wallet.getPrivateEvents<{
      from: AztecAddress;
      to: AztecAddress;
      amount: bigint;
      meta: bigint[];
    }>(await transferEventMetadata(artifact), { contractAddress: token, scopes: [owner] });
    return events
      .filter((e) => e.event.to.equals(owner))
      .map((e) => ({
        from: e.event.from.toString(),
        to: e.event.to.toString(),
        amount: BigInt(e.event.amount),
        meta: e.event.meta.map((f) => BigInt(f)),
        txHash: e.metadata.txHash.toString(),
        blockNumber: Number(e.metadata.l2BlockNumber),
      }));
  }

  async txReceipt(txHash: string): Promise<ObservedTxReceipt> {
    const receipt = await this.node.getTxReceipt(TxHash.fromString(txHash));
    return {
      status: receipt.status,
      blockNumber: receipt.isMined() ? Number(receipt.blockNumber) : null,
      blockHash: receipt.isMined() ? receipt.blockHash.toString() : null,
      executionSucceeded: receipt.hasExecutionSucceeded(),
    };
  }

  async simulateTransfer(
    account: RecipientAccount,
    artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
  ): Promise<void> {
    // `submit`'s own simulate pass (seed capsule, no strict mode, no note signatures): it needs
    // no enclave and sends no key, and it fails unless this PXE holds notes that pay `amount`.
    // Called on the wallet directly, not through the fund-movement sentinel, so the receipt's
    // local error names the cause; nothing moves funds here.
    const contract = Contract.at(
      AztecAddress.fromStringUnsafe(this.corridor.token.address),
      artifact,
      this.wallet,
    );
    const meta = Array(getTransferMetaLen(artifact)).fill(Fr.ZERO);
    const payload = await new BatchCall(this.wallet, [
      contract.methods["transfer"]!(account.address, to, amount, meta, Fr.ZERO),
    ]).request({ capsules: [buildSeedCapsule(contract.address)] });
    await this.wallet.simulateTx(payload, toSimulateOptions({ from: account.address }));
  }

  private async oxideSigner(): Promise<FleetSigner> {
    if (!this.l1RpcUrl) {
      throw new Error("spend and exit need --l1-rpc: the enclave's registration is read from L1");
    }
    const pins = oxidePins(this.corridor);
    const reader = viemL1Reader(this.l1RpcUrl, pins, this.fetchImpl);
    await assertL1Pinned(reader, pins);
    return FleetSigner.connect(
      pins.enclaveUrl,
      new OxideFleetRegistry(reader, pins, this.attestation),
    );
  }

  private async submitOperations(
    account: RecipientAccount,
    artifact: ContractArtifact,
    build: (contract: Contract) => Operation[],
    operation: OperationRecord,
    diagnosticState: SubmissionDiagnosticState,
    paymentMethod?: FeePaymentMethod,
  ): Promise<SubmitResult> {
    if (operation.kind !== diagnosticState.operationKind) {
      throw new Error("operation kind does not match its submission diagnostic");
    }
    try {
      const contract = Contract.at(
        AztecAddress.fromStringUnsafe(this.corridor.token.address),
        artifact,
        this.wallet,
      );
      const signer = await this.oxideSigner();
      // #740: the spend metadata carries this account's master nullifier hiding key to the
      // zk.money enclave, which needs it to check the spent notes.
      const spend = await buildSpendMetadata({
        secret: account.secret,
        salt: account.salt,
        signingKey: account.signingKey,
        creationTxHash: TxHash.zero(),
      });
      const submitOperation = () =>
        submit({ wallet: this.wallet, chain: this.node, paymentMethod }, account.address, {
          contract,
          signer,
          operations: build(contract),
          resolveSpendMetadata: async (nullified) => {
            if (!nullified.owner.equals(account.address))
              throw new Error("spent note is not this account's");
            return { ...spend, creationTxHash: nullified.creationTxHash };
          },
          resolveDepositSpendMetadata: async (recipient) => {
            if (!recipient.equals(account.address))
              throw new Error("spent deposit is not this account's");
            return {
              ownerAddressPreimage: spend.ownerAddressPreimage,
              masterNullifierHidingKey: spend.masterNullifierHidingKey,
            };
          },
          onPhase: (phase) => {
            diagnosticState.phase = phase;
          },
          onPreparedWithdrawals: async (withdrawals) => {
            await this.operationJournal.update(operation.id, {
              withdrawals: withdrawals.map(({ withdrawalIndex, finalizationData }) => ({
                withdrawalIndex,
                finalizationData: `0x${bytesToHex(encodeFinalizationData(finalizationData))}`,
              })),
            });
          },
        });

      return await this.nodeSubmission.run(
        recordBroadcastBeforeSend(this.operationJournal, operation.id, this.corridor),
        submitOperation,
        diagnosticState,
      );
    } catch (error) {
      throw safeOperationError(
        diagnosticState.submissionBoundaryReached
          ? "operation outcome requires transaction reconciliation"
          : "recipient operation failed before Aztec node submission",
        error,
        diagnosticState,
      );
    }
  }

  async spend(
    account: RecipientAccount,
    artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
    claim: FeeJuiceClaim | null = null,
  ): Promise<string> {
    const diagnosticState = createSubmissionDiagnosticState("spend");
    let operation: OperationRecord | null = null;
    try {
      operation = await this.operationJournal.begin("spend", {
        from: account.address.toString(),
        to: to.toString(),
        amount: amount.toString(),
      });
      const result = await this.submitOperations(
        account,
        artifact,
        (contract) => [
          {
            kind: "transfer",
            from: account.address,
            to,
            amount,
            meta: Array(getTransferMetaLen(contract.artifact)).fill(Fr.ZERO),
          },
        ],
        operation,
        diagnosticState,
        claim ? feeJuiceClaimPayment(account, claim) : undefined,
      );
      if (!durablyIncluded(result.receipt.status)) {
        throw new Error("Aztec transaction receipt is not durably included");
      }
      const txHash = result.receipt.txHash.toString();
      await this.operationJournal.update(operation.id, { status: "complete", txHash });
      return txHash;
    } catch (error) {
      throw await sanitizeFundMovementFailure(
        this.operationJournal,
        operation,
        error,
        diagnosticState,
      );
    }
  }

  async exit(
    account: RecipientAccount,
    artifact: ContractArtifact,
    request: ExitRequest,
  ): Promise<ExitResult> {
    const diagnosticState = createSubmissionDiagnosticState("exit");
    let operation: OperationRecord | null = null;
    try {
      if (!this.l1RpcUrl) {
        throw new Error("exit needs --l1-rpc: the executor's fee is read from L1");
      }
      const broadcasterAddress = AztecAddress.fromStringUnsafe(this.corridor.oxide.l2Broadcaster);
      // The broadcaster artifact is the caller's file: it is used only if its class is the class
      // of the deployment's broadcaster instance on the pinned node.
      const [instance, klass] = await Promise.all([
        this.node.getContract(broadcasterAddress),
        getContractClassFromArtifact(request.broadcasterArtifact),
      ]);
      if (!instance || !instance.currentContractClassId.equals(klass.id)) {
        throw new Error(
          `broadcaster artifact class ${klass.id.toString()} is not the class of ${broadcasterAddress.toString()}`,
        );
      }
      // PXE simulates the finalization-request broadcast call, so the verified instance must
      // be registered with this artifact first (oxide-client broadcaster.ts does the same).
      await this.wallet.registerContract(instance, request.broadcasterArtifact);
      const executor = this.corridor.oxide.plainWithdrawalExecutor as Hex;
      const executorFee = await createPublicClient({
        transport: http(this.l1RpcUrl, { fetchFn: this.fetchImpl }),
      }).readContract({
        address: executor,
        abi: parseAbi(["function FEE() view returns (uint256)"]),
        functionName: "FEE",
      });
      const prepared = await beginExitAfterExecutorFeeCheck(
        this.operationJournal,
        account.address.toString(),
        request,
        executorFee,
      );
      operation = prepared.operation;
      const broadcaster = Contract.at(broadcasterAddress, request.broadcasterArtifact, this.wallet);
      const result = await this.submitOperations(
        account,
        artifact,
        () => [
          buildPlainWithdrawal({
            from: account.address,
            executor: { address: EthAddress.fromString(executor), fee: executorFee },
            recipient: EthAddress.fromString(request.l1Recipient),
            relayerTip: request.relayerTip,
            amount: request.amount,
            proverTip: request.proverTip,
            finalizationRequestBroadcastParams: {
              broadcaster: broadcaster as unknown as L1OperationBroadcaster,
              portal: EthAddress.fromString(this.corridor.token.immutables.portal),
              payoutToken: EthAddress.fromString(this.corridor.oxide.payoutToken),
            },
          }),
        ],
        operation,
        diagnosticState,
        request.feeJuiceClaim ? feeJuiceClaimPayment(account, request.feeJuiceClaim) : undefined,
      );
      if (!durablyIncluded(result.receipt.status)) {
        throw new Error("Aztec transaction receipt is not durably included");
      }
      const txHash = result.receipt.txHash.toString();
      const response = {
        txHash,
        executorFee: executorFee.toString(),
        recipientAmount: prepared.recipientAmount.toString(),
        withdrawals: result.withdrawals.map((w) => ({
          txHash,
          withdrawalIndex: w.withdrawalIndex,
          operationId: w.finalizationRequest?.operationId ?? null,
          finalizationData: `0x${bytesToHex(encodeFinalizationData(w.finalizationData))}`,
        })),
      };
      await this.operationJournal.update(operation.id, {
        status: "complete",
        txHash,
        withdrawals: response.withdrawals.map(
          ({ withdrawalIndex, finalizationData, operationId }) => ({
            withdrawalIndex,
            finalizationData,
            operationId,
          }),
        ),
      });
      return response;
    } catch (error) {
      throw await sanitizeFundMovementFailure(
        this.operationJournal,
        operation,
        error,
        diagnosticState,
      );
    }
  }

  async close(): Promise<void> {
    await this.wallet.stop();
  }
}

/**
 * Dry-run port: records every call with its arguments and performs none. Reads return what a
 * fresh recipient on the pinned network would see (the pinned identity, an unknown account,
 * no senders, a zero balance), each marked as synthetic in the log.
 */
export class DryRunAztec implements AztecPort {
  readonly mode = "dry-run";
  readonly calls: string[] = [];
  private readonly senders: string[] = [];

  constructor(private readonly corridor: Corridor) {}

  private record(call: string): void {
    this.calls.push(call);
  }

  async observeNetwork(): Promise<ObservedNetwork> {
    this.record("node.getNodeInfo() (synthetic: the pinned identity, node 6.0.0)");
    this.record("node.getBlockData(1)");
    const n = this.corridor.network;
    return {
      l1ChainId: n.l1ChainId,
      rollupVersion: n.protocolVersion,
      rollupAddress: n.rollupAddress,
      block1LastArchiveRoot: n.genesisOrNetworkDigest,
      nodeVersion: "6.0.0",
    };
  }

  async addAccount(account: RecipientAccount): Promise<void> {
    this.record(
      `wallet.createSchnorrAccount(secret, salt, signingKey) -> ${account.address.toString()}`,
    );
  }

  async accountState(address: AztecAddress): Promise<{ initialized: boolean; published: boolean }> {
    this.record(`wallet.getContractMetadata(${address.toString()}) (synthetic: not deployed)`);
    return { initialized: false, published: false };
  }

  async deployAccount(
    account: RecipientAccount,
    claim: FeeJuiceClaim | null,
    beforeSubmit?: (txHash: string) => Promise<void>,
  ): Promise<string> {
    await beforeSubmit?.(`0x${"00".repeat(32)}`);
    this.record(
      `accountManager.getDeployMethod().send({ from: NO_FROM, fee: ${
        claim
          ? `FeeJuicePaymentMethodWithClaim(${account.address.toString()}, claim of ${claim.claimAmount})`
          : "own fee juice"
      }, skipClassPublication: true, skipInstancePublication: false })`,
    );
    return `0x${"00".repeat(32)}`;
  }

  async registerSender(sender: AztecAddress): Promise<void> {
    this.record(
      `wallet.registerSender(${sender.toString()}) = pxe.registerTaggingSecretSource({ kind: "address-derived" })`,
    );
    this.senders.push(sender.toString().toLowerCase());
  }

  async registeredSenders(): Promise<string[]> {
    this.record("wallet.getAddressBook()");
    return [...this.senders];
  }

  async tokenLockedToArtifact(artifact: ContractArtifact, token: AztecAddress): Promise<boolean> {
    this.record(
      `isOxideTokenLockedToArtifact(node, ${artifact.name}, ${token.toString()}): node.getContract + node.getPublicStorageAt (synthetic: locked)`,
    );
    return true;
  }

  async registerToken(
    artifact: ContractArtifact,
    immutables: OxideTokenImmutables,
    token: AztecAddress,
  ): Promise<void> {
    this.record(`wallet.registerContract(instance ${token.toString()}, ${artifact.name})`);
    const arg = JSON.stringify(tokenImmutablesAbiArg(immutables), (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    this.record(`token.methods.store_immutables(${arg}).simulate({ from: NO_FROM })`);
  }

  async balance(
    _artifact: ContractArtifact,
    token: AztecAddress,
    owner: AztecAddress,
  ): Promise<bigint> {
    this.record(
      `token(${token.toString()}).methods.balance_of(${owner.toString()}).simulate() (synthetic: 0)`,
    );
    return 0n;
  }

  async transfers(
    _artifact: ContractArtifact,
    token: AztecAddress,
    owner: AztecAddress,
  ): Promise<ReceivedTransfer[]> {
    this.record(
      `wallet.getPrivateEvents(OxideToken::Transfer, { contractAddress: ${token.toString()}, scopes: [${owner.toString()}] }) (synthetic: none)`,
    );
    return [];
  }

  async txReceipt(txHash: string): Promise<ObservedTxReceipt> {
    this.record(`node.getTxReceipt(${txHash}) (synthetic: unknown, pending)`);
    return {
      status: TxStatus.PENDING,
      blockNumber: null,
      blockHash: null,
      executionSucceeded: false,
    };
  }

  async blockNumber(): Promise<number> {
    this.record("node.getBlockNumber() (synthetic: 0)");
    return 0;
  }

  async simulateTransfer(
    account: RecipientAccount,
    _artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
  ): Promise<void> {
    this.record(
      `token.methods.transfer(${account.address.toString()}, ${to.toString()}, ${amount}, zero meta, nonce 0) simulate only (seed capsule; no enclave, no proof, no send)`,
    );
  }

  async spend(
    account: RecipientAccount,
    _artifact: ContractArtifact,
    to: AztecAddress,
    amount: bigint,
    claim: FeeJuiceClaim | null = null,
  ): Promise<string> {
    this.record(
      "L1: assertL1Pinned (TeeRegistry.PCR0_HASH, CertManager.ROOT_CA_CERT_HASH, OxidePortal views)",
    );
    this.record(
      "enclave: FleetSigner.connect (attestation verified against pinned PCR0 + AWS Nitro root)",
    );
    this.record(
      `submit(transfer ${account.address.toString()} -> ${to.toString()}, ${amount}): simulate, enclave signTokenOperation (sends this account's nhk_m, #740), prove, send${
        claim ? `, fee: FeeJuicePaymentMethodWithClaim(claim of ${claim.claimAmount})` : ""
      }`,
    );
    return `0x${"00".repeat(32)}`;
  }

  async exit(
    account: RecipientAccount,
    _artifact: ContractArtifact,
    request: ExitRequest,
  ): Promise<ExitResult> {
    this.record(
      `node.getContract(${this.corridor.oxide.l2Broadcaster}): its class must be the broadcaster artifact's (${request.broadcasterArtifact.name})`,
    );
    this.record(
      `wallet.registerContract(instance ${this.corridor.oxide.l2Broadcaster}, ${request.broadcasterArtifact.name})`,
    );
    this.record(
      `L1: PlainWithdrawalExecutor(${this.corridor.oxide.plainWithdrawalExecutor}).FEE() must be at most the operator ceiling`,
    );
    this.record(
      "L1: assertL1Pinned (TeeRegistry.PCR0_HASH, CertManager.ROOT_CA_CERT_HASH, OxidePortal views)",
    );
    this.record(
      "enclave: FleetSigner.connect (attestation verified against pinned PCR0 + AWS Nitro root)",
    );
    this.record(
      `submit(withdraw ${request.amount} from ${account.address.toString()} via PlainWithdrawalExecutor ${this.corridor.oxide.plainWithdrawalExecutor} to L1 ${request.l1Recipient}, proverTip ${request.proverTip}, relayerTip ${request.relayerTip}, finalization request broadcast via ${this.corridor.oxide.l2Broadcaster})`,
    );
    return {
      txHash: `0x${"00".repeat(32)}`,
      executorFee: null,
      recipientAmount: null,
      withdrawals: [],
    };
  }

  async close(): Promise<void> {
    this.record("wallet.stop()");
  }
}
