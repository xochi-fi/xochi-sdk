#!/usr/bin/env node
// xochi-recipient: the Xochi OXDAI recipient tool (xochi#759). See README.md.
//
// It contacts only the Aztec node you name (--node-url), the Xochi enrollment API (--api-url,
// enroll commands only), the zk.money enclave and an L1 JSON-RPC you name (--l1-rpc; spend,
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
} from "./account.js";
import { DryRunEnrollmentApi, HttpEnrollmentApi, type EnrollmentApi } from "./api.js";
import {
  backupContents,
  openBackup,
  readExitJournal,
  restoreExitJournal,
  sealBackup,
  writeBackupCopies,
  writePrivateFileExclusive,
} from "./backup.js";
import { DryRunAztec, LiveAztec, type AztecPort } from "./chain.js";
import {
  checkNetwork,
  enrollStart,
  enrollStatus,
  enrollSubmit,
  exit,
  registerSenders,
  registerToken,
  setupAccount,
  showBalance,
  spend,
  type Ctx,
  type PendingEnrollment,
} from "./commands.js";
import { CorridorSchema, OXDAI_MAINNET_REV2, parseCorridor, type Corridor } from "./corridor.js";
import { bindingTypedData, typedDataJson, type SignedAck } from "./enrollment.js";
import { SignedAckSchema } from "./backup.js";
import { assertPinnedNetwork } from "./network.js";
import { loadBroadcasterArtifact } from "./broadcaster-artifact.js";
import { loadTokenArtifact } from "./oxide-token.js";
import { OperationJournal } from "./operation-journal.js";
import { durablyIncluded } from "./reconciliation.js";
import { open, seal } from "./sealed.js";
import {
  RefundBundleSchema,
  RefundEvidenceSchema,
  authorizeRefund,
  reconcileRefund,
  submitRefund,
} from "./refund.js";
import { assertSupportedRuntime, diagnostics, packageVersion } from "./release-info.js";
import { operatorDiagnosticLine } from "./safe-diagnostic.js";

const USAGE = `xochi-recipient <command> [options]

Commands (in round-trip order):
  init                     create the account secrets on this machine (sealed keystore)
  setup                    check the network; publish + initialize the account; register the
                           corridor senders and the OxideToken (+ store_immutables)
  balance                  sync and show the OXDAI balance and received payouts' order fingerprints
  backup --out A --out B   write two encrypted copies, including spend/exit/refund journals
  enroll start             request a challenge; write the binding the source wallet signs
  enroll submit            sign and submit the authorization plus the Worker's required
                           acknowledgements, including TokenRegistrationAck for OXDAI
  enroll status            show the binding state (pending / ready / revoked)
  restore --backup FILE    restore into a fresh data directory/PXE and find the balance
  spend --to ADDR --amount BASEUNITS
  exit --l1-recipient ADDR --amount BASEUNITS --prover-tip N --relayer-tip N --max-executor-fee N --broadcaster-artifact FILE
  operations [reconcile]   show journal, or reconcile its recorded Aztec transaction
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
  --fee-juice-claim FILE       Xochi's sponsored Fee Juice claim for the deployment (setup)
  --api-url URL                Xochi API (enroll); bearer from XOCHI_JWT
  --source-wallet ADDR         enroll start
  --source-signature SIG       enroll submit
  --binding-id ID              enroll status
  --l1-rpc URL                 L1 JSON-RPC of your choice (spend, exit, refund)
  --max-executor-fee BASEUNITS maximum acceptable live PlainWithdrawalExecutor fee for exit
  --refund-evidence FILE       recipient-owned evidence produced by the pinned upstream refund builder
  --bundle FILE                completed refund bundle (refund submit)
  --raw-transaction FILE       externally signed exact refund transaction (refund submit)
  --l1-recipient ADDR          fixed recipient for exit or refund authorization
  --dry-run                    record every node, PXE and API call; perform none
  --version                    print the test artifact version
Passphrase: XOCHI_RECIPIENT_PASSPHRASE, else prompted.`;

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const BindingSchema = z
  .object({
    sourceWallet: z.string().regex(/^0x[0-9a-f]{40}$/),
    sourceChainId: decimal,
    aztecRecipient: hex32,
    aztecToken: hex32,
    descriptorDigest: hex32,
    corridorId: hex32,
    corridorRevision: decimal,
    manifestDigest: hex32,
    nonce: hex32,
    challengeExpiry: decimal,
    purpose: z.string(),
  })
  .strict();
const StateSchema = z
  .object({
    corridor: CorridorSchema,
    address: hex32,
    backupCommitment: hex32.optional(),
    pending: z
      .object({
        challenge: z
          .object({ challenge_id: z.string(), nonce: z.string(), expires_at: z.number().int() })
          .strict(),
        binding: BindingSchema,
        tokenRegistrationAck: SignedAckSchema.nullable(),
      })
      .strict()
      .optional(),
    bindingId: z.string().optional(),
    /** The TokenRegistrationAck signature the last backup carries, if any. */
    backupTokenAckSignature: z.string().nullable().optional(),
    /** Unix seconds of this data directory's last successful token registration. */
    tokenRegisteredAt: z.number().int().positive().optional(),
    /** Last signed TokenRegistrationAck, preserved across submit, backup and restore. */
    tokenRegistrationAck: SignedAckSchema.nullable().optional(),
  })
  .strict();
type State = z.infer<typeof StateSchema>;
const SecretsSchema = z.object({ secret: hex32, salt: hex32 }).strict();
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
  name: Exclude<keyof Values, "out" | "dry-run" | "version" | "help">,
): string => {
  const v = values[name];
  if (typeof v !== "string" || v.length === 0) fail(`--${String(name)} is required`);
  return v;
};
const baseUnits = (name: string, v: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(v)) fail(`--${name} must be a decimal number of base units`);
  return BigInt(v);
};
/** A signed TokenRegistrationAck in the shape the state and backup files hold. */
const tokenAckForState = (ack: SignedAck | null) => (ack ? SignedAckSchema.parse(ack) : null);

class Store {
  constructor(readonly dir: string) {}
  private secureDirectory(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }
  get keystorePath() {
    return join(this.dir, "keystore.sealed");
  }
  get statePath() {
    return join(this.dir, "state.json");
  }
  get pxeDir() {
    return join(this.dir, "pxe");
  }
  readState(): State {
    if (!existsSync(this.statePath)) fail(`no account in ${this.dir}: run init or restore first`);
    return StateSchema.parse(JSON.parse(readFileSync(this.statePath, "utf8")));
  }
  writeState(state: State): void {
    this.secureDirectory();
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.statePath, 0o600);
  }
  async secrets(): Promise<AccountSecrets> {
    const opened = open("keystore", readFileSync(this.keystorePath), await passphrase(false));
    return SecretsSchema.parse(JSON.parse(opened.toString("utf8")));
  }
  writeKeystore(secrets: AccountSecrets, pass: string): void {
    if (existsSync(this.keystorePath))
      fail(`${this.keystorePath} exists: refusing to overwrite an account`);
    this.secureDirectory();
    writePrivateFileExclusive(
      this.keystorePath,
      seal("keystore", Buffer.from(JSON.stringify(secrets)), pass),
    );
  }
}

async function port(values: Values, store: Store, corridor: Corridor): Promise<AztecPort> {
  if (values["dry-run"]) return new DryRunAztec(corridor);
  mkdirSync(store.pxeDir, { recursive: true, mode: 0o700 });
  return LiveAztec.connect({
    nodeUrl: required(values, "node-url"),
    dataDirectory: store.pxeDir,
    corridor,
    l1RpcUrl: values["l1-rpc"] ?? null,
  });
}

function api(values: Values, descriptorDigest: string): EnrollmentApi {
  if (values["dry-run"]) {
    return new DryRunEnrollmentApi(Math.floor(Date.now() / 1000), descriptorDigest);
  }
  const jwt =
    process.env["XOCHI_JWT"] ?? fail("XOCHI_JWT (the source wallet's SIWE session) is required");
  return new HttpEnrollmentApi(required(values, "api-url"), jwt);
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
      report("close: PXE shutdown failed after command failure; original failure retained");
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
  const p = await port(values, store, state.corridor);
  let commandFailed = false;
  try {
    const ctx: Ctx = { corridor: state.corridor, port: p, log };
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
  if (ctx.port.mode === "live") store.writeState({ ...store.readState(), tokenRegisteredAt: at });
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
  const state = store.readState();
  const artifact = await tokenArtifact(values, state.corridor);
  return withAccount(values, store, state, (ctx, account, current) =>
    run(ctx, account, current, artifact),
  );
}

/** The whole sequence on the dry-run ports with a throwaway account. */
async function plan(values: Values): Promise<void> {
  const corridor = readCorridor(values.corridor);
  const now = Math.floor(Date.now() / 1000);
  const aztec = new DryRunAztec(corridor);
  const xochi = new DryRunEnrollmentApi(now);
  const ctx: Ctx = { corridor, port: aztec, log };
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
  const sealed = sealBackup(
    backupContents(
      corridor,
      secrets,
      account,
      null,
      tokenAckForState(pending.tokenRegistrationAck),
      now,
    ),
    "dry-run passphrase TEST ONLY",
  );
  log(
    `backup: ${sealed.bytes.length} sealed bytes${pending.tokenRegistrationAck ? " carrying the TokenRegistrationAck" : ""}, backupCommitment ${sealed.commitment}`,
  );
  if (pending.tokenRegistrationAck) {
    const sourceSignature = await source.signTypedData(pending.typedData);
    await enrollSubmit(ctx, xochi, account, pending, sourceSignature, sealed.commitment);
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
        diagnostics(
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
      store.writeKeystore(secrets, await passphrase(true));
      store.writeState({ corridor, address: account.descriptor.aztecAddress });
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
      const state = store.readState();
      const secrets = await store.secrets();
      const account = await deriveRecipientAccount(secrets, state.corridor);
      const checkpoint = values.checkpoint
        ? Number(baseUnits("checkpoint", values.checkpoint))
        : null;
      const tokenAck = state.tokenRegistrationAck ?? state.pending?.tokenRegistrationAck ?? null;
      const journals = {
        operations: new OperationJournal(join(store.dir, "operations")).records(),
        exits: readExitJournal(join(store.dir, "exits")),
      };
      const sealed = sealBackup(
        backupContents(
          state.corridor,
          secrets,
          account,
          checkpoint,
          tokenAck,
          Math.floor(Date.now() / 1000),
          journals,
        ),
        await passphrase(true),
      );
      writeBackupCopies(sealed.bytes, outs[0]!, outs[1]!);
      for (const out of outs) {
        if (keccak256(readFileSync(out)) !== sealed.commitment) fail(`${out} does not read back`);
      }
      store.writeState({
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
            const registered = store.readState();
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
            store.writeState({
              ...registered,
              tokenRegistrationAck: tokenAckForState(pending.tokenRegistrationAck),
              pending: {
                challenge: pending.challenge,
                binding: pending.binding,
                tokenRegistrationAck: tokenAckForState(pending.tokenRegistrationAck),
              },
            });
            log(
              `enroll: sign ${file} with the source wallet (eth_signTypedData_v4), then: enroll submit --source-signature 0x...`,
            );
          },
        );
      }
      const state = store.readState();
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
        const pending: PendingEnrollment = {
          ...saved,
          typedData: bindingTypedData(state.corridor, saved.binding).typedData,
        };
        const projection = await enrollSubmit(
          ctx,
          xochi,
          account,
          pending,
          required(values, "source-signature"),
          commitment,
        );
        const { pending: _done, ...rest } = state;
        store.writeState({
          ...rest,
          tokenRegistrationAck: tokenAckForState(saved.tokenRegistrationAck),
          bindingId: projection.binding_id,
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
      const contents = openBackup(backupBytes, pass);
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
      };
      store.writeKeystore(secrets, pass);
      store.writeState(restoredState);
      new OperationJournal(join(store.dir, "operations")).restore(contents.journals.operations);
      restoreExitJournal(join(store.dir, "exits"), contents.journals.exits);
      return withAccount(values, store, restoredState, async (ctx, restored) => {
        const state = await ctx.port.accountState(restored.address);
        if (!state.initialized) fail("the backed-up account is not deployed on this network");
        await registerSenders(ctx);
        await registerAndRecord(ctx, store, artifact);
        await showBalance(ctx, artifact, restored);
      });
    }
    case "operations": {
      const journal = new OperationJournal(join(store.dir, "operations"));
      if (sub === "reconcile") {
        const state = store.readState();
        const operation =
          journal.activeUnresolved() ?? fail("no exact lock-owned unresolved operation");
        if (operation.kind.startsWith("refund-")) {
          fail("use refund reconcile for an L1 refund operation");
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
        journal.update(operation.id, {
          status: "complete",
          receiptStatus: receipt.status,
        });
        log(`operation ${operation.id}: reconciled from mined receipt ${receipt.status}`);
      } else {
        log(JSON.stringify(journal.records(), null, 2));
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
        });
        if (ctx.port.mode === "live") {
          // The record anyone needs to finalize the withdrawal on L1; written per exit tx.
          const dir = join(store.dir, "exits");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = join(dir, `${result.txHash}.json`);
          writeFileSync(file, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          log(`exit: record written to ${file}`);
        }
      });
    case "refund": {
      const state = store.readState();
      const account = await deriveRecipientAccount(await store.secrets(), state.corridor);
      const journal = new OperationJournal(join(store.dir, "operations"));
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
          Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`),
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
