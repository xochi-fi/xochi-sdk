// The recipient core facade (contract C): one recipient's account, PXE, journals and Xochi API
// behind the platform ports. `send`, `exit` and the receipt methods hold the fund-movement lock
// and journal before any broadcast or POST, exactly as the CLI's commands do (they are the same
// functions, `commands.ts`); `deploy`, like the CLI's `setup`, is neither locked nor journaled.
// Every `state.json` read-modify-write runs under the short `…:state` lease (`stateLockName`).

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { keccak256 } from "viem";

import { deriveRecipientAccount, type RecipientAccount } from "./account.js";
import { HttpEnrollmentApi, type BindingProjection } from "./api.js";
import { ExitJournal, openBackup, type BackupContents } from "./backup.js";
import {
  BACKUP_FORMAT_PASSKEY_V1_ID,
  signerSignsPasskeyBackup,
  type BackupMode,
} from "./backup-mode.js";
import { validateBroadcasterArtifact } from "./broadcaster-artifact.js";
import {
  LiveAztec,
  type AztecPort,
  type ExitRequest,
  type ExitResult,
  type FeeJuiceClaim,
  type LiveAztecOptions,
  type ReceivedTransfer,
} from "./chain.js";
import {
  checkNetwork,
  enrollStart,
  enrollStatus,
  postEnrollment,
  prepareEnrollment,
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
import { CorridorSchema, type Corridor } from "./corridor.js";
import { bindingTypedData, type EnrollmentRequest, type SignedAck } from "./enrollment.js";
import { parseJsonBytes, prettyJsonBytes, utf8Bytes } from "./json.js";
import {
  OperationJournal,
  RESTORE_MARKER_KEY,
  isTerminalStatus,
  operationsLockName,
} from "./operation-journal.js";
import { validateTokenArtifact } from "./oxide-token.js";
import {
  KeyExistsError,
  type ArtifactLoader,
  type AttestationVerifier,
  type Clock,
  type HttpFetch,
  type KeystoreCrypto,
  type KeyValueStore,
  type LockHolder,
  type LockManager,
  type Log,
  type RecipientKeySource,
} from "./ports.js";
import { ReceiptJournal, type ReceiptRecord } from "./receipt.js";
import { StateSchema, StateStore, type State } from "./state.js";
import type { WalletStorage } from "./wallet-storage.js";

export type { BackupMode } from "./backup-mode.js";

/** The signed enrollment request `enrollSubmit` keeps until its binding is recorded. */
const ENROLLMENT_REQUEST_KEY = "enrollment-request.json";
interface RecordedEnrollment {
  challengeId: string;
  request: EnrollmentRequest;
}

export interface RecipientCoreDeps {
  corridor: Corridor;
  keys: RecipientKeySource;
  kv: KeyValueStore;
  locks: LockManager;
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

/** Connects the Aztec port; `LiveAztec.connect` unless a test supplies a double. */
export type ConnectAztec = (options: LiveAztecOptions) => Promise<AztecPort>;

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
  /**
   * Refuses `{ mode: "passkey" }` unless `deps.keys.kind` is `"passkey"` (keystore and imported
   * recipients acknowledge their sealed backup file), and while the resolved @xochi/signer cannot
   * sign the passkey format (< 0.8.0); both before any request.
   */
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

/** The lease every `state.json` read-modify-write holds (contract C): `…:operations:state`. */
export function stateLockName(address: string): string {
  return `${operationsLockName(address)}:state`;
}

const STATE_LEASE_ATTEMPTS = 200;
const STATE_LEASE_RETRY_MS = 25;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** One recipient's `state.json` behind its lease. */
class StateRecord {
  private readonly store: StateStore;
  private readonly lockName: string;

  constructor(
    kv: KeyValueStore,
    private readonly locks: LockManager,
    address: string,
    private readonly holder: LockHolder,
  ) {
    this.store = new StateStore(kv);
    this.lockName = stateLockName(address);
  }

  async read(): Promise<State> {
    return (await this.store.read()) ?? fail("the recipient state record is missing");
  }

  /**
   * Reads, edits and writes the record under the state lease, waiting (up to about five seconds)
   * while another session holds it. `edit` sees null before the first write; a throw writes nothing.
   */
  async update(edit: (current: State | null) => State): Promise<State> {
    for (let attempt = 1; ; attempt += 1) {
      const lease = await this.locks.tryAcquire(this.lockName, this.holder);
      if (lease) {
        try {
          const next = edit(await this.store.read());
          await this.store.write(next);
          return next;
        } finally {
          await lease.release();
        }
      }
      if (attempt === STATE_LEASE_ATTEMPTS) {
        throw new Error(
          `another session is updating this recipient's state.json (${this.lockName}); try again`,
        );
      }
      await delay(STATE_LEASE_RETRY_MS);
    }
  }
}

/** The journals behind an open core, for `restoreJournals` only. */
interface CoreJournals {
  kv: KeyValueStore;
  operations: OperationJournal;
  receipts: ReceiptJournal;
  exits: ExitJournal;
  state: StateRecord;
  corridor: Corridor;
  address: string;
}
const journalsOf = new WeakMap<RecipientCore, CoreJournals>();

/** A random positive 31-bit id: this core's journal holder (its "pid", contract C). */
function sessionHolderId(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return (value! % 0x7fff_fffe) + 1;
}

/** Corridor records compare by their schema's canonical JSON (key order is not identity). */
function sameCorridor(left: Corridor, right: Corridor): boolean {
  return JSON.stringify(CorridorSchema.parse(left)) === JSON.stringify(CorridorSchema.parse(right));
}

const describeCorridor = (corridor: Corridor) =>
  `corridor ${corridor.name} (token ${corridor.token.address})`;

/**
 * The vendored Oxide subset reads Node's global `Buffer` (some of it at module load, so a missing
 * one usually fails the import itself): browsers install the `buffer` package's.
 */
function assertGlobalBuffer(): void {
  if (typeof Reflect.get(globalThis, "Buffer") !== "function") {
    throw new Error(
      "@xochi/recipient-core needs globalThis.Buffer: install the buffer package's Buffer as globalThis.Buffer before importing it",
    );
  }
}

class Core implements RecipientCore {
  readonly account: RecipientAccountView;
  // ECMAScript private: never in `util.inspect`, `JSON.stringify`, `Object.values` or devtools'
  // property lists, so the account secret and signing key cannot leak through a logged core.
  readonly #deps: RecipientCoreDeps;
  readonly #secretAccount: RecipientAccount;
  readonly #port: AztecPort;
  readonly #tokenArtifact: ContractArtifact;
  readonly #journals: CoreJournals;

  constructor(
    deps: RecipientCoreDeps,
    secretAccount: RecipientAccount,
    port: AztecPort,
    tokenArtifact: ContractArtifact,
    journals: CoreJournals,
  ) {
    this.#deps = deps;
    this.#secretAccount = secretAccount;
    this.#port = port;
    this.#tokenArtifact = tokenArtifact;
    this.#journals = journals;
    this.account = {
      address: secretAccount.address,
      instance: secretAccount.instance,
      descriptor: secretAccount.descriptor,
    };
  }

  get #ctx(): Ctx {
    return {
      corridor: this.#deps.corridor,
      port: this.#port,
      log: this.#deps.log,
      clock: this.#deps.clock,
    };
  }

  #api(): HttpEnrollmentApi {
    return new HttpEnrollmentApi(this.#deps.api.baseUrl, this.#deps.api.jwt, this.#deps.fetch);
  }

  async sync(): Promise<{ blockNumber: number }> {
    await registerSenders(this.#ctx);
    const registeredAt = await registerToken(this.#ctx, this.#tokenArtifact);
    await this.#journals.state.update((current) => ({
      ...(current ?? fail("the recipient state record is missing")),
      tokenRegisteredAt: registeredAt,
    }));
    await this.payouts();
    return { blockNumber: await this.#port.blockNumber() };
  }

  async balance(): Promise<bigint> {
    return this.#port.balance(
      this.#tokenArtifact,
      AztecAddress.fromStringUnsafe(this.#deps.corridor.token.address),
      this.account.address,
    );
  }

  async payouts(): Promise<ReceivedTransfer[]> {
    const senders = new Set(this.#deps.corridor.registeredSenders);
    const transfers = await this.#port.transfers(
      this.#tokenArtifact,
      AztecAddress.fromStringUnsafe(this.#deps.corridor.token.address),
      this.account.address,
    );
    return transfers.filter((transfer) => senders.has(transfer.from.toLowerCase()));
  }

  async accountState(): Promise<"undeployed" | "deployed"> {
    const state = await this.#port.accountState(this.account.address);
    return state.initialized && state.published ? "deployed" : "undeployed";
  }

  async signReceipt(
    intentId: string,
    opts: { tx?: string; alreadySpent?: boolean } = {},
  ): Promise<ReceiptRecord> {
    return signReceipt(
      this.#ctx,
      this.#api(),
      this.#secretAccount,
      this.#tokenArtifact,
      this.#journals,
      await this.#receiptRequest(intentId, opts),
    );
  }

  async submitReceipt(intentId: string): Promise<ReceiptRecord> {
    return submitReceipt(
      this.#ctx,
      this.#api(),
      this.#secretAccount,
      this.#tokenArtifact,
      this.#journals,
      await this.#receiptRequest(intentId, {}),
    );
  }

  async #receiptRequest(
    intentId: string,
    opts: { tx?: string; alreadySpent?: boolean },
  ): Promise<ReceiptRequest> {
    const state = await this.#journals.state.read();
    return {
      intentId,
      tx: opts.tx ?? null,
      alreadySpent: opts.alreadySpent ?? false,
      bindingDigest: state.bindingDigest ?? null,
      bindingId: state.bindingId ?? null,
      legacyBinding: false,
      rememberBindingDigest: async (bindingDigest, bindingId) => {
        await this.#journals.state.update((current) => {
          const recorded = current ?? fail("the recipient state record is missing");
          return { ...recorded, bindingDigest, bindingId: recorded.bindingId ?? bindingId };
        });
      },
      dryRun: false,
    };
  }

  /**
   * Deploys the account. The deployment's tx hash is durable in `deploy.json` before the node can
   * receive it; a later `deploy` first reconciles a recorded one: included (checkpointed, proven
   * or finalized) and successful answers its hash, dropped or reverted sends again, anything else
   * is refused until the node decides.
   */
  async deploy(claim: FeeJuiceClaim | null): Promise<{ txHash: string }> {
    const kv = this.#deps.kv;
    // CLI `setup` keeps no such record; only the facade's deploy can be retried after a reload.
    const DEPLOY_KEY = "deploy.json";
    const recorded = await kv.get(DEPLOY_KEY);
    if (recorded !== null) {
      const { txHash } = parseJsonBytes(recorded) as { txHash: string };
      const receipt = await this.#port.txReceipt(txHash);
      const status = String(receipt.status);
      const included = ["checkpointed", "proven", "finalized"].includes(status);
      if (included && receipt.executionSucceeded) {
        await kv.delete(DEPLOY_KEY);
        return { txHash };
      }
      if (!included && status !== "dropped") {
        throw new Error(
          `the recorded deployment ${txHash} is ${status}; run deploy again once it is included or dropped`,
        );
      }
      await kv.delete(DEPLOY_KEY);
    }
    const txHash = await setupAccount(this.#ctx, this.#secretAccount, claim, async (hash) => {
      await kv.put(DEPLOY_KEY, prettyJsonBytes({ txHash: hash }));
    });
    if (txHash === null) {
      throw new Error(`account ${this.account.address.toString()} is already deployed`);
    }
    await kv.delete(DEPLOY_KEY);
    return { txHash };
  }

  async enrollStart(sourceWallet: string): Promise<PendingEnrollment> {
    const { tokenRegisteredAt } = await this.#journals.state.read();
    const pending = await enrollStart(
      this.#ctx,
      this.#api(),
      this.#secretAccount,
      sourceWallet,
      tokenRegisteredAt ?? null,
    );
    const tokenRegistrationAck = pending.tokenRegistrationAck as State["tokenRegistrationAck"];
    await this.#journals.state.update((current) => ({
      ...(current ?? fail("the recipient state record is missing")),
      tokenRegistrationAck,
      pending: {
        challenge: pending.challenge,
        binding: pending.binding,
        tokenRegistrationAck: tokenRegistrationAck ?? null,
      },
    }));
    return pending;
  }

  async enrollSubmit(
    pending: PendingEnrollment,
    sourceSignature: string,
    backup: BackupMode,
  ): Promise<BindingProjection> {
    if (backup.mode === "passkey") {
      const { kind } = this.#deps.keys;
      if (kind !== "passkey") {
        throw new Error(
          `the passkey backup mode is only for a passkey recipient; this recipient's keys are ${kind}: acknowledge its sealed backup file`,
        );
      }
      if (!signerSignsPasskeyBackup()) {
        throw new Error(
          `the passkey backup mode requires @xochi/signer >= 0.8.0 (it signs format ${BACKUP_FORMAT_PASSKEY_V1_ID})`,
        );
      }
    }
    // Recipient signatures are randomized: a request signed again after a lost response never
    // matches the Worker's exact-resubmission check. Keep the signed bytes durably before the POST
    // and resend them unchanged for this challenge; forget them once the binding is recorded.
    const recorded = await this.#deps.kv.get(ENROLLMENT_REQUEST_KEY);
    const kept = recorded === null ? null : (parseJsonBytes(recorded) as RecordedEnrollment);
    let request: EnrollmentRequest;
    if (kept?.challengeId === pending.challenge.challenge_id) {
      request = kept.request;
    } else {
      request = await prepareEnrollment(
        this.#ctx,
        this.#secretAccount,
        pending,
        sourceSignature,
        backup,
      );
      const record: RecordedEnrollment = { challengeId: pending.challenge.challenge_id, request };
      await this.#deps.kv.put(ENROLLMENT_REQUEST_KEY, prettyJsonBytes(record));
    }
    const projection = await postEnrollment(this.#ctx, this.#api(), pending, request);
    await this.#journals.state.update((current) => {
      const { pending: _done, ...state } = current ?? fail("the recipient state record is missing");
      return {
        ...state,
        ...(backup.mode === "sealed_file" ? { backupCommitment: backup.commitment } : {}),
        tokenRegistrationAck: pending.tokenRegistrationAck as State["tokenRegistrationAck"],
        bindingId: projection.binding_id,
        bindingDigest: bindingTypedData(this.#deps.corridor, pending.binding).digest,
      };
    });
    await this.#deps.kv.delete(ENROLLMENT_REQUEST_KEY);
    return projection;
  }

  enrollStatus(bindingId: string): Promise<BindingProjection> {
    return enrollStatus(this.#ctx, this.#api(), bindingId, this.#secretAccount);
  }

  async send(to: string, amount: bigint, fee: FeeJuiceClaim | null): Promise<{ txHash: string }> {
    return {
      txHash: await spend(this.#ctx, this.#secretAccount, this.#tokenArtifact, to, amount, fee),
    };
  }

  async exit(request: CoreExitRequest): Promise<ExitResult> {
    const broadcasterArtifact = await validateBroadcasterArtifact(
      await this.#deps.artifacts.broadcasterArtifact(),
      "from the artifact loader",
    );
    const result = await exit(this.#ctx, this.#secretAccount, this.#tokenArtifact, {
      ...request,
      broadcasterArtifact,
    });
    await this.#journals.exits.record(result);
    return result;
  }

  async close(): Promise<void> {
    try {
      await this.#port.close();
    } finally {
      await this.#journals.operations.close();
    }
  }
}

/**
 * Opens one recipient: derives the account from `deps.keys`, refuses a profile recorded for
 * another account or corridor, validates the token artifact, creates the PXE over
 * `deps.walletStorage`, refuses any node that is not the corridor's network and adds the account
 * to the PXE. `connect` is the Aztec port's constructor (a test double; `LiveAztec` otherwise).
 */
export async function openRecipientCore(
  deps: RecipientCoreDeps,
  connect: ConnectAztec = LiveAztec.connect,
): Promise<RecipientCore> {
  assertGlobalBuffer();
  const account = await deriveRecipientAccount(await deps.keys.accountSecrets(), deps.corridor);
  const address = account.descriptor.aztecAddress;
  const pid = sessionHolderId();
  const state = new StateRecord(deps.kv, deps.locks, address, {
    id: String(pid),
    nonce: crypto.randomUUID(),
    kind: "state",
  });
  await state.update((recorded) => {
    if (!recorded) return { corridor: deps.corridor, address };
    if (recorded.address !== address) {
      throw new Error(
        `this profile records recipient ${recorded.address}, the keys derive ${address}`,
      );
    }
    if (!sameCorridor(recorded.corridor, deps.corridor)) {
      throw new Error(
        `this profile records ${describeCorridor(recorded.corridor)}, not this core's`,
      );
    }
    return recorded;
  });
  const tokenArtifact = await validateTokenArtifact(
    await deps.artifacts.tokenArtifact(),
    deps.corridor,
  );
  const operations = new OperationJournal({
    kv: deps.kv,
    locks: deps.locks,
    clock: deps.clock,
    lockName: operationsLockName(address),
    holder: { pid, host: "recipient-core" },
  });
  const port = await connect({
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
    kv: deps.kv,
    operations,
    receipts: new ReceiptJournal(deps.kv, deps.clock),
    exits: new ExitJournal(deps.kv),
    state,
    corridor: deps.corridor,
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
 * Restores a CLI backup's operation, exit and receipt journals and its enrolled binding into an
 * open core of the same account and corridor whose journals are empty, and records the backup
 * as the CLI's `restore` does: `backupCommitment` is keccak256 of `sealed` (the file
 * `importCliBackup` opened) and `backupTokenAckSignature` its TokenRegistrationAck's signature.
 * Refused before anything is written: a backup with an unresolved fund movement (the facade cannot
 * reconcile it, so the CLI must first), a profile that records another binding, and a next
 * `state.json` that does not validate. The restore holds `RESTORE_MARKER_KEY` throughout, so no
 * session moves funds or runs a receipt meanwhile; if a journal write fails the marker stays and
 * keeps fund movement blocked (the profile must be recreated). An unfinished receipt run moved no
 * funds and is restored aborted.
 */
export async function restoreJournals(
  core: RecipientCore,
  backup: BackupContents,
  sealed: Uint8Array,
): Promise<void> {
  const journals =
    journalsOf.get(core) ?? fail("restoreJournals needs a core from openRecipientCore");
  if (backup.account.address !== journals.address) {
    throw new Error(
      `the backup is for ${backup.account.address}, this core is ${journals.address}`,
    );
  }
  if (!sameCorridor(backup.corridor, journals.corridor)) {
    throw new Error(`the backup is for ${describeCorridor(backup.corridor)}, not this core's`);
  }
  const open = backup.journals.operations.find(
    (record) => record.kind !== "receipt" && !isTerminalStatus(record.status),
  );
  if (open) {
    throw new Error(
      `the backup's ${open.kind} operation ${open.id} is ${open.status}: reconcile it with the CLI first (xochi-recipient operations reconcile), then back up again`,
    );
  }
  if (!(sealed instanceof Uint8Array)) {
    throw new TypeError("restoreJournals needs the sealed backup bytes importCliBackup opened");
  }
  const backupCommitment = keccak256(sealed);
  const tokenRegistrationAck = (backup.tokenRegistrationAck as SignedAck | null) ?? null;
  const restoredState = (current: State | null): State => {
    const recorded = current ?? fail("the recipient state record is missing");
    for (const [name, mine, theirs] of [
      ["binding", recorded.bindingId, backup.bindingId],
      ["binding digest", recorded.bindingDigest, backup.bindingDigest],
    ] as const) {
      if (mine && theirs && mine !== theirs) {
        throw new Error(`this profile is enrolled with ${name} ${mine}; the backup's is ${theirs}`);
      }
    }
    return StateSchema.parse({
      ...recorded,
      backupCommitment,
      backupTokenAckSignature: tokenRegistrationAck?.signature ?? null,
      tokenRegistrationAck,
      ...(backup.bindingId ? { bindingId: backup.bindingId } : {}),
      ...(backup.bindingDigest ? { bindingDigest: backup.bindingDigest } : {}),
    });
  };
  restoredState(await journals.state.read());

  try {
    await journals.kv.create(RESTORE_MARKER_KEY, utf8Bytes(journals.address));
  } catch (error) {
    if (!(error instanceof KeyExistsError)) throw error;
    throw new Error(
      `a journal restore already holds this profile (${RESTORE_MARKER_KEY}); if none is running, the profile must be recreated`,
    );
  }
  let written = false;
  try {
    for (const prefix of ["operations/", "exits/", "receipts/"]) {
      if ((await journals.kv.list(prefix)).length !== 0) {
        throw new Error("restoreJournals needs a profile with empty journals");
      }
    }
    written = true;
    await journals.operations.restore(backup.journals.operations);
    await journals.exits.restore(backup.journals.exits);
    await journals.receipts.restore(backup.journals.receipts);
    await journals.state.update(restoredState);
    await journals.kv.delete(RESTORE_MARKER_KEY);
  } finally {
    if (!written) await journals.kv.delete(RESTORE_MARKER_KEY);
  }
}

function fail(message: string): never {
  throw new Error(message);
}
