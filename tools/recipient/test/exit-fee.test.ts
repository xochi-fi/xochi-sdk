import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { describe, expect, it } from "vitest";

import { beginExitAfterExecutorFeeCheck, type ExitRequest } from "../src/core/chain.js";
import { openNodeJournals } from "../src/node/data-dir.js";

const request = (maxExecutorFee: bigint): ExitRequest => ({
  l1Recipient: `0x${"22".repeat(20)}`,
  amount: 100n,
  proverTip: 3n,
  relayerTip: 2n,
  maxExecutorFee,
  broadcasterArtifact: { name: "Broadcaster" } as ContractArtifact,
});

describe("exit executor fee ceiling", () => {
  it("accepts the exact ceiling and calculates recipient proceeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-fee-"));
    try {
      const journal = openNodeJournals(directory).operations;
      const prepared = await beginExitAfterExecutorFeeCheck(
        journal,
        "recipient",
        request(10n),
        10n,
      );

      expect(prepared.recipientAmount).toBe(85n);
      expect(await journal.get(prepared.operation.id)).toMatchObject({
        kind: "exit",
        status: "building",
        request: {
          maxExecutorFee: "10",
          executorFee: "10",
          recipientAmount: "85",
        },
      });
      await journal.failOrAbort(prepared.operation.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ceiling plus one before creating an exit journal or reaching submission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-fee-"));
    try {
      const journal = openNodeJournals(directory).operations;

      await expect(
        beginExitAfterExecutorFeeCheck(journal, "recipient", request(10n), 11n),
      ).rejects.toThrow("live executor fee exceeds --max-executor-fee; exit not started");
      expect(await journal.records()).toEqual([]);
      expect(await journal.activeUnresolved()).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
