// The facade (`openRecipientCore`) over the memory storage and lock ports, a DryRunAztec-based
// node and the Xochi API behind a stubbed global `fetch`: no network, no PXE, no Node adapter.

import { inspect } from "node:util";

import { keccak256, toHex } from "viem";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deriveRecipientAccount, type RecipientAccount } from "../src/account.js";
import { BACKUP_FORMAT_PASSKEY_V1_ID } from "../src/backup-mode.js";
import { backupContents, sealBackup, type BackupContents } from "../src/backup.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "../src/corridor.js";
import {
  openRecipientCore,
  restoreJournals,
  type BackupMode,
  type RecipientCore,
  type RecipientCoreDeps,
} from "../src/core.js";
import { bindingTypedData } from "../src/enrollment.js";
import {
  OperationJournal,
  operationsLockName,
  type OperationRecord,
} from "../src/operation-journal.js";
import type { KeystoreCrypto, RecipientKeySource } from "../src/ports.js";
import { StateStore } from "../src/state.js";
import { FixedClock, MemoryKeyValueStore, MemoryLockManager } from "./support/memory.js";
import {
  BINDING_ID,
  INTENT,
  NOW,
  PayoutNode,
  SOURCE,
  TEST_SECRETS,
  TOKEN_ARTIFACT_JSON,
  XochiApi,
  bindingFor,
  challengeFor,
  hex,
  payoutFor,
  termsFor,
  testCorridor,
} from "./support/recipient.js";

const SEALED = { mode: "sealed_file", commitment: hex("bc") } as const satisfies BackupMode;
const PASSKEY: BackupMode = {
  mode: "passkey",
  credentialIdHash: keccak256(toHex("TEST ONLY credential id")),
  rpId: "xochi.fi",
  derivationVersion: 1,
};

/** A `KeystoreCrypto` double: "seals" by prefixing the kind (the facade never opens one here). */
const crypto: KeystoreCrypto = {
  async seal(kind, plaintext) {
    return new Uint8Array([...new TextEncoder().encode(`${kind}:`), ...plaintext]);
  },
  async open(kind, sealed) {
    return sealed.slice(`${kind}:`.length);
  },
};

let corridor: Corridor;
let account: RecipientAccount;

beforeAll(async () => {
  corridor = await testCorridor();
  account = await deriveRecipientAccount(TEST_SECRETS, corridor);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Harness {
  deps: RecipientCoreDeps;
  kv: MemoryKeyValueStore;
  locks: MemoryLockManager;
  node: PayoutNode;
  xochi: XochiApi;
  open(): Promise<RecipientCore>;
}

function harness(keys: RecipientKeySource = { kind: "keystore", accountSecrets }): Harness {
  const kv = new MemoryKeyValueStore();
  const locks = new MemoryLockManager();
  const node = new PayoutNode(corridor);
  const xochi = new XochiApi();
  xochi.corridor = corridor;
  xochi.account = account;
  vi.stubGlobal("fetch", xochi.fetch);
  const deps: RecipientCoreDeps = {
    corridor,
    keys,
    kv,
    locks,
    artifacts: {
      tokenArtifact: async () => TOKEN_ARTIFACT_JSON,
      broadcasterArtifact: async () => {
        throw new Error("TEST ONLY: no broadcaster artifact");
      },
    },
    attestation: {
      verifyNitroAttestation: async () => {
        throw new Error("TEST ONLY: no enclave");
      },
    },
    walletStorage: {
      embeddedWalletOptions: async () => {
        throw new Error("TEST ONLY: the node double needs no wallet storage");
      },
    },
    clock: new FixedClock(NOW * 1000),
    fetch: (input, init) => fetch(input, init),
    log: () => undefined,
    nodeUrl: "http://127.0.0.1:9/TEST-ONLY",
    l1RpcUrl: null,
    api: { baseUrl: "https://api.xochi.fi", jwt: async () => "TEST ONLY jwt" },
  };
  return { deps, kv, locks, node, xochi, open: () => openRecipientCore(deps, async () => node) };
}

async function accountSecrets() {
  return TEST_SECRETS;
}

async function enroll(core: RecipientCore, backup: BackupMode = SEALED) {
  const pending = await core.enrollStart(SOURCE.address);
  const signature = await SOURCE.signTypedData(pending.typedData);
  return { pending, signature, projection: await core.enrollSubmit(pending, signature, backup) };
}

const stateOf = (kv: MemoryKeyValueStore) => new StateStore(kv).read();

describe("openRecipientCore", () => {
  it("records the recipient on first open and adds the account to the PXE", async () => {
    const h = harness();
    const core = await h.open();
    expect(core.account.address.toString()).toBe(account.address.toString());
    expect(await stateOf(h.kv)).toEqual({ corridor, address: account.descriptor.aztecAddress });
    expect(h.node.calls.some((call) => call.startsWith("wallet.createSchnorrAccount"))).toBe(true);
    await core.close();
    expect(h.node.closed).toBe(1);
  });

  it("closes the node when a check after connecting fails", async () => {
    const h = harness();
    h.node.network = { l1ChainId: "11155111" };
    await expect(h.open()).rejects.toThrow(/l1ChainId|network/);
    expect(h.node.closed).toBe(1);
  });

  it("refuses a profile that records another corridor", async () => {
    const h = harness();
    await new StateStore(h.kv).write({
      corridor: OXDAI_MAINNET_REV2,
      address: account.descriptor.aztecAddress,
    });
    await expect(h.open()).rejects.toThrow(
      `this profile records corridor ${OXDAI_MAINNET_REV2.name} (token ${OXDAI_MAINNET_REV2.token.address}), not this core's`,
    );
  });

  it("refuses with a clear error when globalThis.Buffer is missing", async () => {
    const h = harness();
    vi.stubGlobal("Buffer", undefined);
    await expect(h.open()).rejects.toThrow(
      "@xochi/recipient-core needs globalThis.Buffer: install the buffer package's Buffer as globalThis.Buffer before importing it",
    );
  });

  it("keeps the deps and secret account out of inspect, JSON and own values", async () => {
    const h = harness();
    const core = await h.open();
    // The salt is public (the descriptor carries it); the secret and signing key never are.
    const secrets = [TEST_SECRETS.secret, account.signingKey.toString()].map((value) =>
      value.toLowerCase().replace(/^0x/, ""),
    );
    const bigints = (_key: string, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value;
    for (const view of [
      inspect(core, { showHidden: true, depth: Infinity, getters: true }),
      JSON.stringify(core, bigints),
      inspect(Object.values(core), { showHidden: true, depth: Infinity }),
      JSON.stringify(Object.values(core), bigints),
    ]) {
      for (const secret of secrets) expect(view.toLowerCase()).not.toContain(secret);
    }
    await core.close();
  });
});

describe("enrollment", () => {
  it("submits a sealed-file binding and records its id, digest and commitment", async () => {
    const h = harness();
    const core = await h.open();
    const { pending, projection } = await enroll(core);

    expect(projection).toMatchObject({ binding_id: BINDING_ID, state: "pending" });
    expect(await stateOf(h.kv)).toMatchObject({
      bindingId: BINDING_ID,
      bindingDigest: bindingTypedData(corridor, pending.binding).digest,
      backupCommitment: SEALED.commitment,
    });
    expect((await stateOf(h.kv))?.pending).toBeUndefined();
    const request = h.xochi.calls.find((call) => call.path === "/api/shielded/recipients")!;
    expect(request.body).not.toHaveProperty("backup_passkey");
    await core.close();
  });

  it("refuses the passkey backup mode for a recipient whose keys are not a passkey's, before any POST", async () => {
    const h = harness({ kind: "imported", accountSecrets });
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    const before = h.xochi.posts();

    await expect(core.enrollSubmit(pending, signature, PASSKEY)).rejects.toThrow(
      "the passkey backup mode is only for a passkey recipient; this recipient's keys are imported: acknowledge its sealed backup file",
    );
    expect(h.xochi.posts()).toEqual(before);
    await core.close();
  });

  // The core pins @xochi/signer 0.7.0, whose hashRecipientAck refuses the passkey format id.
  it("refuses the passkey backup mode under @xochi/signer 0.7.0, before any POST", async () => {
    const h = harness({ kind: "passkey", accountSecrets });
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    const before = h.xochi.posts();

    await expect(core.enrollSubmit(pending, signature, PASSKEY)).rejects.toThrow(
      `the passkey backup mode requires @xochi/signer >= 0.8.0 (it signs format ${BACKUP_FORMAT_PASSKEY_V1_ID})`,
    );
    expect(h.xochi.posts()).toEqual(before);
    await core.close();
  });

  it("waits for another session's state lease before its read-modify-write", async () => {
    const h = harness();
    const core = await h.open();
    const name = `${operationsLockName(account.descriptor.aztecAddress)}:state`;
    const lease = await h.locks.tryAcquire(name, { id: "other-tab", nonce: "1", kind: "state" });
    let settled = false;
    const started = core.enrollStart(SOURCE.address).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect((await stateOf(h.kv))?.pending).toBeUndefined();

    await lease!.release();
    await started;
    expect((await stateOf(h.kv))?.pending).toMatchObject({
      challenge: { challenge_id: "TEST-ONLY-challenge" },
    });
    expect(h.locks.held.has(name)).toBe(false);
    await core.close();
  });
});

describe("receipts", () => {
  it("signReceipt journals the receipt submitting before it resolves; submitReceipt posts it", async () => {
    const h = harness();
    const core = await h.open();
    await enroll(core);
    const binding = bindingFor(corridor, account);
    const digest = (await stateOf(h.kv))!.bindingDigest!;
    const terms = termsFor(corridor, account, digest);
    h.xochi.binding = binding;
    h.xochi.receiptChallenge = challengeFor(corridor, account, digest, terms);
    h.node.payouts = [payoutFor(corridor, account, terms)];

    const signed = await core.signReceipt(INTENT);
    expect(signed).toMatchObject({ intentId: INTENT, status: "submitting", txHash: hex("a7") });
    expect(h.kv.durableJson(`receipts/${INTENT}.json`)).toMatchObject({ status: "submitting" });
    expect(h.xochi.posts()).not.toContain(`/api/shielded/operations/${INTENT}/receipt`);

    const submitted = await core.submitReceipt(INTENT);
    expect(submitted).toMatchObject({ intentId: INTENT, status: "submitted", txHash: hex("a7") });
    expect(h.xochi.posts().filter((path) => path.endsWith(`${INTENT}/receipt`))).toHaveLength(1);
    expect(h.kv.durableJson(`receipts/${INTENT}.json`)).toMatchObject({ status: "submitted" });
    await core.close();
  });
});

describe("restoreJournals", () => {
  async function journalRecords(build: (journal: OperationJournal) => Promise<void>) {
    const journal = new OperationJournal({
      kv: new MemoryKeyValueStore(),
      locks: new MemoryLockManager(),
      clock: new FixedClock(NOW * 1000),
      lockName: operationsLockName(account.descriptor.aztecAddress),
      holder: { pid: 7, host: "TEST ONLY cli" },
    });
    await build(journal);
    return journal.records();
  }

  function backupOf(
    operations: OperationRecord[],
    backupCorridor: Corridor = corridor,
    binding: { id: string | null; digest: string | null } = {
      id: "TEST-ONLY-restored-binding",
      digest: hex("d1"),
    },
  ): BackupContents {
    return backupContents(
      backupCorridor,
      TEST_SECRETS,
      account,
      null,
      null,
      NOW,
      { operations, exits: [], receipts: [] },
      binding,
    );
  }

  it("restores into an empty profile and records the backup's commitment and binding", async () => {
    const h = harness();
    const core = await h.open();
    const operations = await journalRecords(async (journal) => {
      const spend = await journal.begin("spend", { amount: "1" });
      await journal.update(spend.id, { status: "broadcast", txHash: hex("12") });
      await journal.update(spend.id, { status: "complete", txHash: hex("12") });
    });
    const contents = backupOf(operations);
    const sealed = await sealBackup(contents, "TEST ONLY long passphrase", crypto);

    await restoreJournals(core, contents, sealed.bytes);

    expect(await stateOf(h.kv)).toMatchObject({
      bindingId: "TEST-ONLY-restored-binding",
      bindingDigest: hex("d1"),
      backupCommitment: sealed.commitment,
      backupTokenAckSignature: null,
      tokenRegistrationAck: null,
    });
    expect(h.kv.json(`operations/${operations[0]!.id}.json`)).toMatchObject({
      status: "complete",
    });
    await core.close();
  });

  it("refuses a profile whose journals are not empty, writing nothing", async () => {
    const h = harness();
    const core = await h.open();
    await enroll(core);
    const binding = bindingFor(corridor, account);
    const digest = (await stateOf(h.kv))!.bindingDigest!;
    const terms = termsFor(corridor, account, digest);
    h.xochi.binding = binding;
    h.xochi.receiptChallenge = challengeFor(corridor, account, digest, terms);
    h.node.payouts = [payoutFor(corridor, account, terms)];
    await core.signReceipt(INTENT);
    const state = await stateOf(h.kv);
    const contents = backupOf([], corridor, { id: null, digest: null });

    await expect(
      restoreJournals(
        core,
        contents,
        (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes,
      ),
    ).rejects.toThrow("restoreJournals needs a profile with empty journals");
    expect(await stateOf(h.kv)).toEqual(state);
    await core.close();
  });

  it("refuses a backup with an unresolved operation: reconcile it with the CLI first", async () => {
    const h = harness();
    const core = await h.open();
    const operations = await journalRecords(async (journal) => {
      await journal.begin("exit", { amount: "1" });
    });
    const contents = backupOf(operations);

    await expect(
      restoreJournals(
        core,
        contents,
        (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes,
      ),
    ).rejects.toThrow(
      `the backup's exit operation ${operations[0]!.id} is building: reconcile it with the CLI first (xochi-recipient operations reconcile), then back up again`,
    );
    expect(h.kv.entries.has(`operations/${operations[0]!.id}.json`)).toBe(false);
    await core.close();
  });

  it("refuses a backup of another corridor", async () => {
    const h = harness();
    const core = await h.open();
    const contents = backupOf([], OXDAI_MAINNET_REV2);

    await expect(
      restoreJournals(
        core,
        contents,
        (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes,
      ),
    ).rejects.toThrow(
      `the backup is for corridor ${OXDAI_MAINNET_REV2.name} (token ${OXDAI_MAINNET_REV2.token.address}), not this core's`,
    );
    await core.close();
  });

  it("refuses a profile enrolled with another binding, writing nothing", async () => {
    const h = harness();
    const core = await h.open();
    await enroll(core);
    const state = await stateOf(h.kv);
    const contents = backupOf([]);
    const sealed = (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes;

    await expect(restoreJournals(core, contents, sealed)).rejects.toThrow(
      `this profile is enrolled with binding ${BINDING_ID}; the backup's is TEST-ONLY-restored-binding`,
    );
    expect(await stateOf(h.kv)).toEqual(state);
    expect(h.kv.text("restore.lock")).toBeNull();
    await core.close();
  });

  it("refuses without the sealed bytes before writing any journal", async () => {
    const h = harness();
    const core = await h.open();
    const operations = await journalRecords(async (journal) => {
      const spend = await journal.begin("spend", { amount: "1" });
      await journal.update(spend.id, { status: "aborted" });
    });

    await expect(
      restoreJournals(core, backupOf(operations), undefined as unknown as Uint8Array),
    ).rejects.toThrow("restoreJournals needs the sealed backup bytes importCliBackup opened");
    expect(await h.kv.list("operations/")).toEqual([]);
    await core.close();
  });

  it("holds the restore marker: no receipt or fund movement starts while it exists", async () => {
    const h = harness();
    const core = await h.open();
    const contents = backupOf([]);
    const sealed = (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes;
    await h.kv.create("restore.lock", new Uint8Array([1]));

    await expect(restoreJournals(core, contents, sealed)).rejects.toThrow(
      "a journal restore already holds this profile (restore.lock)",
    );
    await expect(core.signReceipt(INTENT)).rejects.toThrow(
      "a journal restore holds this profile (restore.lock); move funds once it finishes",
    );
    expect(h.kv.text("operations/active.lock")).toBeNull();

    await h.kv.delete("restore.lock");
    await restoreJournals(core, contents, sealed);
    expect(h.kv.text("restore.lock")).toBeNull();
    await core.close();
  });
});
