// SOLVER-RFC §6 `canton_update` (0.6.0-draft, Riddler #1194): a Canton fill is
// proved by its ledger update id, an opaque case-sensitive string. The schema
// mirrors the venue's intake: verbatim, never folded or trimmed; an empty or
// padded id is refused rather than normalized into a different id.

import { describe, it, expect } from "vitest";
import { FillReceiptSchema } from "../src/schema";
import { StubEscrowGateway } from "../src/escrow";
import type { FillProof } from "../src/types";

const receipt = (proof: unknown) => ({
  auctionId: "au_abc123",
  intentId: "xi_abc123",
  solverId: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  proof,
});

describe("FillReceiptSchema canton_update", () => {
  it("parses a Canton update id verbatim", () => {
    const updateId = "1220Ab09cD::Update-7";
    const parsed = FillReceiptSchema.parse(
      JSON.parse(JSON.stringify(receipt({ kind: "canton_update", updateId }))),
    );
    expect(parsed.proof).toEqual({ kind: "canton_update", updateId });
  });

  it("keeps two ids differing only in case distinct", () => {
    const a = FillReceiptSchema.parse(receipt({ kind: "canton_update", updateId: "1220abcd" }));
    const b = FillReceiptSchema.parse(receipt({ kind: "canton_update", updateId: "1220ABCD" }));
    expect(a.proof).not.toEqual(b.proof);
  });

  it.each([
    ["missing", { kind: "canton_update" }],
    ["empty", { kind: "canton_update", updateId: "" }],
    ["leading space", { kind: "canton_update", updateId: " 1220abcd" }],
    ["trailing newline", { kind: "canton_update", updateId: "1220abcd\n" }],
    ["not a string", { kind: "canton_update", updateId: 1220 }],
  ])("refuses a %s update id", (_label, proof) => {
    expect(FillReceiptSchema.safeParse(receipt(proof)).success).toBe(false);
  });

  it("leaves tx_hash EVM-shaped: a chain id is still required", () => {
    expect(
      FillReceiptSchema.safeParse(receipt({ kind: "tx_hash", txHash: "0x" + "ab".repeat(32) }))
        .success,
    ).toBe(false);
  });
});

describe("StubEscrowGateway canton_update", () => {
  const funds = { chainId: 8453, token: "USDC", amount: "100000000" };
  const SOLVER = "0xabc0000000000000000000000000000000000001";

  it("releases on a well-formed Canton proof", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    const proof: FillProof = { kind: "canton_update", updateId: "1220f00dBEEF" };
    await e.release("i1", proof);
    expect(e.stateOf("i1")?.proof).toEqual(proof);
  });

  it("fails closed on an empty or padded Canton proof", async () => {
    const e = new StubEscrowGateway();
    await e.lock("i1", funds, SOLVER, 1900000000);
    for (const updateId of ["", " 1220abcd"]) {
      await expect(e.release("i1", { kind: "canton_update", updateId })).rejects.toThrow(
        /not verifiable/,
      );
    }
    expect(e.stateOf("i1")?.state).toBe("locked");
  });
});
