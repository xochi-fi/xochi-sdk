#!/usr/bin/env node
// xochi-recipient: the Xochi OXDAI recipient tool (xochi#759). See README.md.
//
// It contacts only the Aztec node you name (--node-url), the Xochi API (--api-url; enroll and
// receipt only), the zk.money enclave and an L1 JSON-RPC you name (--l1-rpc; spend,
// exit and refund only). No telemetry. The account's secret key and signing key are stored only
// sealed with your passphrase (keystore, backups); the PXE store under the data directory holds
// the account's viewing, tagging and nullifier hiding keys in plaintext (README "Disclosures").

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { hashRecipientDescriptor } from "@xochi/signer";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { TxHash } from "@aztec-labs/stdlib/tx";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod4";

import {
  deriveRecipientAccount,
  newAccountSecrets,
  type AccountSecrets,
  type RecipientAccount,
} from "./core/account.js";
import {
  DryRunEnrollmentApi,
  HttpEnrollmentApi,
  XOCHI_API_URL,
  assertIntentId,
  type EnrollmentApi,
  type ReceiptApi,
} from "./core/api.js";
import { SignedAckSchema, backupContents, openBackup, sealBackup } from "./core/backup.js";
import { DryRunAztec, LiveAztec, type AztecPort } from "./core/chain.js";
import {
  checkNetwork,
  enrollStart,
  enrollStatus,
  enrollSubmit,
  exit,
  receipt,
  registerSenders,
  registerToken,
  setupAccount,
  showBalance,
  spend,
  type Ctx,
  type PendingEnrollment,
} from "./core/commands.js";
import {
  OXDAI_MAINNET_REV2,
  decimal,
  hex32,
  parseCorridor,
  type Corridor,
} from "./core/corridor.js";
import { bindingTypedData, typedDataJson, type SignedAck } from "./core/enrollment.js";
import { utf8Bytes } from "./core/json.js";
import { assertPinnedNetwork } from "./core/network.js";
import { durablyIncluded } from "./core/reconciliation.js";
import { operatorDiagnosticLine } from "./core/safe-diagnostic.js";
import type { State } from "./core/state.js";
import { loadBroadcasterArtifact, loadTokenArtifact } from "./node/artifacts.js";
import { NodeAttestationVerifier } from "./node/attestation.js";
import {
  SealedKeystoreKeySource,
  openNodeJournals,
  systemClock,
  type NodeJournals,
} from "./node/data-dir.js";
import { writeBackupCopies, writePrivateFileExclusive } from "./node/files.js";
import { NodeKeystoreCrypto } from "./node/sealed.js";
import { NodeWalletStorage } from "./node/wallet-storage.js";
import {
  RefundBundleSchema,
  RefundEvidenceSchema,
  authorizeRefund,
  reconcileRefund,
  submitRefund,
} from "./refund.js";
import { assertSupportedRuntime, diagnostics, packageVersion } from "./release-info.js";

const USAGE = `xochi-recipient <command> [options]

Commands (in round-trip order):
  init                     create the account secrets on this machine (sealed keystore)
  setup                    check the network; publish + initialize the account; register the
                           corridor senders and the OxideToken (+ store_immutables)
  balance                  sync and show the OXDAI balance and received payouts' order fingerprints
  receipt INTENT_ID [--tx HASH] [--already-spent] [--legacy-binding [--binding-id ID]]
                           after a shielded payout, before spending it: confirm receipt to Xochi
                           with a signed PaymentReceiptAck for this intent's payout, found by
                           this PXE, finalized on your node and spendable. Reuses the node URL
                           and artifact path saved by setup, enroll start or restore
  backup --out A --out B   write two encrypted copies, including spend/exit/refund journals
  enroll start             request a challenge; write the binding the source wallet signs
  enroll submit            sign and submit the authorization plus the Worker's required
                           acknowledgements, including TokenRegistrationAck for OXDAI
  enroll status            show the binding state (pending / ready / revoked)
  restore --backup FILE    restore into a fresh data directory/PXE and find the balance
  spend --to ADDR --amount BASEUNITS
  exit --l1-recipient ADDR --amount BASEUNITS --prover-tip N --relayer-tip N --max-executor-fee N --broadcaster-artifact FILE
  operations [reconcile]   show journal, or reconcile its recorded Aztec transaction; releases a
                           receipt run's lock once that run's process is gone (--force: its pid
                           was reused after a crash)
  refund authorize         sign recipient-owned refund evidence to a fixed L1 destination
  refund submit            validate and submit one externally proved, signed L1 refund transaction
  refund reconcile         unlock only after an accepted finalized L1 transaction
  diagnostics              privacy-safe runtime, release pin and optional backup compatibility checks
  plan                     dry run of the whole sequence with a throwaway account: no network

Options:
  --data-dir DIR               default ~/.xochi-recipient
  --node-url URL               Aztec v6 mainnet node of your choice (required live)
  --corridor FILE              corridor record (default: built-in OXDAI mainnet rev 2)
  --oxide-token-artifact FILE  OxideToken artifact (class and artifact hash are checked)
  --fee-juice-claim FILE       Xochi's sponsored Fee Juice claim for the deployment (setup) or
                               bridged Fee Juice claimed to pay the exit's fee (exit)
  --api-url URL                Xochi API (enroll, receipt); default ${XOCHI_API_URL}; bearer
                               from XOCHI_JWT
  --source-wallet ADDR         enroll start
  --source-signature SIG       enroll submit
  --binding-id ID              enroll status
  --l1-rpc URL                 L1 JSON-RPC of your choice (spend, exit, refund)
  --tx HASH                    receipt: the payout transaction, if several payouts match
  --already-spent              receipt: this account spent the payout after it landed
  --legacy-binding             receipt: a data directory enrolled before its binding digest was
                               recorded adopts the challenge's, for its own binding id only
                               (--binding-id ID when state.json has none)
  --force                      operations reconcile: release a receipt run's lock although its
                               recorded pid is alive (only when that pid was reused after a crash)
  --max-executor-fee BASEUNITS maximum acceptable live PlainWithdrawalExecutor fee for exit
  --refund-evidence FILE       recipient-owned evidence produced by the pinned upstream refund builder
  --bundle FILE                completed refund bundle (refund submit)
  --raw-transaction FILE       externally signed exact refund transaction (refund submit)
  --l1-recipient ADDR          fixed recipient for exit or refund authorization
  --dry-run                    record every node, PXE and API call; perform none (receipt
                               stops after the PXE read: the dry-run PXE has no payouts)
  --version                    print the test artifact version
Passphrase: XOCHI_RECIPIENT_PASSPHRASE, else prompted.`;

const FeeJuiceClaimSchema = z
  .object({
    claimAmount: z.string().regex(/^[1-9][0-9]*$/),
    claimSecret: hex32,
    messageLeafIndex: decimal,
  })
  .strict();

function fail(message: string): never {
  throw new Error(message);
}

/** One line from the terminal, not echoed. */
async function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.question("", resolve);
  const answer = await promise;
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function passphrase(confirm: boolean): Promise<string> {
  const fromEnv = process.env["XOCHI_RECIPIENT_PASSPHRASE"];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) fail("set XOCHI_RECIPIENT_PASSPHRASE or run on a terminal");
  const first = await askHidden("passphrase: ");
  if (confirm && (await askHidden("again: ")) !== first) fail("passphrases differ");
  return first;
}

interface Values {
  "data-dir"?: string;
  "node-url"?: string;
  corridor?: string;
  "oxide-token-artifact"?: string;
  "fee-juice-claim"?: string;
  "api-url"?: string;
  "source-wallet"?: string;
  "source-signature"?: string;
  "binding-id"?: string;
  "l1-rpc"?: string;
  backup?: string;
  out?: string[];
  checkpoint?: string;
  to?: string;
  amount?: string;
  "l1-recipient"?: string;
  "prover-tip"?: string;
  "relayer-tip"?: string;
  "max-executor-fee"?: string;
  "broadcaster-artifact"?: string;
  "refund-evidence"?: string;
  bundle?: string;
  "raw-transaction"?: string;
  tx?: string;
  "already-spent"?: boolean;
  "legacy-binding"?: boolean;
  force?: boolean;
  "dry-run"?: boolean;
  version?: boolean;
  help?: boolean;
}

function parse(argv: string[]): { values: Values; positionals: string[] } {
  const string = { type: "string" } as const;
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": string,
      "node-url": string,
      corridor: string,
      "oxide-token-artifact": string,
      "fee-juice-claim": string,
      "api-url": string,
      "source-wallet": string,
      "source-signature": string,
      "binding-id": string,
      "l1-rpc": string,
      backup: string,
      out: { type: "string", multiple: true },
      checkpoint: string,
      to: string,
      amount: string,
      "l1-recipient": string,
      "prover-tip": string,
      "relayer-tip": string,
      "max-executor-fee": string,
      "broadcaster-artifact": string,
      "refund-evidence": string,
      bundle: string,
      "raw-transaction": string,
      tx: string,
      "already-spent": { type: "boolean" },
      "legacy-binding": { type: "boolean" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}

const readCorridor = (path: string | undefined): Corridor =>
  path ? parseCorridor(JSON.parse(readFileSync(path, "utf8"))) : OXDAI_MAINNET_REV2;

const required = (
  values: Values,
  name: Exclude<
    keyof Values,
    "out" | "dry-run" | "version" | "help" | "already-spent" | "legacy-binding" | "force"
  >,
): string => {
  const v = values[name];
  if (typeof v !== "string" || v.length === 0) fail(`--${String(name)} is required`);
  return v;
};

/** The flag's value, else what a live setup, enroll start or restore saved, else a refusal. */
const flagOrSaved = (
  values: Values,
  name: "node-url" | "oxide-token-artifact",
  savedValue: string | undefined,
  what: string,
): string =>
  values[name] ??
  savedValue ??
  fail(`--${name} is required: no ${what} was saved by setup, enroll start or restore`);

/** Saves the node URL and artifact path a live command used, for `receipt` to reuse. */
async function rememberConnection(store: Store, values: Values): Promise<void> {
  await store.writeState({
    ...(await store.readState()),
    nodeUrl: required(values, "node-url"),
    oxideTokenArtifact: resolve(required(values, "oxide-token-artifact")),
  });
}
const baseUnits = (name: string, v: string): bigint => {
  if (!decimal.safeParse(v).success) fail(`--${name} must be a decimal number of base units`);
  return BigInt(v);
};
/** A signed TokenRegistrationAck in the shape the state and backup files hold. */
const tokenAckForState = (ack: SignedAck | null) => (ack ? SignedAckSchema.parse(ack) : null);

const keystoreCrypto = new NodeKeystoreCrypto();

class Store {
  /** The journals and state.json at today's paths under the data directory. */
  readonly journals: NodeJournals;
  constructor(readonly dir: string) {
    this.journals = openNodeJournals(dir);
  }
  private secureDirectory(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }
  get keystorePath() {
    return join(this.dir, "keystore.sealed");
  }
  get pxeDir() {
    return join(this.dir, "pxe");
  }
  async readState(): Promise<State> {
    return (
      (await this.journals.state.read()) ??
      fail(`no account in ${this.dir}: run init or restore first`)
    );
  }
  writeState(state: State): Promise<void> {
    return this.journals.state.write(state);
  }
  secrets(): Promise<AccountSecrets> {
    return new SealedKeystoreKeySource(
      this.keystorePath,
      () => passphrase(false),
      keystoreCrypto,
    ).accountSecrets();
  }
  async writeKeystore(secrets: AccountSecrets, pass: string): Promise<void> {
    if (existsSync(this.keystorePath))
      fail(`${this.keystorePath} exists: refusing to overwrite an account`);
    this.secureDirectory();
    writePrivateFileExclusive(
      this.keystorePath,
      await keystoreCrypto.seal("keystore", utf8Bytes(JSON.stringify(secrets)), pass),
    );
  }
}

async function port(values: Values, store: Store, state: State): Promise<AztecPort> {
  if (values["dry-run"]) return new DryRunAztec(state.corridor);
  return LiveAztec.connect({
    nodeUrl: required(values, "node-url"),
    walletStorage: new NodeWalletStorage(store.pxeDir),
    scope: state.address,
    corridor: state.corridor,
    l1RpcUrl: values["l1-rpc"] ?? null,
    journal: store.journals.operations,
    attestation: new NodeAttestationVerifier(),
  });
}

function api(values: Values, descriptorDigest: string): EnrollmentApi & ReceiptApi {
  if (values["dry-run"]) {
    return new DryRunEnrollmentApi(Math.floor(systemClock.nowMs() / 1000), descriptorDigest);
  }
  const jwt =
    process.env["XOCHI_JWT"] ?? fail("XOCHI_JWT (the source wallet's SIWE session) is required");
  return new HttpEnrollmentApi(values["api-url"] ?? XOCHI_API_URL, jwt);
}

const log = (line: string) => process.stdout.write(`${line}\n`);

export async function closePortAfterCommand(
  portToClose: Pick<AztecPort, "close">,
  commandFailed: boolean,
  report: (line: string) => void = log,
): Promise<void> {
  try {
    await portToClose.close();
  } catch {
    if (commandFailed) {
      try {
        report("close: PXE shutdown failed after command failure; original failure retained");
      } catch {
        return;
      }
      return;
    }
    throw new Error(
      "recipient PXE shutdown failed after command completion; inspect the operation journal before any retry",
    );
  }
}

async function withAccount<T>(
  values: Values,
  store: Store,
  state: State,
  run: (ctx: Ctx, account: RecipientAccount, state: State) => Promise<T>,
): Promise<T> {
  const account = await deriveRecipientAccount(await store.secrets(), state.corridor);
  if (account.descriptor.aztecAddress !== state.address) {
    fail(`keystore derives ${account.descriptor.aztecAddress}, state names ${state.address}`);
  }
  const p = await port(values, store, state);
  let commandFailed = false;
  try {
    const ctx: Ctx = { corridor: state.corridor, port: p, log, clock: systemClock };
    await checkNetwork(ctx);
    await p.addAccount(account);
    return await run(ctx, account, state);
  } catch (error) {
    commandFailed = true;
    throw error;
  } finally {
    await closePortAfterCommand(p, commandFailed);
    if (p instanceof DryRunAztec) for (const call of p.calls) log(`  [dry-run] ${call}`);
  }
}

/** Registers the token and records when in the state file (a live run only). */
async function registerAndRecord(
  ctx: Ctx,
  store: Store,
  artifact: ContractArtifact,
): Promise<void> {
  const at = await registerToken(ctx, artifact);
  if (ctx.port.mode === "live") {
    await store.writeState({ ...(await store.readState()), tokenRegisteredAt: at });
  }
}

async function tokenArtifact(values: Values, corridor: Corridor): Promise<ContractArtifact> {
  return loadTokenArtifact(required(values, "oxide-token-artifact"), corridor);
}

/**
 * Loads every offline token pin before opening the PXE, then runs an artifact-dependent command.
 * Reading the existing sealed recipient state is side-effect free; no PXE or journal exists yet.
 */
async function withTokenArtifactAccount<T>(
  values: Values,
  store: Store,
  run: (
    ctx: Ctx,
    account: RecipientAccount,
    state: State,
    artifact: ContractArtifact,
  ) => Promise<T>,
): Promise<T> {
  const state = await store.readState();
  const artifact = await tokenArtifact(values, state.corridor);
  return withAccount(values, store, state, (ctx, account, current) =>
    run(ctx, account, current, artifact),
  );
}

/** The whole sequence on the dry-run ports with a throwaway account. */
async function plan(values: Values): Promise<void> {
  const corridor = readCorridor(values.corridor);
  const now = Math.floor(systemClock.nowMs() / 1000);
  const aztec = new DryRunAztec(corridor);
  const xochi = new DryRunEnrollmentApi(now);
  const ctx: Ctx = { corridor, port: aztec, log, clock: systemClock };
  const flush = (label: string) => {
    log(`== ${label}`);
    for (const call of aztec.calls.splice(0)) log(`  [aztec] ${call}`);
    for (const call of xochi.calls.splice(0)) log(`  [xochi] ${call}`);
  };
  log(`corridor ${corridor.name}: manifest ${corridor.manifestDigest}`);

  const secrets = newAccountSecrets();
  const account = await deriveRecipientAccount(secrets, corridor);
  log(
    `init: throwaway account ${account.address.toString()} (descriptor verified by @xochi/signer)`,
  );

  await checkNetwork(ctx);
  flush("network");
  await setupAccount(ctx, account, {
    claimAmount: "1000000000000000000",
    claimSecret: toHex(1n, { size: 32 }),
    messageLeafIndex: "0",
  });
  flush("account");
  await registerSenders(ctx);
  flush("senders");
  const artifactPath = values["oxide-token-artifact"];
  let artifact: ContractArtifact | null = null;
  let tokenRegisteredAt: number | null = null;
  if (artifactPath) {
    artifact = await tokenArtifact(values, corridor);
    log(
      `token: artifact class ${corridor.token.classId} and artifactHash ${corridor.token.artifactHash} verified offline`,
    );
    tokenRegisteredAt = await registerToken(ctx, artifact);
    flush("token");
    await showBalance(ctx, artifact, account);
    flush("balance");
  } else {
    log("token, balance, spend, exit: skipped (no --oxide-token-artifact)");
  }
  const sourceKey = keccak256(toHex("xochi-recipient TEST ONLY dry-run source wallet"));
  const source = privateKeyToAccount(sourceKey);
  const pending = await enrollStart(ctx, xochi, account, source.address, tokenRegisteredAt);
  const sealed = await sealBackup(
    backupContents(
      corridor,
      secrets,
      account,
      null,
      tokenAckForState(pending.tokenRegistrationAck),
      now,
    ),
    "dry-run passphrase TEST ONLY",
    keystoreCrypto,
  );
  log(
    `backup: ${sealed.bytes.length} sealed bytes${pending.tokenRegistrationAck ? " carrying the TokenRegistrationAck" : ""}, backupCommitment ${sealed.commitment}`,
  );
  if (pending.tokenRegistrationAck) {
    const sourceSignature = await source.signTypedData(pending.typedData);
    await enrollSubmit(ctx, xochi, account, pending, sourceSignature, {
      mode: "sealed_file",
      commitment: sealed.commitment,
    });
    await enrollStatus(ctx, xochi, "dry-run-binding", account);
    flush("enrollment (source wallet: a TEST ONLY key; every required acknowledgement verified)");
  } else {
    log(
      "enrollment: submission skipped until --oxide-token-artifact supplies TokenRegistrationAck",
    );
    flush("enrollment preflight (no request submitted)");
  }

  if (artifact) {
    await spend(ctx, account, artifact, corridor.registeredSenders[0]!, 1n);
    flush("spend");
    const broadcasterPath = values["broadcaster-artifact"];
    if (broadcasterPath) {
      await exit(ctx, account, artifact, {
        l1Recipient: source.address,
        amount: 10n ** 18n,
        proverTip: 0n,
        relayerTip: 1n,
        maxExecutorFee: 10n ** 18n,
        broadcasterArtifact: await loadBroadcasterArtifact(broadcasterPath),
      });
      flush("exit");
    } else {
      log("exit: skipped (no --broadcaster-artifact)");
    }
  }
  await aztec.close();
  flush("close");
}

export function formatCliFailure(error: unknown): string {
  const lines = [`xochi-recipient: ${error instanceof Error ? error.message : String(error)}`];
  const diagnostic = operatorDiagnosticLine(error);
  if (diagnostic !== null) lines.push(diagnostic);
  return `${lines.join("\n")}\n`;
}

export function writeCliFailure(
  error: unknown,
  write: (output: string) => void = (output) => process.stderr.write(output),
): void {
  write(formatCliFailure(error));
}

export async function run(argv: string[]): Promise<void> {
  assertSupportedRuntime();
  const { values, positionals } = parse(argv);
  const [command, sub] = positionals;
  if (values.version) {
    log(packageVersion());
    return;
  }
  if (command === "diagnostics") {
    const backupPath = values.backup;
    log(
      JSON.stringify(
        await diagnostics(
          backupPath
            ? { bytes: readFileSync(backupPath), passphrase: await passphrase(false) }
            : undefined,
        ),
      ),
    );
    return;
  }
  if (values.help || !command) {
    log(USAGE);
    return;
  }
  const store = new Store(
    resolve(values["data-dir"] ?? join(process.env["HOME"] ?? ".", ".xochi-recipient")),
  );
  switch (command) {
    case "plan":
      return plan(values);
    case "init": {
      const corridor = readCorridor(values.corridor);
      const secrets = newAccountSecrets();
      const account = await deriveRecipientAccount(secrets, corridor);
      await store.writeKeystore(secrets, await passphrase(true));
      await store.writeState({ corridor, address: account.descriptor.aztecAddress });
      log(
        `init: account ${account.descriptor.aztecAddress} on ${corridor.name}; next: backup, then setup`,
      );
      return;
    }
    case "setup":
      return withTokenArtifactAccount(values, store, async (ctx, account, _state, artifact) => {
        const claimPath = values["fee-juice-claim"];
        const claim = claimPath
          ? FeeJuiceClaimSchema.parse(JSON.parse(readFileSync(claimPath, "utf8")))
          : null;
        await setupAccount(ctx, account, claim);
        await registerSenders(ctx);
        await registerAndRecord(ctx, store, artifact);
        if (ctx.port.mode === "live") await rememberConnection(store, values);
      });
    case "balance":
      return withTokenArtifactAccount(values, store, async (ctx, account, _state, artifact) => {
        await registerAndRecord(ctx, store, artifact);
        await showBalance(ctx, artifact, account);
      });
    case "backup": {
      const outs = values.out ?? [];
      if (outs.length !== 2 || resolve(outs[0]!) === resolve(outs[1]!)) {
        fail("backup needs exactly two different --out paths (two independently retained copies)");
      }
      const state = await store.readState();
      const secrets = await store.secrets();
      const account = await deriveRecipientAccount(secrets, state.corridor);
      const checkpoint = values.checkpoint
        ? Number(baseUnits("checkpoint", values.checkpoint))
        : null;
      const tokenAck = state.tokenRegistrationAck ?? state.pending?.tokenRegistrationAck ?? null;
      const journals = {
        operations: await store.journals.operations.records(),
        exits: await store.journals.exits.records(),
        receipts: await store.journals.receipts.records(),
      };
      // The binding being enrolled (its backup is acknowledged; it has no id yet), else the one
      // enrolled.
      const binding = state.pending
        ? { id: null, digest: bindingTypedData(state.corridor, state.pending.binding).digest }
        : { id: state.bindingId ?? null, digest: state.bindingDigest ?? null };
      const sealed = await sealBackup(
        backupContents(
          state.corridor,
          secrets,
          account,
          checkpoint,
          tokenAck,
          Math.floor(systemClock.nowMs() / 1000),
          journals,
          binding,
        ),
        await passphrase(true),
        keystoreCrypto,
      );
      writeBackupCopies(sealed.bytes, outs[0]!, outs[1]!);
      for (const out of outs) {
        if (keccak256(readFileSync(out)) !== sealed.commitment) fail(`${out} does not read back`);
      }
      await store.writeState({
        ...state,
        backupCommitment: sealed.commitment,
        backupTokenAckSignature: tokenAck?.signature ?? null,
      });
      log(
        `backup: wrote ${outs.join(" and ")}; backupCommitment ${sealed.commitment}. Keep both copies apart.`,
      );
      return;
    }
    case "enroll": {
      if (sub === "start") {
        return withTokenArtifactAccount(
          values,
          store,
          async (ctx, liveAccount, _state, artifact) => {
            const xochi = api(values, hashRecipientDescriptor(liveAccount.descriptor));
            await registerSenders(ctx);
            await registerAndRecord(ctx, store, artifact);
            const registered = await store.readState();
            const pending = await enrollStart(
              ctx,
              xochi,
              liveAccount,
              required(values, "source-wallet"),
              registered.tokenRegisteredAt ?? null,
            );
            const file = join(store.dir, "binding-typed-data.json");
            writeFileSync(file, typedDataJson(pending.typedData) + "\n", { mode: 0o600 });
            chmodSync(file, 0o600);
            await store.writeState({
              ...registered,
              tokenRegistrationAck: tokenAckForState(pending.tokenRegistrationAck),
              pending: {
                challenge: pending.challenge,
                binding: pending.binding,
                tokenRegistrationAck: tokenAckForState(pending.tokenRegistrationAck),
              },
            });
            if (ctx.port.mode === "live") await rememberConnection(store, values);
            log(
              `enroll: sign ${file} with the source wallet (eth_signTypedData_v4), then: enroll submit --source-signature 0x...`,
            );
          },
        );
      }
      const state = await store.readState();
      const account = await deriveRecipientAccount(await store.secrets(), state.corridor);
      const xochi = api(values, hashRecipientDescriptor(account.descriptor));
      const ctx = { corridor: state.corridor, log };
      if (sub === "submit") {
        const saved = state.pending ?? fail("no pending enrollment: run enroll start");
        const commitment =
          state.backupCommitment ?? fail("write the backup first: its commitment is acknowledged");
        const tokenAck = saved.tokenRegistrationAck;
        if (tokenAck && state.backupTokenAckSignature !== tokenAck.signature) {
          fail(
            "write the backup after enroll start, so it carries this binding's TokenRegistrationAck",
          );
        }
        const { typedData, digest: bindingDigest } = bindingTypedData(
          state.corridor,
          saved.binding,
        );
        const pending: PendingEnrollment = { ...saved, typedData };
        const projection = await enrollSubmit(
          ctx,
          xochi,
          account,
          pending,
          required(values, "source-signature"),
          { mode: "sealed_file", commitment: commitment as `0x${string}` },
        );
        const { pending: _done, ...rest } = state;
        await store.writeState({
          ...rest,
          tokenRegistrationAck: tokenAckForState(saved.tokenRegistrationAck),
          bindingId: projection.binding_id,
          bindingDigest,
        });
        const bindingFile = join(store.dir, "binding-typed-data.json");
        if (existsSync(bindingFile)) unlinkSync(bindingFile);
      } else if (sub === "status") {
        await enrollStatus(
          ctx,
          xochi,
          values["binding-id"] ?? state.bindingId ?? fail("--binding-id is required"),
          account,
        );
      } else {
        fail("enroll start | submit | status");
      }
      if (xochi instanceof DryRunEnrollmentApi)
        for (const call of xochi.calls) log(`  [dry-run] ${call}`);
      return;
    }
    case "restore": {
      if (existsSync(store.dir) && readdirSync(store.dir).length !== 0) {
        fail(`${store.dir} is not empty: restore into a fresh --data-dir`);
      }
      const pass = await passphrase(false);
      const backupBytes = readFileSync(required(values, "backup"));
      const contents = await openBackup(backupBytes, pass, keystoreCrypto);
      const secrets = { secret: contents.account.secret, salt: contents.account.salt };
      const account = await deriveRecipientAccount(secrets, contents.corridor);
      if (account.descriptor.aztecAddress !== contents.account.address) {
        fail(
          `backup secrets derive ${account.descriptor.aztecAddress}, not ${contents.account.address}`,
        );
      }
      const artifact = await tokenArtifact(values, contents.corridor);
      const restoredState: State = {
        corridor: contents.corridor,
        address: contents.account.address,
        backupCommitment: keccak256(backupBytes),
        backupTokenAckSignature: contents.tokenRegistrationAck?.signature ?? null,
        tokenRegistrationAck: tokenAckForState(contents.tokenRegistrationAck),
        ...(contents.bindingId ? { bindingId: contents.bindingId } : {}),
        ...(contents.bindingDigest ? { bindingDigest: contents.bindingDigest } : {}),
      };
      await store.writeKeystore(secrets, pass);
      await store.writeState(restoredState);
      await store.journals.operations.restore(contents.journals.operations);
      await store.journals.exits.restore(contents.journals.exits);
      await store.journals.receipts.restore(contents.journals.receipts);
      return withAccount(values, store, restoredState, async (ctx, restored) => {
        const state = await ctx.port.accountState(restored.address);
        if (!state.initialized) fail("the backed-up account is not deployed on this network");
        await registerSenders(ctx);
        await registerAndRecord(ctx, store, artifact);
        if (ctx.port.mode === "live") await rememberConnection(store, values);
        await showBalance(ctx, artifact, restored);
      });
    }
    case "operations": {
      const journal = store.journals.operations;
      if (sub === "reconcile") {
        const state = await store.readState();
        const operation =
          (await journal.activeUnresolved()) ?? fail("no exact lock-owned unresolved operation");
        if (operation.kind.startsWith("refund-")) {
          fail("use refund reconcile for an L1 refund operation");
        }
        if (operation.kind === "receipt") {
          // A receipt run moved no funds. Its lock is released only once its process is gone,
          // or with --force when the recorded pid was reused after a crash.
          if (values.force) {
            log(
              `WARNING: --force releases the lock of receipt run pid ${operation.request["pid"]} on ${operation.request["host"]}; if that run is still active, a spend or exit may now run beside it`,
            );
          }
          await journal.releaseReceiptLock(operation.id, { force: values.force ?? false });
          log(
            `operation ${operation.id}: released the lock of receipt run pid ${operation.request["pid"]} on ${operation.request["host"]} (it moved no funds)`,
          );
          return;
        }
        const txHash =
          operation.txHash ??
          fail("the send returned no transaction hash; absence cannot be proven automatically");
        const node = createAztecNodeClient(required(values, "node-url"));
        const [info, block1] = await Promise.all([
          node.getNodeInfo(),
          node.getBlockData(BlockNumber(1)),
        ]);
        if (!block1) fail("the node has no block 1; it cannot prove the network identity");
        assertPinnedNetwork(
          {
            l1ChainId: String(info.l1ChainId),
            rollupVersion: String(info.rollupVersion),
            rollupAddress: info.l1ContractAddresses.rollupAddress.toString(),
            block1LastArchiveRoot: block1.header.lastArchive.root.toString(),
            nodeVersion: info.nodeVersion,
          },
          state.corridor,
        );
        const receipt = await node.getTxReceipt(TxHash.fromString(txHash));
        if (!durablyIncluded(receipt.status))
          fail(`operation receipt is ${receipt.status}; it remains blocked until checkpointed`);
        await journal.update(operation.id, {
          status: "complete",
          receiptStatus: receipt.status,
        });
        log(`operation ${operation.id}: reconciled from mined receipt ${receipt.status}`);
      } else {
        log(JSON.stringify(await journal.records(), null, 2));
      }
      return;
    }
    case "spend":
      return withTokenArtifactAccount(values, store, async (ctx, account, _state, artifact) => {
        await registerAndRecord(ctx, store, artifact);
        await spend(
          ctx,
          account,
          artifact,
          required(values, "to"),
          baseUnits("amount", required(values, "amount")),
        );
      });
    case "exit":
      return withTokenArtifactAccount(values, store, async (ctx, account, _state, artifact) => {
        await registerAndRecord(ctx, store, artifact);
        const result = await exit(ctx, account, artifact, {
          l1Recipient: required(values, "l1-recipient"),
          amount: baseUnits("amount", required(values, "amount")),
          proverTip: baseUnits("prover-tip", required(values, "prover-tip")),
          relayerTip: baseUnits("relayer-tip", required(values, "relayer-tip")),
          maxExecutorFee: baseUnits("max-executor-fee", required(values, "max-executor-fee")),
          broadcasterArtifact: await loadBroadcasterArtifact(
            required(values, "broadcaster-artifact"),
          ),
          feeJuiceClaim: values["fee-juice-claim"]
            ? FeeJuiceClaimSchema.parse(JSON.parse(readFileSync(values["fee-juice-claim"], "utf8")))
            : undefined,
        });
        if (ctx.port.mode === "live") {
          // The record anyone needs to finalize the withdrawal on L1; written per exit tx.
          await store.journals.exits.record(result);
          log(`exit: record written to ${store.journals.exits.path(result.txHash)}`);
        }
      });
    case "receipt": {
      const intentId = assertIntentId(
        sub ?? fail("receipt needs the intent id: receipt INTENT_ID"),
      );
      // Before the artifact preflight: a binding id conflict needs no file.
      const saved = await store.readState();
      const legacyBindingId = values["binding-id"] ?? null;
      if (legacyBindingId !== null && !values["legacy-binding"]) {
        fail("--binding-id is only for receipt --legacy-binding");
      }
      if (legacyBindingId !== null && saved.bindingId && legacyBindingId !== saved.bindingId) {
        fail(
          `--binding-id ${legacyBindingId} is not this data directory's enrolled binding id ${saved.bindingId}`,
        );
      }
      // The offline artifact preflight runs first, as for every artifact command.
      const artifact = await loadTokenArtifact(
        flagOrSaved(
          values,
          "oxide-token-artifact",
          saved.oxideTokenArtifact,
          "OxideToken artifact path",
        ),
        saved.corridor,
      );
      const resolved: Values = values["dry-run"]
        ? values
        : { ...values, "node-url": flagOrSaved(values, "node-url", saved.nodeUrl, "node URL") };
      return withAccount(resolved, store, saved, async (ctx, account, state) => {
        await registerAndRecord(ctx, store, artifact);
        const xochi = api(resolved, hashRecipientDescriptor(account.descriptor));
        try {
          const receipts = store.journals.receipts;
          const record = await receipt(
            ctx,
            xochi,
            account,
            artifact,
            { receipts, operations: store.journals.operations },
            {
              intentId,
              tx: values.tx ?? null,
              alreadySpent: values["already-spent"] ?? false,
              bindingDigest: state.bindingDigest ?? null,
              bindingId: state.bindingId ?? legacyBindingId,
              legacyBinding: values["legacy-binding"] ?? false,
              rememberBindingDigest: async (bindingDigest, bindingId) => {
                const current = await store.readState();
                await store.writeState({
                  ...current,
                  bindingDigest,
                  bindingId: current.bindingId ?? bindingId,
                });
              },
              dryRun: ctx.port.mode === "dry-run",
            },
          );
          if (record) log(`receipt: recorded in ${receipts.path(intentId)}`);
        } finally {
          if (xochi instanceof DryRunEnrollmentApi) {
            for (const call of xochi.calls) log(`  [dry-run] ${call}`);
          }
        }
      });
    }
    case "refund": {
      const state = await store.readState();
      const account = await deriveRecipientAccount(await store.secrets(), state.corridor);
      const journal = store.journals.operations;
      if (sub === "authorize") {
        const evidence = RefundEvidenceSchema.parse(
          JSON.parse(readFileSync(required(values, "refund-evidence"), "utf8")),
        );
        const authorization = await authorizeRefund(
          account,
          state.corridor,
          evidence,
          required(values, "l1-recipient"),
          baseUnits("relayer-tip", values["relayer-tip"] ?? "0"),
        );
        const outs = values.out ?? [];
        if (outs.length !== 1) fail("refund authorize needs exactly one --out path");
        writePrivateFileExclusive(
          outs[0]!,
          utf8Bytes(`${JSON.stringify(authorization, null, 2)}\n`),
        );
        log("refund authorization written");
      } else if (sub === "submit") {
        const bundle = RefundBundleSchema.parse(
          JSON.parse(readFileSync(required(values, "bundle"), "utf8")),
        );
        const rawTransaction = readFileSync(required(values, "raw-transaction"), "utf8").trim();
        await submitRefund({
          account,
          corridor: state.corridor,
          bundleInput: bundle,
          rawTransaction,
          rpcUrl: required(values, "l1-rpc"),
          journal,
        });
        log("refund submission recorded; use refund reconcile");
      } else if (sub === "reconcile") {
        const outcome = await reconcileRefund(journal, required(values, "l1-rpc"), state.corridor);
        log(
          outcome === "finalized"
            ? "refund finalized"
            : "refund finalized reverted; lock released; create a new authorization before any attempt",
        );
      } else {
        fail("refund authorize | submit | reconcile");
      }
      return;
    }
    default:
      fail(`unknown command ${command}\n\n${USAGE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      writeCliFailure(error);
      process.exit(1);
    },
  );
}
