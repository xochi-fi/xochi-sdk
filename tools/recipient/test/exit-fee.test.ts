import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import { describe, expect, it } from "vitest";

import { beginExitAfterExecutorFeeCheck, type ExitRequest } from "../src/chain.js";
import { OperationJournal } from "../src/operation-journal.js";

const request = (maxExecutorFee: bigint): ExitRequest => ({
  l1Recipient: `0x${"22".repeat(20)}`,
  amount: 100n,
  proverTip: 3n,
  relayerTip: 2n,
  maxExecutorFee,
  broadcasterArtifact: { name: "Broadcaster" } as ContractArtifact,
});

describe("exit executor fee ceiling", () => {
  it("accepts the exact ceiling and calculates recipient proceeds", () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-fee-"));
    try {
      const journal = new OperationJournal(directory);
      const prepared = beginExitAfterExecutorFeeCheck(journal, "recipient", request(10n), 10n);

      expect(prepared.recipientAmount).toBe(85n);
      expect(journal.get(prepared.operation.id)).toMatchObject({
        kind: "exit",
        status: "building",
        request: {
          maxExecutorFee: "10",
          executorFee: "10",
          recipientAmount: "85",
        },
      });
      journal.failOrAbort(prepared.operation.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ceiling plus one before creating an exit journal or reaching submission", () => {
    const directory = mkdtempSync(join(tmpdir(), "xochi-exit-fee-"));
    try {
      const journal = new OperationJournal(directory);

      expect(() => beginExitAfterExecutorFeeCheck(journal, "recipient", request(10n), 11n)).toThrow(
        "live executor fee exceeds --max-executor-fee; exit not started",
      );
      expect(journal.records()).toEqual([]);
      expect(journal.activeUnresolved()).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
