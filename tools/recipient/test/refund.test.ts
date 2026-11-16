import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Fr } from "@aztec-labs/aztec.js/fields";
import { deriveKeys } from "@aztec-labs/stdlib/keys";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/core/account.js";
import { OXDAI_MAINNET_REV2 } from "../src/core/corridor.js";
import type { OperationJournal } from "../src/core/operation-journal.js";
import { openNodeJournals } from "../src/node/data-dir.js";
import { computeAccountAddress } from "../src/core/oxide/vendor/oxide-lib-tee/account_address.js";
import {
  RefundBundleSchema,
  applyRefundReconciliation,
  authorizeRefund,
  refundCalldata,
  submitRefund,
  validateRefundAuthorization,
  type RefundAuthorization,
  type RefundEvidence,
} from "../src/refund.js";
import { TEST_SECRETS, TEST_SOURCE_KEY } from "./fixtures.js";

const OWNER_EVIDENCE = (owner: string): RefundEvidence => ({
  format: "xochi.shielded.refund-evidence.v1",
  kind: "frozen-notes",
  owner,
  amount: "1000000000000000000",
  nullifiers: [`0x${"12".repeat(32)}`],
});
const DESTINATION = `0x${"34".repeat(20)}`;

async function makeAuthorization() {
  const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
  return {
    account,
    authorization: await authorizeRefund(
      account,
      OXDAI_MAINNET_REV2,
      OWNER_EVIDENCE(account.address.toString().toLowerCase()),
      DESTINATION,
      0n,
    ),
  };
}

function bundleOf(authorization: RefundAuthorization) {
  return RefundBundleSchema.parse({
    ...authorization,
    format: "xochi.shielded.refund-bundle.v1",
    proof: "0x01",
    teeSignature: `0x${"56".repeat(65)}`,
  });
}

async function signedRefund() {
  const { account, authorization } = await makeAuthorization();
  const bundle = bundleOf(authorization);
  const sender = privateKeyToAccount(TEST_SOURCE_KEY);
  const rawTransaction = await sender.signTransaction({
    chainId: 1,
    type: "eip1559",
    to: bundle.portal as Hex,
    data: refundCalldata(bundle),
    value: 0n,
    gas: 2_000_000n,
    nonce: 0,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  return { account, bundle, rawTransaction };
}

function beginLockedRefund(
  journal: OperationJournal,
  bundle: ReturnType<typeof bundleOf>,
  rawTransaction: Hex,
) {
  const calldata = refundCalldata(bundle);
  return journal.beginBroadcast(
    "refund-frozen-notes",
    {
      bundleDigest: keccak256(Buffer.from(JSON.stringify(bundle))),
      calldataHash: keccak256(calldata),
      portal: bundle.portal,
      kind: bundle.evidence.kind,
    },
    keccak256(rawTransaction),
  );
}

function reconciliationObservation(
  bundle: ReturnType<typeof bundleOf>,
  rawTransaction: Hex,
  status: "success" | "reverted",
) {
  const transactionHash = keccak256(rawTransaction);
  return {
    chainId: 1,
    transaction: {
      hash: transactionHash,
      to: bundle.portal as Hex,
      input: refundCalldata(bundle),
      value: 0n,
      blockNumber: 40n,
      blockHash: `0x${"ab".repeat(32)}` as Hex,
    },
    receipt: {
      transactionHash,
      status,
      blockNumber: 40n,
      blockHash: `0x${"ab".repeat(32)}` as Hex,
    },
    canonicalBlock: {
      number: 40n,
      hash: `0x${"ab".repeat(32)}` as Hex,
    },
    finalizedBlockNumber: 40n,
  } as const;
}

describe("fallback-key refund authorization (F3-F4)", () => {
  it("recomputes the stock Schnorr address with immutablesHash zero", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const { publicKeys } = await deriveKeys(account.secret);
    const recomputed = await computeAccountAddress(
      publicKeys,
      {
        contractClassId: account.instance.originalContractClassId,
        salt: account.salt,
        initializationHash: account.instance.initializationHash,
        deployer: account.instance.deployer,
      },
      Fr.ZERO,
    );
    expect(recomputed.equals(account.address)).toBe(true);
  });

  it("signs and verifies the executor/destination commitment and rejects a redirect", async () => {
    const { account, authorization } = await makeAuthorization();
    await expect(
      validateRefundAuthorization(account, OXDAI_MAINNET_REV2, authorization),
    ).resolves.toEqual(authorization);
    await expect(
      validateRefundAuthorization(account, OXDAI_MAINNET_REV2, {
        ...authorization,
        destination: `0x${"78".repeat(20)}`,
      }),
    ).rejects.toThrow(/destination commitment/);
  });

  it("refuses every nonzero relayer tip for the fixed executor", async () => {
    const { account, authorization } = await makeAuthorization();
    await expect(
      authorizeRefund(
        account,
        OXDAI_MAINNET_REV2,
        OWNER_EVIDENCE(account.address.toString().toLowerCase()),
        DESTINATION,
        1n,
      ),
    ).rejects.toThrow(/zero relayer tip/);
    await expect(
      validateRefundAuthorization(account, OXDAI_MAINNET_REV2, {
        ...authorization,
        relayerTip: "1",
      }),
    ).rejects.toThrow(/zero relayer tip/);
  });

  it.each([
    {
      kind: "frozen-notes",
      evidence: (owner: string): RefundEvidence => OWNER_EVIDENCE(owner),
    },
    {
      kind: "frozen-deposits",
      evidence: (owner: string): RefundEvidence => ({
        format: "xochi.shielded.refund-evidence.v1",
        kind: "frozen-deposits",
        owner,
        amount: "1000000000000000000",
        nullifiers: [`0x${"23".repeat(32)}`],
      }),
    },
    {
      kind: "unprocessed-deposit",
      evidence: (owner: string): RefundEvidence => ({
        format: "xochi.shielded.refund-evidence.v1",
        kind: "unprocessed-deposit",
        owner,
        amount: "1000000000000000000",
        siloedNullifier: `0x${"34".repeat(32)}`,
        messageHash: `0x${"45".repeat(32)}`,
        messageLeafIndex: "17",
      }),
    },
  ])("authorizes recipient-owned $kind evidence", async ({ evidence }) => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const authorization = await authorizeRefund(
      account,
      OXDAI_MAINNET_REV2,
      evidence(account.address.toString().toLowerCase()),
      DESTINATION,
      0n,
    );
    await expect(
      validateRefundAuthorization(account, OXDAI_MAINNET_REV2, authorization),
    ).resolves.toEqual(authorization);
    expect(refundCalldata(bundleOf(authorization))).toMatch(/^0x[0-9a-f]+$/);
  });

  it("refuses evidence owned by another account and duplicate nullifiers", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    await expect(
      authorizeRefund(
        account,
        OXDAI_MAINNET_REV2,
        OWNER_EVIDENCE(`0x${"90".repeat(32)}`),
        DESTINATION,
        0n,
      ),
    ).rejects.toThrow(/not owned/);
    const duplicate = OWNER_EVIDENCE(account.address.toString().toLowerCase());
    if (duplicate.kind !== "frozen-notes") throw new Error("TEST ONLY fixture kind changed");
    duplicate.nullifiers.push(duplicate.nullifiers[0]!);
    await expect(
      authorizeRefund(account, OXDAI_MAINNET_REV2, duplicate, DESTINATION, 0n),
    ).rejects.toThrow(/unique and nonzero/);
  });

  it("refuses a corridor with a moved refund cap", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const moved = structuredClone(OXDAI_MAINNET_REV2);
    moved.token.immutables.maxNoteAmount = "5166000000000000000001";
    await expect(
      authorizeRefund(
        account,
        moved,
        OWNER_EVIDENCE(account.address.toString().toLowerCase()),
        DESTINATION,
        0n,
      ),
    ).rejects.toThrow(/maxNoteAmount/);
  });
});

describe("refund submission ambiguity", () => {
  it("persists the exact tx hash before one submission and never unlocks an ambiguous result", async () => {
    const { account, bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-journal-"));
    try {
      const journal = openNodeJournals(directory).operations;
      let submissions = 0;
      await expect(
        submitRefund({
          account,
          corridor: OXDAI_MAINNET_REV2,
          bundleInput: bundle,
          rawTransaction,
          rpcUrl: "http://127.0.0.1:1",
          journal,
          assertPins: async () => undefined,
          send: async () => {
            submissions += 1;
            expect((await journal.activeUnresolved())?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
            throw new Error("TEST ONLY lost response");
          },
        }),
      ).rejects.toThrow("operation outcome requires transaction reconciliation");
      expect(submissions).toBe(1);
      expect((await journal.activeUnresolved())?.status).toBe("in_doubt");
      await expect(journal.begin("refund-frozen-notes", { test: "TEST ONLY" })).rejects.toThrow(
        /reconcile/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers the broadcast hash after a crash at the initial lock sync boundary", async () => {
    const { bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-crash-"));
    try {
      let crashedOperationId = "";
      const crashing = openNodeJournals(directory, {
        afterInitialLockSynced: (id) => {
          crashedOperationId = id;
          throw new Error("TEST ONLY crash after initial lock sync");
        },
      }).operations;
      await expect(beginLockedRefund(crashing, bundle, rawTransaction)).rejects.toThrow(
        "TEST ONLY crash after initial lock sync",
      );

      const restarted = openNodeJournals(directory).operations;
      expect(await restarted.activeUnresolved()).toMatchObject({
        id: crashedOperationId,
        status: "broadcast",
        txHash: keccak256(rawTransaction),
      });
      await expect(
        restarted.begin("refund-frozen-notes", { test: "new authorization" }),
      ).rejects.toThrow(/reconcile/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("releases a finalized reverted operation with receipt evidence", async () => {
    const { bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-reverted-"));
    try {
      const journal = openNodeJournals(directory).operations;
      const operation = await beginLockedRefund(journal, bundle, rawTransaction);
      expect(
        await applyRefundReconciliation(
          journal,
          OXDAI_MAINNET_REV2,
          reconciliationObservation(bundle, rawTransaction, "reverted"),
        ),
      ).toBe("finalized-failed");
      expect(await journal.get(operation.id)).toMatchObject({
        status: "failed",
        receiptStatus: "finalized-failed",
        receiptBlockNumber: "40",
        receiptBlockHash: `0x${"ab".repeat(32)}`,
        error: "operation finalized with a reverted receipt",
      });
      const explicitlyAuthorizedNext = await journal.begin("refund-frozen-notes", {
        test: "new explicit authorization",
      });
      await journal.failOrAbort(explicitlyAuthorizedNext.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a receipt orphaned from the canonical chain", async () => {
    const { bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-orphan-"));
    try {
      const journal = openNodeJournals(directory).operations;
      const operation = await beginLockedRefund(journal, bundle, rawTransaction);
      const observation = reconciliationObservation(bundle, rawTransaction, "success");
      await expect(
        applyRefundReconciliation(journal, OXDAI_MAINNET_REV2, {
          ...observation,
          canonicalBlock: {
            ...observation.canonicalBlock,
            hash: `0x${"cd".repeat(32)}`,
          },
        }),
      ).rejects.toThrow("refund transaction evidence does not match the locked authorization");
      expect(await journal.activeUnresolved()).toMatchObject({
        id: operation.id,
        status: "broadcast",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a transaction whose inclusion block differs from its receipt", async () => {
    const { bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-block-mismatch-"));
    try {
      const journal = openNodeJournals(directory).operations;
      const operation = await beginLockedRefund(journal, bundle, rawTransaction);
      const observation = reconciliationObservation(bundle, rawTransaction, "success");
      await expect(
        applyRefundReconciliation(journal, OXDAI_MAINNET_REV2, {
          ...observation,
          transaction: {
            ...observation.transaction,
            blockHash: `0x${"ef".repeat(32)}`,
          },
        }),
      ).rejects.toThrow("refund transaction evidence does not match the locked authorization");
      expect(await journal.activeUnresolved()).toMatchObject({
        id: operation.id,
        status: "broadcast",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts finalized success without consulting current portal frozen state", async () => {
    const { bundle, rawTransaction } = await signedRefund();
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-finalized-"));
    try {
      const journal = openNodeJournals(directory).operations;
      const operation = await beginLockedRefund(journal, bundle, rawTransaction);
      const observation = reconciliationObservation(bundle, rawTransaction, "success");
      expect("frozen" in observation).toBe(false);
      expect(await applyRefundReconciliation(journal, OXDAI_MAINNET_REV2, observation)).toBe(
        "finalized",
      );
      expect(await journal.get(operation.id)).toMatchObject({
        status: "complete",
        receiptStatus: "finalized",
        receiptBlockNumber: "40",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
