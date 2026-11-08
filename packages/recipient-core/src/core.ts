// The recipient core facade (contract C): one recipient's account, PXE, journals and Xochi API
// behind the platform ports. Every fund-moving and receipt method holds the fund-movement lock
// and journals before any broadcast or POST, exactly as the CLI's commands do (they are the same
// functions, `commands.ts`).

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";

import { deriveRecipientAccount, type RecipientAccount } from "./account.js";
import { HttpEnrollmentApi, type BindingProjection } from "./api.js";
import { ExitJournal, openBackup, type BackupContents } from "./backup.js";
import type { BackupMode } from "./backup-mode.js";
import { validateBroadcasterArtifact } from "./broadcaster-artifact.js";
import {
  LiveAztec,
  type ExitRequest,
  type ExitResult,
  type FeeJuiceClaim,
  type ReceivedTransfer,
} from "./chain.js";
import {
  checkNetwork,
  enrollStart,
  enrollStatus,
  enrollSubmit,
  exit,
  registerSenders,
  registerToken,
  setupAccount,
  signReceipt,
  spend,
  submitReceipt,
  type Ctx,
  type PendingEnrollment,
  type ReceiptRequest,
} from "./commands.js";
import type { Corridor } from "./corridor.js";
import { bindingTypedData, type SignedAck } from "./enrollment.js";
import { OperationJournal, operationsLockName } from "./operation-journal.js";
import { validateTokenArtifact } from "./oxide-token.js";
import type {
  ArtifactLoader,
  AttestationVerifier,
  Clock,
  HttpFetch,
  KeystoreCrypto,
  KeyValueStore,
  LockManager,
  Log,
  RecipientKeySource,
} from "./ports.js";
import { ReceiptJournal, type ReceiptRecord } from "./receipt.js";
import { StateStore, type State } from "./state.js";
import type { WalletStorage } from "./wallet-storage.js";

export type { BackupMode } from "./backup-mode.js";

export interface RecipientCoreDeps {
  corridor: Corridor;
  keys: RecipientKeySource;
  kv: KeyValueStore;
  locks: LockManager;
  crypto: KeystoreCrypto;
  artifacts: ArtifactLoader;
  attestation: AttestationVerifier;
  walletStorage: WalletStorage;
  clock: Clock;
  fetch: HttpFetch;
  log: Log;
  /** Aztec node JSON-RPC (browser: https://aztec-mainnet.drpc.org). */
  nodeUrl: string;
  /** Exits and the enclave pin checks read L1 here. */
  l1RpcUrl: string | null;
  /** The source wallet's SIWE JWT, fetched per call and never stored. */
  api: { baseUrl: string; jwt: () => Promise<string> };
}

/** The account as the facade shows it: address, instance and descriptor; never a key. */
export type RecipientAccountView = Pick<RecipientAccount, "address" | "instance" | "descriptor">;

/** `exit`'s request; the Broadcaster artifact comes from `deps.artifacts`, validated against its pins. */
export type CoreExitRequest = Omit<ExitRequest, "broadcasterArtifact">;

export interface RecipientCore {
  readonly account: RecipientAccountView;
  /** registerSenders + registerToken (idempotent) + PXE sync. */
  sync(): Promise<{ blockNumber: number }>;
  balance(): Promise<bigint>;
  /** Transfers from the corridor's senders to this account. */
  payouts(): Promise<ReceivedTransfer[]>;
  accountState(): Promise<"undeployed" | "deployed">;
  /** The CLI's `receipt` up to the POST: journaled `submitting` before it resolves. */
  signReceipt(
    intentId: string,
    opts?: { tx?: string; alreadySpent?: boolean },
  ): Promise<ReceiptRecord>;
  /** Posts the recorded receipt byte for byte; signs again only after an outright rejection. */
  submitReceipt(intentId: string): Promise<ReceiptRecord>;
  deploy(claim: FeeJuiceClaim | null): Promise<{ txHash: string }>;
  /** `typedData` is what the source wallet signs (`signTypedData`). */
  enrollStart(sourceWallet: string): Promise<PendingEnrollment>;
  enrollSubmit(
    pending: PendingEnrollment,
    sourceSignature: string,
    backup: BackupMode,
  ): Promise<BindingProjection>;
  enrollStatus(bindingId: string): Promise<BindingProjection>;
  send(to: string, amount: bigint, fee: FeeJuiceClaim | null): Promise<{ txHash: string }>;
  exit(request: CoreExitRequest): Promise<ExitResult>;
  close(): Promise<void>;
}

/** The journals behind an open core, for `restoreJournals` only. */
interface CoreJournals {
  operations: OperationJournal;
  receipts: ReceiptJournal;
  exits: ExitJournal;
  state: StateStore;
  address: string;
}
const journalsOf = new WeakMap<RecipientCore, CoreJournals>();

/** A random positive 31-bit id: this core's journal holder (its "pid", contract C). */
function sessionHolderId(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return (value! % 0x7fff_fffe) + 1;
}

class Core implements RecipientCore {
  readonly account: RecipientAccountView;

  constructor(
    private readonly deps: RecipientCoreDeps,
    private readonly secretAccount: RecipientAccount,
    private readonly port: LiveAztec,
    private readonly tokenArtifact: ContractArtifact,
    private readonly journals: CoreJournals,
  ) {
    this.account = {
      address: secretAccount.address,
      instance: secretAccount.instance,
      descriptor: secretAccount.descriptor,
    };
  }

  private get ctx(): Ctx {
    return {
      corridor: this.deps.corridor,
      port: this.port,
      log: this.deps.log,
      clock: this.deps.clock,
    };
  }

  private api(): HttpEnrollmentApi {
    return new HttpEnrollmentApi(this.deps.api.baseUrl, this.deps.api.jwt, this.deps.fetch);
  }

  private async state(): Promise<State> {
    const state = await this.journals.state.read();
    if (!state) throw new Error("the recipient state record is missing");
    return state;
  }

  async sync(): Promise<{ blockNumber: number }> {
    await registerSenders(this.ctx);
    const registeredAt = await registerToken(this.ctx, this.tokenArtifact);
    await this.journals.state.write({ ...(await this.state()), tokenRegisteredAt: registeredAt });
    await this.payouts();
    return { blockNumber: await this.port.blockNumber() };
  }

  async balance(): Promise<bigint> {
    return this.port.balance(
      this.tokenArtifact,
      AztecAddress.fromStringUnsafe(this.deps.corridor.token.address),
      this.account.address,
    );
  }

  async payouts(): Promise<ReceivedTransfer[]> {
    const senders = new Set(this.deps.corridor.registeredSenders);
    const transfers = await this.port.transfers(
      this.tokenArtifact,
      AztecAddress.fromStringUnsafe(this.deps.corridor.token.address),
      this.account.address,
    );
    return transfers.filter((transfer) => senders.has(transfer.from.toLowerCase()));
  }

  async accountState(): Promise<"undeployed" | "deployed"> {
    const state = await this.port.accountState(this.account.address);
    return state.initialized && state.published ? "deployed" : "undeployed";
  }

  async signReceipt(
    intentId: string,
    opts: { tx?: string; alreadySpent?: boolean } = {},
  ): Promise<ReceiptRecord> {
    return signReceipt(
      this.ctx,
      this.api(),
      this.secretAccount,
      this.tokenArtifact,
      this.journals,
      await this.receiptRequest(intentId, opts),
    );
  }

  async submitReceipt(intentId: string): Promise<ReceiptRecord> {
    return submitReceipt(
      this.ctx,
      this.api(),
      this.secretAccount,
      this.tokenArtifact,
      this.journals,
      await this.receiptRequest(intentId, {}),
    );
  }

  private async receiptRequest(
    intentId: string,
    opts: { tx?: string; alreadySpent?: boolean },
  ): Promise<ReceiptRequest> {
    const state = await this.state();
    return {
      intentId,
      tx: opts.tx ?? null,
      alreadySpent: opts.alreadySpent ?? false,
      bindingDigest: state.bindingDigest ?? null,
      bindingId: state.bindingId ?? null,
      legacyBinding: false,
      rememberBindingDigest: async (bindingDigest, bindingId) => {
        const current = await this.state();
        await this.journals.state.write({
          ...current,
          bindingDigest,
          bindingId: current.bindingId ?? bindingId,
        });
      },
      dryRun: false,
    };
  }

  async deploy(claim: FeeJuiceClaim | null): Promise<{ txHash: string }> {
    const txHash = await setupAccount(this.ctx, this.secretAccount, claim);
    if (txHash === null) {
      throw new Error(`account ${this.account.address.toString()} is already deployed`);
    }
    return { txHash };
  }

  async enrollStart(sourceWallet: string): Promise<PendingEnrollment> {
    const state = await this.state();
    const pending = await enrollStart(
      this.ctx,
      this.api(),
      this.secretAccount,
      sourceWallet,
      state.tokenRegisteredAt ?? null,
    );
    const tokenRegistrationAck = pending.tokenRegistrationAck as State["tokenRegistrationAck"];
    await this.journals.state.write({
      ...state,
      tokenRegistrationAck,
      pending: {
        challenge: pending.challenge,
        binding: pending.binding,
        tokenRegistrationAck: tokenRegistrationAck ?? null,
      },
    });
    return pending;
  }

  async enrollSubmit(
    pending: PendingEnrollment,
    sourceSignature: string,
    backup: BackupMode,
  ): Promise<BindingProjection> {
    const projection = await enrollSubmit(
      this.ctx,
      this.api(),
      this.secretAccount,
      pending,
      sourceSignature,
      backup,
    );
    const { pending: _done, ...state } = await this.state();
    await this.journals.state.write({
      ...state,
      ...(backup.mode === "sealed_file" ? { backupCommitment: backup.commitment } : {}),
      tokenRegistrationAck: pending.tokenRegistrationAck as State["tokenRegistrationAck"],
      bindingId: projection.binding_id,
      bindingDigest: bindingTypedData(this.deps.corridor, pending.binding).digest,
    });
    return projection;
  }

  enrollStatus(bindingId: string): Promise<BindingProjection> {
    return enrollStatus(this.ctx, this.api(), bindingId, this.secretAccount);
  }

  async send(to: string, amount: bigint, fee: FeeJuiceClaim | null): Promise<{ txHash: string }> {
    return {
      txHash: await spend(this.ctx, this.secretAccount, this.tokenArtifact, to, amount, fee),
    };
  }

  async exit(request: CoreExitRequest): Promise<ExitResult> {
    const broadcasterArtifact = await validateBroadcasterArtifact(
      await this.deps.artifacts.broadcasterArtifact(),
      "from the artifact loader",
    );
    const result = await exit(this.ctx, this.secretAccount, this.tokenArtifact, {
      ...request,
      broadcasterArtifact,
    });
    await this.journals.exits.record(result);
    return result;
  }

  async close(): Promise<void> {
    try {
      await this.port.close();
    } finally {
      await this.journals.operations.close();
    }
  }
}

/**
 * Opens one recipient: derives the account from `deps.keys`, validates the token artifact,
 * creates the PXE over `deps.walletStorage`, refuses any node that is not the corridor's network
 * and adds the account to the PXE.
 */
export async function openRecipientCore(deps: RecipientCoreDeps): Promise<RecipientCore> {
  const account = await deriveRecipientAccount(await deps.keys.accountSecrets(), deps.corridor);
  const address = account.descriptor.aztecAddress;
  const state = new StateStore(deps.kv);
  const recorded = await state.read();
  if (recorded && recorded.address !== address) {
    throw new Error(
      `this profile records recipient ${recorded.address}, the keys derive ${address}`,
    );
  }
  if (!recorded) await state.write({ corridor: deps.corridor, address });
  const tokenArtifact = await validateTokenArtifact(
    await deps.artifacts.tokenArtifact(),
    deps.corridor,
  );
  const operations = new OperationJournal({
    kv: deps.kv,
    locks: deps.locks,
    clock: deps.clock,
    lockName: operationsLockName(address),
    holder: { pid: sessionHolderId(), host: "recipient-core" },
  });
  const port = await LiveAztec.connect({
    nodeUrl: deps.nodeUrl,
    walletStorage: deps.walletStorage,
    scope: address,
    corridor: deps.corridor,
    l1RpcUrl: deps.l1RpcUrl,
    journal: operations,
    attestation: deps.attestation,
    fetch: deps.fetch,
  });
  const journals: CoreJournals = {
    operations,
    receipts: new ReceiptJournal(deps.kv, deps.clock),
    exits: new ExitJournal(deps.kv),
    state,
    address,
  };
  const core = new Core(deps, account, port, tokenArtifact, journals);
  try {
    const ctx: Ctx = { corridor: deps.corridor, port, log: deps.log, clock: deps.clock };
    await checkNetwork(ctx);
    await port.addAccount(account);
  } catch (error) {
    await core.close();
    throw error;
  }
  journalsOf.set(core, journals);
  return core;
}

/** Opens and validates a CLI backup (sealed file + passphrase). */
export function importCliBackup(
  sealed: Uint8Array,
  passphrase: string,
  crypto: KeystoreCrypto,
): Promise<BackupContents> {
  return openBackup(sealed, passphrase, crypto);
}

/**
 * Restores a CLI backup's operation, exit and receipt journals (and its enrolled binding) into an
 * open core of the same account whose journals are empty. An unresolved operation keeps its lock
 * and must be reconciled; an unfinished receipt run is restored aborted.
 */
export async function restoreJournals(core: RecipientCore, backup: BackupContents): Promise<void> {
  const journals =
    journalsOf.get(core) ?? fail("restoreJournals needs a core from openRecipientCore");
  if (backup.account.address !== journals.address) {
    throw new Error(
      `the backup is for ${backup.account.address}, this core is ${journals.address}`,
    );
  }
  await journals.operations.restore(backup.journals.operations);
  await journals.exits.restore(backup.journals.exits);
  await journals.receipts.restore(backup.journals.receipts);
  const state = await journals.state.read();
  if (!state) throw new Error("the recipient state record is missing");
  await journals.state.write({
    ...state,
    tokenRegistrationAck: (backup.tokenRegistrationAck as SignedAck | null) ?? null,
    ...(backup.bindingId ? { bindingId: backup.bindingId } : {}),
    ...(backup.bindingDigest ? { bindingDigest: backup.bindingDigest } : {}),
  } as State);
}

function fail(message: string): never {
  throw new Error(message);
}
