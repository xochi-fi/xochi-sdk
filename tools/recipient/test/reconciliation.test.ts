import { TxStatus } from "@aztec-labs/stdlib/tx";
import { describe, expect, it } from "vitest";

import { durablyIncluded } from "../src/reconciliation.js";

describe("operation reconciliation finality", () => {
  it.each([TxStatus.DROPPED, TxStatus.PENDING, TxStatus.PROPOSED])(
    "keeps a %s transaction blocked",
    (status) => {
      expect(durablyIncluded(status)).toBe(false);
    },
  );

  it.each([TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED])(
    "accepts a %s transaction",
    (status) => {
      expect(durablyIncluded(status)).toBe(true);
    },
  );
});
