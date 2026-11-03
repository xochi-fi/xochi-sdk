import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Fr } from "@aztec-labs/aztec.js/fields";
import { deriveKeys } from "@aztec-labs/stdlib/keys";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/account.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { OperationJournal } from "../src/operation-journal.js";
import { computeAccountAddress } from "../src/oxide/vendor/oxide-lib-tee/account_address.js";
import {
  RefundBundleSchema,
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
});

describe("refund submission ambiguity", () => {
  it("persists the exact tx hash before one submission and never unlocks an ambiguous result", async () => {
    const { account, authorization } = await makeAuthorization();
    const bundle = bundleOf(authorization);
    const sender = privateKeyToAccount(TEST_SOURCE_KEY);
    const rawTransaction = await sender.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: bundle.portal as `0x${string}`,
      data: refundCalldata(bundle),
      value: 0n,
      gas: 2_000_000n,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
    const directory = mkdtempSync(join(tmpdir(), "xochi-refund-journal-"));
    try {
      const journal = new OperationJournal(directory);
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
            expect(journal.activeUnresolved()?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
            throw new Error("TEST ONLY lost response");
          },
        }),
      ).rejects.toThrow("operation outcome requires transaction reconciliation");
      expect(submissions).toBe(1);
      expect(journal.activeUnresolved()?.status).toBe("in_doubt");
      expect(() => journal.begin("refund-frozen-notes", { test: "TEST ONLY" })).toThrow(
        /reconcile/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
