// The facade (`openRecipientCore`) over the memory storage and lock ports, a DryRunAztec-based
// node and the Xochi API behind a stubbed global `fetch`: no network, no PXE, no Node adapter.

import { inspect } from "node:util";

import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { TxHash, TxStatus, type Tx } from "@aztec-labs/stdlib/tx";
import { keccak256, toHex } from "viem";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deriveRecipientAccount, type RecipientAccount } from "../src/account.js";
import { BACKUP_FORMAT_PASSKEY_V1_ID } from "../src/backup-mode.js";
import { ExitJournal, backupContents, sealBackup, type BackupContents } from "../src/backup.js";
import { LiveAztec, recordBroadcastBeforeSend } from "../src/chain.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "../src/corridor.js";
import {
  openRecipientCore,
  restoreJournals,
  type BackupMode,
  type RecipientCore,
  type RecipientCoreDeps,
} from "../src/core.js";
import { bindingTypedData } from "../src/enrollment.js";
import { NodeSubmission } from "../src/node-submission.js";
import {
  OperationJournal,
  operationsLockName,
  type OperationRecord,
} from "../src/operation-journal.js";
import type { L1OperationBroadcaster } from "../src/oxide/vendor/oxide-client/broadcaster_calls.js";
import { buildFinalizationRequestOperation } from "../src/oxide/vendor/oxide-client/withdrawal_finalization_request.js";
import { computeL1OperationId } from "../src/oxide/vendor/oxide-lib/l1_operation_calldata.js";
import {
  encodeFinalizationData,
  type WithdrawalFinalizationData,
} from "../src/oxide/vendor/oxide-lib/withdrawal_finalization_data.js";
import type { KeystoreCrypto, RecipientKeySource } from "../src/ports.js";
import { StateStore } from "../src/state.js";
import { FixedClock, MemoryKeyValueStore, MemoryLockManager } from "./support/memory.js";
import {
  BINDING_ID,
  ENROLLMENT_CHALLENGE,
  INTENT,
  NOW,
  PayoutNode,
  SOURCE,
  SPEND_TX,
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
/** When the test challenge expires: a kept request for it can be replaced after then. */
const EXPIRY = new Date(ENROLLMENT_CHALLENGE.expires_at * 1000).toISOString();
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

class InterruptedRestoreStore extends MemoryKeyValueStore {
  interruptedKey: string | null = null;
  private cleanupFailurePending: boolean;

  constructor(failCleanup = false) {
    super();
    this.cleanupFailurePending = failCleanup;
  }

  override async put(key: string, value: Uint8Array): Promise<void> {
    await super.put(key, value);
    if (this.interruptedKey === null && key.startsWith("operations/")) {
      this.interruptedKey = key;
      throw new Error("TEST ONLY: interrupted journal restore");
    }
  }

  override async delete(key: string): Promise<void> {
    if (this.cleanupFailurePending && key === this.interruptedKey) {
      this.cleanupFailurePending = false;
      throw new Error("TEST ONLY: journal restore cleanup failed");
    }
    await super.delete(key);
  }
}

function harness(
  keys: RecipientKeySource = { kind: "keystore", accountSecrets },
  kv: MemoryKeyValueStore = new MemoryKeyValueStore(),
): Harness {
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
  // A second core over the same profile keeps the first one's journal on the node double.
  const open = () =>
    openRecipientCore(deps, async (options) => {
      node.options ??= options;
      return node;
    });
  return { deps, kv, locks, node, xochi, open };
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
  it("resends the recorded request byte for byte after a lost response, then forgets it", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.loseEnrollResponses = 1;

    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(
      "TEST ONLY: connection reset after the Worker enrolled",
    );
    expect(h.kv.durableJson("enrollment-request.json")).toMatchObject({
      challengeId: "TEST-ONLY-challenge",
    });
    const projection = await core.enrollSubmit(pending, signature, SEALED);

    expect(projection).toMatchObject({ binding_id: BINDING_ID });
    expect(h.xochi.enrollBodies).toHaveLength(2);
    expect(h.xochi.enrollBodies[1]).toBe(h.xochi.enrollBodies[0]);
    expect(await stateOf(h.kv)).toMatchObject({ bindingId: BINDING_ID });
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    await core.close();
  });

  it("refuses another signature or backup for a kept request, before any POST", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.loseEnrollResponses = 1;
    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/connection reset/);
    const kept = h.kv.text("enrollment-request.json");
    const posts = h.xochi.posts();

    const awaiting = `the enrollment request for challenge TEST-ONLY-challenge, with another source signature or backup, awaits its answer until ${EXPIRY}: retry with the same ones or call enrollResume(), or start a new enrollment after then`;
    await expect(
      core.enrollSubmit(pending, signature, { mode: "sealed_file", commitment: hex("bd") }),
    ).rejects.toThrow(awaiting);
    const otherSignature = await SOURCE.signTypedData({
      ...pending.typedData,
      message: { ...pending.typedData.message, purpose: "TEST ONLY other" },
    } as typeof pending.typedData);
    await expect(core.enrollSubmit(pending, otherSignature, SEALED)).rejects.toThrow(awaiting);
    expect(h.xochi.posts()).toEqual(posts);
    expect(h.kv.text("enrollment-request.json")).toBe(kept);
    await core.close();
  });

  it("forgets a request the Worker refuses outright (categorized), so a corrected one is prepared", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.enrollRefusals.push({
      status: 409,
      body: { error: "TEST ONLY passkey elsewhere", error_category: "passkey_recipient_mismatch" },
    });

    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/answered 409/);
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    const other = { mode: "sealed_file", commitment: hex("bd") } as const;
    expect(await core.enrollSubmit(pending, signature, other)).toMatchObject({
      binding_id: BINDING_ID,
    });
    expect(await stateOf(h.kv)).toMatchObject({ backupCommitment: other.commitment });
    await core.close();
  });

  it("keeps the request on a 403 after a lost response; a retry with a fresh JWT resumes the same binding", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.loseEnrollResponses = 1;
    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/connection reset/);
    const kept = h.kv.text("enrollment-request.json");

    h.xochi.enrollRefusals.push({
      status: 403,
      body: { error: "Wallet-bound Member authentication required" },
    });
    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/answered 403/);
    expect(h.kv.text("enrollment-request.json")).toBe(kept);

    expect(await core.enrollSubmit(pending, signature, SEALED)).toMatchObject({
      binding_id: BINDING_ID,
    });
    expect(h.xochi.enrollBodies).toHaveLength(2);
    expect(h.xochi.enrollBodies[1]).toBe(h.xochi.enrollBodies[0]);
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    await core.close();
  });

  it("keeps the request on 401, 408, 429 and an uncategorized 400 while its challenge is unexpired", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    const refusals = [
      { status: 401, body: { error: "Unauthorized" } },
      { status: 408, body: "TEST ONLY proxy timeout" },
      { status: 429, body: { error: "TEST ONLY rate limited" } },
      { status: 400, body: { error: "Source binding signature invalid" } },
    ];
    for (const refusal of refusals) {
      h.xochi.enrollRefusals.push(refusal);
      await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(
        `answered ${refusal.status}`,
      );
      expect(h.kv.json("enrollment-request.json")).toMatchObject({
        challengeId: "TEST-ONLY-challenge",
      });
    }
    await core.close();
  });

  it("resends an expired kept request before replacing it, and answers the binding it enrolled", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.loseEnrollResponses = 1;
    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/connection reset/);

    (h.deps.clock as FixedClock).ms = (NOW + 601) * 1000;
    h.xochi.challenge = { ...ENROLLMENT_CHALLENGE, challenge_id: "TEST-ONLY-challenge-2" };
    h.xochi.challenge.expires_at = NOW + 1200;
    const next = await core.enrollStart(SOURCE.address);
    const nextSignature = await SOURCE.signTypedData(next.typedData);

    expect(await core.enrollSubmit(next, nextSignature, SEALED)).toMatchObject({
      binding_id: BINDING_ID,
    });
    expect(h.xochi.enrollBodies).toHaveLength(2);
    expect(h.xochi.enrollBodies[1]).toBe(h.xochi.enrollBodies[0]);
    expect(await stateOf(h.kv)).toMatchObject({
      bindingDigest: bindingTypedData(corridor, pending.binding).digest,
    });
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    await core.close();
  });

  it("replaces an expired kept request the Worker refuses on its one resend", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.enrollRefusals.push({ status: 503, body: "TEST ONLY unavailable" });
    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(/answered 503/);

    (h.deps.clock as FixedClock).ms = (NOW + 601) * 1000;
    h.xochi.challenge = { ...ENROLLMENT_CHALLENGE, challenge_id: "TEST-ONLY-challenge-2" };
    h.xochi.challenge.expires_at = NOW + 1200;
    const next = await core.enrollStart(SOURCE.address);
    const nextSignature = await SOURCE.signTypedData(next.typedData);
    h.xochi.enrollRefusals.push({ status: 400, body: { error: "Enrollment challenge expired" } });

    expect(await core.enrollSubmit(next, nextSignature, SEALED)).toMatchObject({
      binding_id: BINDING_ID,
    });
    expect(h.xochi.enrollBodies).toHaveLength(1);
    expect(JSON.parse(h.xochi.enrollBodies[0]!)).toMatchObject({
      challenge_id: "TEST-ONLY-challenge-2",
    });
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    await core.close();
  });

  it("after a reload, enrollStart refuses while the kept request is unexpired; enrollResume resends it", async () => {
    const h = harness();
    const first = await h.open();
    const pending = await first.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.xochi.loseEnrollResponses = 1;
    await expect(first.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(
      /connection reset/,
    );
    await first.close();

    const core = await h.open();
    await expect(core.enrollStart(SOURCE.address)).rejects.toThrow(
      `the enrollment request for challenge TEST-ONLY-challenge awaits its answer until ${EXPIRY}: call enrollResume(), or start a new enrollment after then`,
    );
    expect(await core.enrollResume()).toMatchObject({ binding_id: BINDING_ID });
    expect(h.xochi.enrollBodies).toHaveLength(2);
    expect(h.xochi.enrollBodies[1]).toBe(h.xochi.enrollBodies[0]);
    expect(await stateOf(h.kv)).toMatchObject({
      bindingId: BINDING_ID,
      bindingDigest: bindingTypedData(corridor, pending.binding).digest,
      backupCommitment: SEALED.commitment,
    });
    expect(h.kv.text("enrollment-request.json")).toBeNull();
    expect(await core.enrollResume()).toBeNull();
    await core.close();
  });

  it("two concurrent submits for one challenge send the same kept bytes", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);

    const [left, right] = await Promise.all([
      core.enrollSubmit(pending, signature, SEALED),
      core.enrollSubmit(pending, signature, SEALED),
    ]);
    expect(left).toEqual(right);
    expect(h.xochi.enrollBodies).toHaveLength(2);
    expect(h.xochi.enrollBodies[1]).toBe(h.xochi.enrollBodies[0]);
    await core.close();
  });

  it("refuses an unreadable kept request instead of posting it", async () => {
    const h = harness();
    const core = await h.open();
    const pending = await core.enrollStart(SOURCE.address);
    const signature = await SOURCE.signTypedData(pending.typedData);
    h.kv.setJson("enrollment-request.json", { challengeId: "TEST-ONLY-challenge" });

    await expect(core.enrollSubmit(pending, signature, SEALED)).rejects.toThrow(
      "the kept enrollment request (enrollment-request.json) is unreadable; it is never posted",
    );
    expect(h.xochi.posts()).not.toContain("/api/shielded/recipients");
    await core.close();
  });

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

describe("deploy", () => {
  it("records the deployment's tx hash durably before the node receives it, then clears it", async () => {
    const h = harness();
    const core = await h.open();
    const seenAtSend: unknown[] = [];
    h.node.onDeploySend = () => seenAtSend.push(h.kv.durableJson("deploy.json"));

    expect(await core.deploy(null)).toEqual({ txHash: hex("de") });
    expect(seenAtSend).toEqual([{ txHash: hex("de"), sponsored: false }]);
    expect(h.kv.text("deploy.json")).toBeNull();
    await core.close();
  });

  it("reconciles a recorded deployment instead of sending blind", async () => {
    const h = harness();
    const core = await h.open();
    const pending = { blockNumber: null, blockHash: null, executionSucceeded: false };
    h.kv.setJson("deploy.json", { txHash: hex("aa"), sponsored: false });

    h.node.receipts[hex("aa")] = { status: TxStatus.PENDING, ...pending };
    await expect(core.deploy(null)).rejects.toThrow(
      `the recorded deployment ${hex("aa")} is pending; run deploy again once it is included or dropped`,
    );
    expect(h.node.deploySends).toBe(0);

    h.node.receipts[hex("aa")] = {
      status: TxStatus.PROVEN,
      blockNumber: 7,
      blockHash: hex("b7"),
      executionSucceeded: true,
    };
    expect(await core.deploy(null)).toEqual({ txHash: hex("aa") });
    expect(h.node.deploySends).toBe(0);
    expect(h.kv.text("deploy.json")).toBeNull();
    await core.close();
  });

  it("sends again only once the node has answered dropped for 30 s", async () => {
    const h = harness();
    const core = await h.open();
    const clock = h.deps.clock as FixedClock;
    h.kv.setJson("deploy.json", { txHash: hex("aa"), sponsored: false });
    h.node.receipts[hex("aa")] = {
      status: TxStatus.DROPPED,
      blockNumber: null,
      blockHash: null,
      executionSucceeded: false,
    };
    const confirming = `the node does not know the recorded deployment ${hex("aa")}; run deploy again in`;

    await expect(core.deploy(null)).rejects.toThrow(`${confirming} 30 s`);
    expect(h.kv.json("deploy.json")).toEqual({
      txHash: hex("aa"),
      sponsored: false,
      droppedAt: clock.ms,
    });
    clock.ms += 29_000;
    await expect(core.deploy(null)).rejects.toThrow(`${confirming} 1 s`);
    expect(h.node.deploySends).toBe(0);

    clock.ms += 1_000;
    expect(await core.deploy(null)).toEqual({ txHash: hex("de") });
    expect(h.node.deploySends).toBe(1);
    await core.close();
  });

  it("answers a dropped deployment's hash without sending once the account is deployed", async () => {
    const h = harness();
    const core = await h.open();
    h.kv.setJson("deploy.json", { txHash: hex("aa"), sponsored: true });
    h.node.receipts[hex("aa")] = {
      status: TxStatus.DROPPED,
      blockNumber: null,
      blockHash: null,
      executionSucceeded: false,
    };
    h.node.deployed = true;

    expect(await core.deploy(null)).toEqual({ txHash: hex("aa") });
    expect(h.node.deploySends).toBe(0);
    expect(h.kv.text("deploy.json")).toBeNull();
    await core.close();
  });

  it("reports a reverted sponsored deployment's consumed claim instead of sending again", async () => {
    const h = harness();
    const core = await h.open();
    h.kv.setJson("deploy.json", { txHash: hex("aa"), sponsored: true });
    h.node.receipts[hex("aa")] = {
      status: TxStatus.CHECKPOINTED,
      blockNumber: 7,
      blockHash: hex("b7"),
      executionSucceeded: false,
    };

    await expect(core.deploy(null)).rejects.toThrow(
      `the recorded deployment ${hex("aa")} reverted: sponsored claim consumed; request a new sponsorship`,
    );
    expect(h.node.deploySends).toBe(0);
    expect(h.kv.text("deploy.json")).toBeNull();
    await core.close();
  });

  it("refuses an unreadable deployment record", async () => {
    const h = harness();
    const core = await h.open();
    h.kv.setJson("deploy.json", { txHash: "TEST ONLY not a hash" });

    await expect(core.deploy(null)).rejects.toThrow(
      "the recorded deployment (deploy.json) is unreadable",
    );
    expect(h.node.deploySends).toBe(0);
    await core.close();
  });

  it("LiveAztec.deployAccount records the hash through the node submission before sendTx", async () => {
    const seen: string[] = [];
    const hash = TxHash.fromString(hex("0d"));
    const submission = new NodeSubmission(
      {} as AztecNode,
      {
        async sendTx() {
          seen.push("sendTx");
        },
      } as unknown as AztecNode,
    );
    const wallet = {
      createSchnorrAccount: async () => ({
        getDeployMethod: async () => ({
          send: async () => {
            await submission.node.sendTx({ getTxHash: () => hash } as Tx);
            return { receipt: { txHash: hash } };
          },
        }),
      }),
    };
    const live = Reflect.construct(LiveAztec, [
      wallet,
      submission.node,
      submission,
      { corridor, l1RpcUrl: null, journal: null, attestation: null },
    ]) as LiveAztec;

    const txHash = await live.deployAccount(account, null, async (recorded) => {
      seen.push(`beforeSubmit ${recorded}`);
    });
    expect(txHash).toBe(hash.toString());
    expect(seen).toEqual([`beforeSubmit ${hash.toString()}`, "sendTx"]);
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

    expect(await core.receipt(INTENT)).toBeNull();
    const signed = await core.signReceipt(INTENT);
    expect(await core.receipt(INTENT)).toEqual(signed);
    expect(signed).toMatchObject({ intentId: INTENT, status: "submitting", txHash: hex("a7") });
    expect(h.kv.durableJson(`receipts/${INTENT}.json`)).toMatchObject({ status: "submitting" });
    expect(h.xochi.posts()).not.toContain(`/api/shielded/operations/${INTENT}/receipt`);

    const submitted = await core.submitReceipt(INTENT);
    expect(submitted).toMatchObject({ intentId: INTENT, status: "submitted", txHash: hex("a7") });
    expect(h.xochi.posts().filter((path) => path.endsWith(`${INTENT}/receipt`))).toHaveLength(1);
    expect(h.kv.durableJson(`receipts/${INTENT}.json`)).toMatchObject({ status: "submitted" });
    expect(await core.receipt(INTENT)).toEqual(submitted);
    await core.close();
  });
});

describe("operations and reconcile", () => {
  const TX = hex("1e");
  const EXIT_REQUEST = { amount: "100", executorFee: "10", recipientAmount: "85" };
  const included = { blockNumber: 9, blockHash: hex("b1"), executionSucceeded: true };

  /** Another session over this profile's journal: a tab that crashed or reloaded once closed. */
  function otherSession(h: Harness, pid = 4242): OperationJournal {
    return new OperationJournal({
      kv: h.kv,
      locks: h.locks,
      clock: new FixedClock(NOW * 1000),
      lockName: operationsLockName(account.descriptor.aztecAddress),
      holder: { pid, host: "TEST ONLY other tab" },
    });
  }

  /** The enclave-signed finalization data of the exit's one withdrawal. */
  function withdrawal(): WithdrawalFinalizationData {
    return {
      executor: EthAddress.fromString(corridor.oxide.plainWithdrawalExecutor),
      amount: 100n,
      proverTip: 1n,
      randomness: new Fr(7n),
      withdrawalSignature: { sLo: new Fr(1n), sHi: new Fr(2n), rLo: new Fr(3n), rHi: new Fr(4n) },
      userPayload: Buffer.alloc(0),
    };
  }

  /** The withdrawal's finalization data as `onPreparedWithdrawals` journals it. */
  function finalizationData(): string {
    return `0x${encodeFinalizationData(withdrawal()).toString("hex")}`;
  }

  /**
   * The L1 operation id Oxide's `submit` reports for the withdrawal's broadcast finalization
   * request: built from the signed data itself, not from its journaled encoding.
   */
  function operationIdOf(txHash: string): string {
    const operation = buildFinalizationRequestOperation(
      {
        broadcaster: {} as L1OperationBroadcaster,
        portal: EthAddress.fromString(corridor.token.immutables.portal),
        payoutToken: EthAddress.fromString(corridor.oxide.payoutToken),
      },
      withdrawal(),
    );
    return computeL1OperationId(operation, TxHash.fromString(txHash));
  }

  /** An exit another session prepared: its withdrawals journaled, not yet sent. */
  async function preparedExit(journal: OperationJournal): Promise<OperationRecord> {
    const operation = await journal.begin("exit", EXIT_REQUEST);
    return journal.update(operation.id, {
      withdrawals: [{ withdrawalIndex: 0, finalizationData: finalizationData() }],
    });
  }

  it("lists the journal and reconciles nothing while no operation holds the lock", async () => {
    const h = harness();
    const core = await h.open();
    expect(await core.operations()).toEqual([]);
    expect(await core.reconcile()).toBeNull();

    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    expect(await core.operations()).toEqual([spend]);
    await core.close();
  });

  it("names each exit withdrawal's L1 operation id in the broadcast record before the node receives it", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const exit = await preparedExit(other);

    await recordBroadcastBeforeSend(other, exit.id, corridor)(TxHash.fromString(TX));

    const data = finalizationData();
    expect(await other.get(exit.id)).toMatchObject({
      status: "broadcast",
      txHash: TX,
      withdrawals: [{ withdrawalIndex: 0, finalizationData: data, operationId: operationIdOf(TX) }],
    });
    await core.close();
  });

  it("completes a broadcast exit only once durably included, journaling its exit record", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const prepared = await preparedExit(other);
    // Written before the broadcast record named operation ids: reconcile derives them.
    const broadcast = await other.update(prepared.id, { status: "broadcast", txHash: TX });
    await other.close();

    h.node.receipts[TX] = { status: TxStatus.PROPOSED, ...included };
    expect(await core.reconcile()).toEqual(broadcast);
    expect(await new ExitJournal(h.kv).records()).toEqual([]);

    h.node.receipts[TX] = { status: TxStatus.FINALIZED, ...included };
    const data = finalizationData();
    const operationId = operationIdOf(TX);
    expect(await core.reconcile()).toMatchObject({
      id: prepared.id,
      status: "complete",
      receiptStatus: "finalized",
      withdrawals: [{ withdrawalIndex: 0, finalizationData: data, operationId }],
    });
    expect(await new ExitJournal(h.kv).records()).toEqual([
      {
        txHash: TX,
        executorFee: "10",
        recipientAmount: "85",
        withdrawals: [{ txHash: TX, withdrawalIndex: 0, operationId, finalizationData: data }],
      },
    ]);
    expect(await core.reconcile()).toBeNull();
    await core.close();
  });

  it("completes an exit whose reconcile stopped after journaling its exit record", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const prepared = await preparedExit(other);
    await recordBroadcastBeforeSend(other, prepared.id, corridor)(TxHash.fromString(TX));
    const data = finalizationData();
    const entry = {
      txHash: TX,
      executorFee: "10",
      recipientAmount: "85",
      withdrawals: [
        {
          txHash: TX,
          withdrawalIndex: 0,
          operationId: operationIdOf(TX),
          finalizationData: data,
        },
      ],
    };
    await new ExitJournal(h.kv).record(entry);
    await other.close();

    expect(await core.reconcile()).toMatchObject({
      status: "complete",
      receiptStatus: "finalized",
    });
    expect(await new ExitJournal(h.kv).records()).toEqual([entry]);
    await core.close();
  });

  it("completes a broadcast spend from its durable receipt without an exit record", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    await other.update(spend.id, { status: "broadcast", txHash: TX });
    await other.close();
    h.node.receipts[TX] = { status: TxStatus.PROVEN, ...included };

    expect(await core.reconcile()).toMatchObject({
      id: spend.id,
      status: "complete",
      txHash: TX,
      receiptStatus: "proven",
    });
    expect(await new ExitJournal(h.kv).records()).toEqual([]);
    await core.close();
  });

  it("leaves a broadcast spend to its live holder: a reconcile racing the send cannot fail it", async () => {
    const h = harness();
    const core = await h.open();
    const tab = await h.open();
    h.node.receipts[SPEND_TX] = { status: TxStatus.CHECKPOINTED, ...included };
    const raced: (OperationRecord | null)[] = [];
    h.node.onSpendSent = async () => {
      raced.push(await core.reconcile(), await tab.reconcile());
    };

    expect(await core.send(account.address.toString(), 5n, null)).toEqual({ txHash: SPEND_TX });
    expect(raced).toMatchObject([
      { status: "broadcast", txHash: SPEND_TX },
      { status: "broadcast", txHash: SPEND_TX },
    ]);
    expect(await core.operations()).toMatchObject([{ status: "complete", txHash: SPEND_TX }]);
    await tab.close();
    await core.close();
  });

  it("close waits for a send in flight, keeping its holder alive until the send settles", async () => {
    const h = harness();
    const core = await h.open();
    const sent = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.node.onSpendSent = async () => {
      sent.resolve();
      await finish.promise;
    };
    const sending = core.send(account.address.toString(), 5n, null);
    await sent.promise;

    let closed = false;
    const closing = core.close().then(() => {
      closed = true;
    });
    const [operation] = await core.operations();
    expect(await otherSession(h).recordedHolderAlive(operation!)).toBe(true);
    expect(closed).toBe(false);
    expect(h.node.closed).toBe(0);

    finish.resolve();
    expect(await sending).toEqual({ txHash: SPEND_TX });
    await closing;
    expect(h.node.closed).toBe(1);
  });

  it("reconciles its own session's broadcast once that send has settled", async () => {
    const h = harness();
    const core = await h.open();
    h.node.onSpendSent = async () => {
      throw new Error("TEST ONLY journal update failed after the node got the transaction");
    };
    await expect(core.send(account.address.toString(), 5n, null)).rejects.toThrow(/TEST ONLY/);
    expect(await core.operations()).toMatchObject([{ status: "broadcast", txHash: SPEND_TX }]);

    expect(await core.reconcile()).toMatchObject({ status: "complete", txHash: SPEND_TX });
    expect(await core.reconcile()).toBeNull();
    await core.close();
  });

  it("aborts its own session's hashless spend once that send has settled", async () => {
    const h = harness();
    const core = await h.open();
    h.node.onSpendBegun = async () => {
      throw new Error("TEST ONLY failure before submission, its abort lost");
    };
    await expect(core.send(account.address.toString(), 5n, null)).rejects.toThrow(/TEST ONLY/);
    expect(await core.operations()).toMatchObject([{ status: "building" }]);

    expect(await core.reconcile()).toMatchObject({ status: "aborted" });
    expect(await core.reconcile()).toBeNull();
    await core.close();
  });

  it("close waits for a reconcile in flight, releases its holder lease and refuses one after", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    await other.update(spend.id, { status: "broadcast", txHash: TX });
    await other.close();
    const answer = Promise.withResolvers<void>();
    h.node.receiptHold = answer.promise;

    const reconciling = core.reconcile();
    let closed = false;
    const closing = core.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(h.node.closed).toBe(0);

    answer.resolve();
    expect(await reconciling).toMatchObject({ status: "complete" });
    await closing;
    expect([...h.locks.held.keys()].filter((name) => name.includes(":holder:"))).toEqual([]);
    await expect(core.reconcile()).rejects.toThrow("this recipient core is closed");
    await expect(core.send(account.address.toString(), 5n, null)).rejects.toThrow(
      "this recipient core is closed",
    );
  });

  it("fails a reverted spend only once finalized, with its block evidence", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    const broadcast = await other.update(spend.id, { status: "broadcast", txHash: TX });
    await other.close();

    h.node.receipts[TX] = { status: TxStatus.CHECKPOINTED, ...included, executionSucceeded: false };
    expect(await core.reconcile()).toEqual(broadcast);
    h.node.receipts[TX] = { status: TxStatus.FINALIZED, ...included, executionSucceeded: false };
    expect(await core.reconcile()).toMatchObject({
      id: spend.id,
      status: "failed",
      receiptStatus: "finalized-failed",
      receiptBlockNumber: "9",
      receiptBlockHash: included.blockHash,
      error: "operation finalized with a reverted receipt",
    });
    expect(await core.reconcile()).toBeNull();
    await core.close();
  });

  it("journals no exit record for a reverted exit", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const prepared = await preparedExit(other);
    await recordBroadcastBeforeSend(other, prepared.id, corridor)(TxHash.fromString(TX));
    await other.close();
    h.node.receipts[TX] = { status: TxStatus.FINALIZED, ...included, executionSucceeded: false };

    expect(await core.reconcile()).toMatchObject({ status: "failed" });
    expect(await new ExitJournal(h.kv).records()).toEqual([]);
    await core.close();
  });

  it("releases a receipt run's lock once its holder is gone, not before", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const run = await other.beginReceipt(INTENT);

    expect(await core.reconcile()).toEqual(run);
    await other.close();
    expect(await core.reconcile()).toMatchObject({ id: run.id, status: "aborted" });
    expect(await core.reconcile()).toBeNull();
    await core.close();
  });

  it("aborts a hashless spend once its holder is gone (it never reached the node); begin works again", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    // Liveness needs the pid alone; no hostname is recorded.
    expect(spend.request).toEqual({ amount: "1", pid: "4242" });

    expect(await core.reconcile()).toEqual(spend);
    await other.close();
    const aborted = await core.reconcile();
    expect(aborted).toMatchObject({ id: spend.id, status: "aborted" });
    expect(aborted?.txHash).toBeUndefined();

    const next = otherSession(h, 5151);
    expect(await next.begin("spend", { amount: "2" })).toMatchObject({ status: "building" });
    await next.close();
    await core.close();
  });

  it("still reads an older spend record that names its host, by its pid", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    await other.update(spend.id, { request: { amount: "1", pid: "4242", host: "TEST ONLY host" } });
    await other.close();

    expect(await core.reconcile()).toMatchObject({ id: spend.id, status: "aborted" });
    await core.close();
  });

  it("keeps a hashless spend whose record names no holder", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const spend = await other.begin("spend", { amount: "1" });
    const unnamed = await other.update(spend.id, { request: { amount: "1" } });
    await other.close();

    expect(await core.reconcile()).toEqual(unnamed);
    await core.close();
  });

  it("aborts a hashless exit of a gone holder, keeping its prepared withdrawals in its record", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const prepared = await preparedExit(other);
    await other.close();

    expect(await core.reconcile()).toMatchObject({
      id: prepared.id,
      status: "aborted",
      withdrawals: [{ withdrawalIndex: 0, finalizationData: finalizationData() }],
    });
    expect(await new ExitJournal(h.kv).records()).toEqual([]);
    await core.close();
  });

  it("refuses an L1 refund operation", async () => {
    const h = harness();
    const core = await h.open();
    const other = otherSession(h);
    const refund = await other.beginBroadcast("refund-frozen-notes", {}, TX);

    await expect(core.reconcile()).rejects.toThrow(
      `operation ${refund.id} is an L1 refund (refund-frozen-notes); reconcile it with the recipient CLI's refund reconcile`,
    );
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

  it("clears an interrupted partial restore so the same backup can be retried", async () => {
    const kv = new InterruptedRestoreStore();
    const h = harness({ kind: "keystore", accountSecrets }, kv);
    const core = await h.open();
    const operations = await journalRecords(async (journal) => {
      const first = await journal.begin("spend", { amount: "1" });
      await journal.update(first.id, { status: "aborted" });
      const second = await journal.begin("spend", { amount: "2" });
      await journal.update(second.id, { status: "aborted" });
    });
    const contents = backupOf(operations);
    const sealed = (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes;

    await expect(restoreJournals(core, contents, sealed)).rejects.toThrow(
      "TEST ONLY: interrupted journal restore",
    );
    expect(kv.interruptedKey).not.toBeNull();
    expect(await kv.list("operations/")).toEqual([]);
    expect(await kv.list("exits/")).toEqual([]);
    expect(await kv.list("receipts/")).toEqual([]);
    expect(kv.text("restore.lock")).toBeNull();

    await restoreJournals(core, contents, sealed);
    expect(await kv.list("operations/")).toEqual(
      operations.map((record) => `operations/${record.id}.json`).sort(),
    );
    expect(kv.text("restore.lock")).toBeNull();
    await core.close();
  });

  it("keeps an interrupted restore blocked when copied journal cleanup fails", async () => {
    const kv = new InterruptedRestoreStore(true);
    const h = harness({ kind: "keystore", accountSecrets }, kv);
    const core = await h.open();
    const operations = await journalRecords(async (journal) => {
      const spend = await journal.begin("spend", { amount: "1" });
      await journal.update(spend.id, { status: "aborted" });
    });
    const contents = backupOf(operations);
    const sealed = (await sealBackup(contents, "TEST ONLY long passphrase", crypto)).bytes;
    let failure: unknown;

    try {
      await restoreJournals(core, contents, sealed);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message:
        "journal restore cleanup failed; this profile remains blocked by restore.lock and must be recreated",
    });
    expect(await kv.list("operations/")).toEqual([kv.interruptedKey]);
    expect(kv.text("restore.lock")).not.toBeNull();
    await expect(restoreJournals(core, contents, sealed)).rejects.toThrow(
      "a journal restore already holds this profile (restore.lock)",
    );
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
