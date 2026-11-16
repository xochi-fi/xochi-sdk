import { describe, expect, it } from "vitest";

import { ExitJournal } from "../src/backup.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { KeyExistsError } from "../src/ports.js";
import { StateStore } from "../src/state.js";
import { MemoryKeyValueStore } from "./support/memory.js";

const TX = `0x${"ab".repeat(32)}`;
const EXIT = {
  txHash: TX,
  executorFee: "1",
  recipientAmount: "90",
  withdrawals: [
    { txHash: TX, withdrawalIndex: 0, operationId: null, finalizationData: `0x${"01".repeat(8)}` },
  ],
};

describe("exit and state records over the storage port", () => {
  it("writes an exit record once, in the CLI's bytes; accepts it again, never another", async () => {
    const kv = new MemoryKeyValueStore();
    const exits = new ExitJournal(kv);
    await exits.record(EXIT);
    expect(kv.text(`exits/${TX}.json`)).toBe(`${JSON.stringify(EXIT, null, 2)}\n`);
    await exits.record({ ...EXIT });
    await expect(exits.record({ ...EXIT, recipientAmount: "91" })).rejects.toThrow(
      `exit record exits/${TX}.json differs from this exit's; it is never overwritten`,
    );
    expect(kv.text(`exits/${TX}.json`)).toBe(`${JSON.stringify(EXIT, null, 2)}\n`);
    expect(await exits.records()).toEqual([EXIT]);
    await expect(new ExitJournal(kv).restore([EXIT])).rejects.toThrow(/empty destination/);
  });

  it("restores exit records into an empty store and refuses duplicates", async () => {
    const exits = new ExitJournal(new MemoryKeyValueStore());
    await expect(exits.restore([EXIT, EXIT])).rejects.toThrow(/duplicate/);
    await exits.restore([EXIT]);
    expect(await exits.records()).toEqual([EXIT]);
  });

  it("keeps state.json in the CLI's schema", async () => {
    const kv = new MemoryKeyValueStore();
    const state = new StateStore(kv);
    expect(await state.read()).toBeNull();
    const address = `0x${"0a".repeat(32)}`;
    await state.write({ corridor: OXDAI_MAINNET_REV2, address, bindingId: "b-1" });
    expect(await state.read()).toEqual({ corridor: OXDAI_MAINNET_REV2, address, bindingId: "b-1" });
    await expect(
      state.write({ corridor: OXDAI_MAINNET_REV2, address: "0xnot-an-address" }),
    ).rejects.toThrow();
  });
});
