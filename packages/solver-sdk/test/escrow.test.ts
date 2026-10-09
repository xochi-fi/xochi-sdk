// Fund-safety invariant of the reference StubEscrowGateway (SOLVER-RFC.md §7/§9,
// RESERVED / INERT). Principal never moves to the solver before a well-formed
// proof; a no-show voids to the depositor; unknown proof kinds fail closed.

import { describe, it, expect } from "vitest";
import { StubEscrowGateway } from "../src/escrow";
import type { Funds, FillProof } from "../src/types";

const funds: Funds = { chainId: 8453, token: "USDC", amount: "100000000" };
const SOLVER = "0xabc0000000000000000000000000000000000001";
const txProof: FillProof = { kind: "tx_hash", chainId: 10, txHash: "0xdead" };

describe("StubEscrowGateway fund-safety", () => {
  it("locks, then releases only on a well-formed proof", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    expect(e.stateOf("i1")?.state).toBe("locked");
    await e.release("i1", txProof);
    expect(e.stateOf("i1")?.state).toBe("released");
    expect(e.stateOf("i1")?.proof).toEqual(txProof);
  });

  it("fails closed on an unproven / unknown-kind proof (principal stays locked)", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    await expect(e.release("i1", { kind: "gossip" } as unknown as FillProof)).rejects.toThrow(/not verifiable/);
    await expect(e.release("i1", { kind: "tx_hash", chainId: 10, txHash: "" })).rejects.toThrow(/not verifiable/);
    expect(e.stateOf("i1")?.state).toBe("locked");
  });

  it("refuses to release without a prior lock", async () => {
    const e = new StubEscrowGateway();
    await expect(e.release("nope", txProof)).rejects.toThrow(/no escrow lock/);
  });

  it("voids a no-show back to the depositor", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    await e.void("i1");
    expect(e.stateOf("i1")?.state).toBe("voided");
  });

  it("cannot void after release, nor release after void", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    await e.release("i1", txProof);
    await expect(e.void("i1")).rejects.toThrow(/already released/);

    await e.lock("i2", funds, SOLVER, 1900000000);
    await e.void("i2");
    await expect(e.release("i2", txProof)).rejects.toThrow(/state is voided/);
  });

  it("rejects a double lock on the same intent", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    await expect(e.lock("i1", funds, SOLVER, 1900000000)).rejects.toThrow(/already locked/);
  });
});
