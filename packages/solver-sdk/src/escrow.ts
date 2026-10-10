// In-memory reference EscrowGateway (RESERVED / INERT, M6). The settlement
// boundary in SOLVER-RFC.md §7 is "the one hard interface" between the solver
// protocol and the non-custodial escrow; everything solver-side is testable
// against a stub escrow. This is that stub: a fund-safety state machine with no
// network and no real contract. It is NOT used by the live SolverClient loop.
//
// Fund-safety invariant (SOLVER-RFC.md §7/§9): escrowed principal never moves to
// the solver before `release(intentId, proof)` with a well-formed proof; a
// no-show routes to `void` (refund the depositor), never to loss. An unknown
// proof kind is treated as unproven (fail closed).

import type { EscrowGateway, Funds, FillProof } from "./types";

export type EscrowState = "locked" | "released" | "voided";

export interface EscrowRecord {
  lockRef: string;
  funds: Funds;
  solver: string;
  exclusiveUntil: number;
  state: EscrowState;
  proof?: FillProof;
}

const KNOWN_PROOF_KINDS = new Set(["tx_hash", "oracle_attestation", "light_client", "zk"]);

// Fail closed: only a recognized, minimally well-formed proof can release funds.
function isProven(proof: FillProof): boolean {
  if (!proof || !KNOWN_PROOF_KINDS.has(proof.kind)) return false;
  switch (proof.kind) {
    case "tx_hash":
      return (
        typeof proof.txHash === "string" &&
        proof.txHash.length > 0 &&
        Number.isFinite(proof.chainId)
      );
    case "oracle_attestation":
      return !!proof.attestation && !!proof.signer;
    case "light_client":
      return !!proof.header && !!proof.proof;
    case "zk":
      return !!proof.proof && Array.isArray(proof.publicInputs);
    default:
      return false;
  }
}

export class StubEscrowGateway implements EscrowGateway {
  private readonly records = new Map<string, EscrowRecord>();
  private seq = 0;

  async lock(
    intentId: string,
    funds: Funds,
    solver: string,
    exclusiveUntil: number,
  ): Promise<{ lockRef: string }> {
    if (this.records.has(intentId)) {
      throw new Error(`escrow already locked for intent ${intentId}`);
    }
    const lockRef = `stub-lock-${++this.seq}`;
    this.records.set(intentId, { lockRef, funds, solver, exclusiveUntil, state: "locked" });
    return { lockRef };
  }

  async release(intentId: string, proof: FillProof): Promise<void> {
    const rec = this.mustFind(intentId);
    if (rec.state !== "locked") {
      throw new Error(`cannot release intent ${intentId}: state is ${rec.state}`);
    }
    if (!isProven(proof)) {
      // Fail closed -- principal stays locked, never paid on an unproven fill.
      throw new Error(
        `cannot release intent ${intentId}: proof is not verifiable (kind ${proof?.kind})`,
      );
    }
    rec.state = "released";
    rec.proof = proof;
  }

  async void(intentId: string): Promise<void> {
    const rec = this.mustFind(intentId);
    if (rec.state === "released") {
      throw new Error(`cannot void intent ${intentId}: already released to solver`);
    }
    rec.state = "voided";
  }

  // Test/inspection helper -- not part of the EscrowGateway interface.
  stateOf(intentId: string): EscrowRecord | undefined {
    return this.records.get(intentId);
  }

  private mustFind(intentId: string): EscrowRecord {
    const rec = this.records.get(intentId);
    if (!rec) throw new Error(`no escrow lock for intent ${intentId}`);
    return rec;
  }
}
