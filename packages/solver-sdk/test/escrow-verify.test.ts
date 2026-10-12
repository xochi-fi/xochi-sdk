// The solver's award checks (ESCROW-RFC §9.4 "each of which MUST verify it
// against the lock before acting") against @xochi/spec's conformance vectors.
// Expected orderIds and attestation proofs come from the vector files, never
// from the code under test: a check that derives its own expectation passes for
// any encoding, including a wrong one, and a wrong orderId pays a recipient the
// lock does not commit to.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  checkAwardBond,
  checkFillWindow,
  EscrowRefusalError,
  fillAcceptanceFor,
  verifyAttestation,
  verifyAward,
  type AwardExpectations,
  type EscrowRefusal,
} from "../src/escrow-verify";
import { parseSolverEvent } from "../src/schema";
import type { Award, AwardEscrow, IntentAnnouncement } from "../src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(here, "../../spec/conformance", name), "utf8"));

type OrderVector = {
  name: string;
  opening: {
    recipient: string;
    toToken: string;
    toAmount: string;
    blinding: string;
    intentId: string;
  };
  expected_dest_commitment: string;
  terms: {
    depositor: string;
    fromChainId: string;
    fromToken: string;
    fromAmount: string;
    toChainId: string;
    fillDeadline: string;
    escrow: string;
  };
  expected_order_id: string;
};
type AttestationVector = {
  name: string;
  chainId: string;
  verifyingContract: string;
  orderId: string;
  payee: string;
  signer_address: string;
  expected_signature: string;
  expected_proof: string;
};

const orderVectors: OrderVector[] = load("order-id.json").vectors;
const fillSaltVectors: { orderId: string; expected_fill_id: string }[] =
  load("fill-salt.json").vectors;
const attestationVectors: AttestationVector[] = load("fill-attestation.json").vectors;

const baseline = orderVectors.find((v) => v.name === "baseline-evm-usdc")!;
const baselineFillId = fillSaltVectors.find(
  (v) => v.orderId === baseline.expected_order_id,
)!.expected_fill_id;

const SOLVER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const FILLER_CONTRACT = "0x4444444444444444444444444444444444444444";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DUMMY_SIG = "0x" + "11".repeat(65);
const EVM = /^0x[0-9a-fA-F]{40}$/;

// The award the venue would send for `v`: the envelope carries the vector's
// orderId (the witness) and opening (the plaintext the solver re-hashes).
function awardFor(v: OrderVector, fillId = baselineFillId): Award {
  return {
    auctionId: "auc-1",
    intentId: v.opening.intentId,
    solverId: SOLVER,
    output: v.opening.toAmount,
    exclusiveUntil: 1_899_990_000_000,
    escrow: {
      address: v.terms.escrow,
      intentRef: v.expected_order_id,
      acceptBy: "1899989000",
      fillId,
      destOpening: { ...v.opening },
      fillAuth: {
        fillId,
        filler: SOLVER,
        to: v.opening.recipient,
        token: v.opening.toToken,
        amount: v.opening.toAmount,
        deadline: "1899990000",
        chainId: v.terms.toChainId,
        fillerContract: FILLER_CONTRACT,
        signature: DUMMY_SIG,
      },
    },
  };
}

function expectationsFor(v: OrderVector): AwardExpectations {
  return {
    solver: SOLVER,
    originChainId: v.terms.fromChainId,
    escrow: v.terms.escrow,
    destinationChainId: v.terms.toChainId,
    fillerContract: FILLER_CONTRACT,
    originTerms: { ...v.terms },
    bidOutput: v.opening.toAmount, // the bid this solver signed: the floor, as awardFor's output
  };
}

function withEscrow(award: Award, patch: (e: AwardEscrow) => void): Award {
  const copy: Award = structuredClone(award);
  patch(copy.escrow!);
  return copy;
}

function refusalOf(fn: () => unknown): EscrowRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof EscrowRefusalError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal, got none");
}

describe("verifyAward: the award's plaintext reproduces the vector orderId", () => {
  for (const v of orderVectors) {
    const fillable = EVM.test(v.opening.recipient) && EVM.test(v.opening.toToken);
    it(`${v.name}: ${fillable ? "verifies" : "binds but is not EVM-fillable"}`, () => {
      const award = awardFor(v);
      if (fillable) {
        const verified = verifyAward(award, expectationsFor(v));
        expect(verified.orderId).toBe(v.expected_order_id);
        expect(verified.terms.destCommitment).toBe(v.expected_dest_commitment);
        expect(verified.payee.toLowerCase()).toBe(SOLVER.toLowerCase());
      } else {
        // The orderId check runs first and passes; only then is the corridor refused.
        expect(refusalOf(() => verifyAward(award, expectationsFor(v)))).toBe("not_evm_fillable");
      }
    });
  }
});

describe("verifyAward refuses an opening the lock does not commit to", () => {
  const x = expectationsFor(baseline);
  const cases: [string, (e: AwardEscrow) => void][] = [
    ["recipient", (e) => (e.destOpening!.recipient = OTHER)],
    ["toToken", (e) => (e.destOpening!.toToken = BASE_USDC)],
    [
      "toAmount",
      (e) => (e.destOpening!.toAmount = (BigInt(baseline.opening.toAmount) + 1n).toString()),
    ],
    ["blinding", (e) => (e.destOpening!.blinding = baseline.opening.blinding.slice(0, -1) + "b")],
    ["intentId", (e) => (e.destOpening!.intentId = "intent-0002")],
    [
      "intentRef",
      (e) =>
        (e.intentRef = orderVectors.find((v) => v.name === "high-bit-blinding")!.expected_order_id),
    ],
  ];
  for (const [field, patch] of cases) {
    it(`a changed ${field} is order_id_mismatch`, () => {
      // The FillAuth follows the tampered opening, as a venue redirecting the
      // fill would send it: the lock's orderId is what catches it.
      const award = withEscrow(awardFor(baseline), (e) => {
        patch(e);
        e.fillAuth!.to = e.destOpening!.recipient;
        e.fillAuth!.token = e.destOpening!.toToken;
        e.fillAuth!.amount = e.destOpening!.toAmount;
      });
      expect(refusalOf(() => verifyAward(award, x))).toBe("order_id_mismatch");
    });
  }

  it("a zero blinding is malformed, not a commitment", () => {
    const award = withEscrow(
      awardFor(baseline),
      (e) => (e.destOpening!.blinding = "0x" + "00".repeat(32)),
    );
    expect(refusalOf(() => verifyAward(award, x))).toBe("malformed_award");
  });

  it("origin terms that drift (a claimWindow-derived fillDeadline off by one) are order_id_mismatch", () => {
    const drifted = {
      ...x,
      originTerms: { ...x.originTerms, fillDeadline: BigInt(baseline.terms.fillDeadline) - 1n },
    };
    expect(refusalOf(() => verifyAward(awardFor(baseline), drifted))).toBe("order_id_mismatch");
    const otherDepositor = { ...x, originTerms: { ...x.originTerms, depositor: OTHER } };
    expect(refusalOf(() => verifyAward(awardFor(baseline), otherDepositor))).toBe(
      "order_id_mismatch",
    );
  });

  it("an award orderTerms whose destCommitment is not the opening's is refused", () => {
    const award = withEscrow(awardFor(baseline), (e) => {
      e.orderTerms = { ...baseline.terms, destCommitment: "0x" + "22".repeat(32) };
    });
    expect(refusalOf(() => verifyAward(award, x))).toBe("order_id_mismatch");
  });
});

describe("verifyAward refuses the wrong escrow or chain", () => {
  const x = expectationsFor(baseline);

  it("an award naming another escrow", () => {
    const award = withEscrow(awardFor(baseline), (e) => (e.address = FILLER_CONTRACT));
    expect(refusalOf(() => verifyAward(award, x))).toBe("wrong_escrow");
  });

  it("a trusted escrow that is not the one the order terms name", () => {
    expect(
      refusalOf(() => verifyAward(awardFor(baseline), { ...x, escrow: FILLER_CONTRACT })),
    ).toBe("wrong_escrow");
  });

  it("an origin or destination other than the configured chain", () => {
    expect(refusalOf(() => verifyAward(awardFor(baseline), { ...x, originChainId: 1 }))).toBe(
      "wrong_chain",
    );
    expect(
      refusalOf(() => verifyAward(awardFor(baseline), { ...x, destinationChainId: 8453 })),
    ).toBe("wrong_chain");
  });
});

describe("verifyAward requires the FillAuth to be exactly the committed fill, by this solver", () => {
  const x = expectationsFor(baseline);
  const cases: [string, (e: AwardEscrow) => void][] = [
    ["pays another recipient", (e) => (e.fillAuth!.to = OTHER)],
    ["pays another token", (e) => (e.fillAuth!.token = BASE_USDC)],
    [
      "authorizes below the committed floor",
      (e) => (e.fillAuth!.amount = (BigInt(baseline.opening.toAmount) - 1n).toString()),
    ],
    ["names another filler", (e) => (e.fillAuth!.filler = OTHER)],
    ["targets another RiddlerFiller", (e) => (e.fillAuth!.fillerContract = OTHER)],
    ["is for another destination chain", (e) => (e.fillAuth!.chainId = "8453")],
    ["names another fillId", (e) => (e.fillAuth!.fillId = "0x" + "33".repeat(32))],
  ];
  for (const [what, patch] of cases) {
    it(`refuses a FillAuth that ${what}`, () => {
      expect(refusalOf(() => verifyAward(withEscrow(awardFor(baseline), patch), x))).toBe(
        "fill_auth_mismatch",
      );
    });
  }

  // Riddler issues a `:winner` FillAuth for exactly the verified bid's output
  // (fill_authorizer.ex), and `award.output` echoes it: the venue's word.
  it("refuses a FillAuth amount above the awarded output", () => {
    const award = withEscrow(awardFor(baseline), (e) => (e.fillAuth!.amount = "99700001"));
    expect(award.output).toBe("99700000");
    expect(refusalOf(() => verifyAward(award, { ...x, bidOutput: "99700001" }))).toBe(
      "fill_auth_mismatch",
    );
  });

  // The ceiling is the bid this solver holds, not the venue's echo: a venue
  // that raises `award.output` together with the FillAuth sets no ceiling.
  it("refuses a FillAuth amount above the solver's signed bid even when award.output matches it", () => {
    const award = withEscrow(awardFor(baseline), (e) => (e.fillAuth!.amount = "99800000"));
    award.output = "99800000";
    expect(refusalOf(() => verifyAward(award, { ...x, bidOutput: "99799999" }))).toBe(
      "fill_auth_mismatch",
    );
    expect(verifyAward(award, { ...x, bidOutput: "99800000" }).fillAuth.amount).toBe("99800000");
  });

  it("refuses an award whose output is not an integer", () => {
    const award = awardFor(baseline);
    award.output = "99.7";
    expect(refusalOf(() => verifyAward(award, x))).toBe("malformed_award");
  });

  it("refuses an award without the fill fields", () => {
    const award = withEscrow(awardFor(baseline), (e) => delete e.fillAuth);
    expect(refusalOf(() => verifyAward(award, x))).toBe("malformed_award");
  });

  // The venue attests the on-chain filler for a panel winner, never another
  // address: a fill against any other payee can never be claimed.
  it("refuses an award naming a payee other than the filler, before any fill", () => {
    const award = withEscrow(awardFor(baseline), (e) => (e.payee = OTHER));
    expect(refusalOf(() => verifyAward(award, x))).toBe("fill_auth_mismatch");
  });

  it("expects the attestation to name the filler, whatever the payee's case", () => {
    const award = withEscrow(awardFor(baseline), (e) => (e.payee = SOLVER.toLowerCase()));
    expect(verifyAward(award, x).payee).toBe(SOLVER);
  });
});

describe("verifyAward binds the award's intent to the lock's", () => {
  it("refuses an award for another intent than the one the lock commits to", () => {
    const award = awardFor(baseline);
    award.intentId = "intent-0002";
    expect(refusalOf(() => verifyAward(award, expectationsFor(baseline)))).toBe(
      "order_id_mismatch",
    );
  });
});

describe("verifyAward cross-checks the announcement it bid on", () => {
  const announcement: IntentAnnouncement = {
    intentId: "intent-0001",
    auctionId: "auc-1",
    orderId: baseline.expected_order_id,
    fromChainId: Number(baseline.terms.fromChainId),
    toChainId: Number(baseline.terms.toChainId),
    fromToken: baseline.terms.fromToken,
    toToken: baseline.opening.toToken,
    swapKind: "exact_input",
    fromAmount: baseline.terms.fromAmount,
    settlementPreference: "public",
    minOutput: baseline.opening.toAmount,
    opensAt: 0,
    closesAt: 300,
    exclusiveWindowMs: 60_000,
  };

  it("accepts the announcement the lock matches", () => {
    expect(
      verifyAward(awardFor(baseline), { ...expectationsFor(baseline), announcement }).orderId,
    ).toBe(baseline.expected_order_id);
  });

  it("refuses a lock for a different size or token than announced", () => {
    const x = expectationsFor(baseline);
    expect(
      refusalOf(() =>
        verifyAward(awardFor(baseline), {
          ...x,
          announcement: { ...announcement, fromAmount: "1" },
        }),
      ),
    ).toBe("announcement_mismatch");
    expect(
      refusalOf(() =>
        verifyAward(awardFor(baseline), {
          ...x,
          announcement: { ...announcement, toToken: BASE_USDC },
        }),
      ),
    ).toBe("announcement_mismatch");
  });

  it("refuses an award for an order other than the one the bid signed", () => {
    const x = expectationsFor(baseline);
    for (const orderId of ["0x" + "00".repeat(32), "0x" + "ab".repeat(32)]) {
      expect(
        refusalOf(() =>
          verifyAward(awardFor(baseline), { ...x, announcement: { ...announcement, orderId } }),
        ),
      ).toBe("announcement_mismatch");
    }
  });

  it("refuses a lock for another intent than the one announced", () => {
    const x = expectationsFor(baseline);
    expect(
      refusalOf(() =>
        verifyAward(awardFor(baseline), {
          ...x,
          announcement: { ...announcement, intentId: "intent-0002" },
        }),
      ),
    ).toBe("announcement_mismatch");
  });
});

describe("checkFillWindow: now + fill + attestation(120) + margin(300) < refundableAt", () => {
  const refundableAt = 2_000_000_000n;
  const fill = 60n;

  it("admits a fill that leaves the full budget with a second to spare", () => {
    const nowSec = refundableAt - fill - 120n - 300n - 1n;
    expect(() =>
      checkFillWindow({
        nowSec,
        refundableAt,
        fillAuthDeadline: refundableAt,
        fillInclusionSec: fill,
      }),
    ).not.toThrow();
  });

  it("refuses at the boundary: landing exactly at refundableAt leaves no margin", () => {
    const nowSec = refundableAt - fill - 120n - 300n;
    expect(
      refusalOf(() =>
        checkFillWindow({
          nowSec,
          refundableAt,
          fillAuthDeadline: refundableAt,
          fillInclusionSec: fill,
        }),
      ),
    ).toBe("window_closed");
  });

  it("refuses a fill that would land after the FillAuth deadline", () => {
    const nowSec = 1_000n;
    expect(() =>
      checkFillWindow({
        nowSec,
        refundableAt,
        fillAuthDeadline: nowSec + fill,
        fillInclusionSec: fill,
      }),
    ).not.toThrow();
    expect(
      refusalOf(() =>
        checkFillWindow({
          nowSec,
          refundableAt,
          fillAuthDeadline: nowSec + fill - 1n,
          fillInclusionSec: fill,
        }),
      ),
    ).toBe("auth_expired");
  });
});

describe("verifyAttestation against the fill-attestation vectors", () => {
  const usable = attestationVectors.filter((v) => BigInt(v.payee) !== 0n);
  const wireOf = (v: AttestationVector) => ({
    orderId: v.orderId,
    payee: v.payee,
    signature: v.expected_signature,
    proof: v.expected_proof,
    verifier: v.verifyingContract,
    chainId: v.chainId,
  });
  const expectFor = (v: AttestationVector) => ({
    orderId: v.orderId,
    payee: v.payee,
    originChainId: v.chainId,
    verifier: v.verifyingContract,
  });

  for (const v of usable) {
    it(`${v.name}: claims with the vector proof and recovers the vector signer`, () => {
      const { proof, attester } = verifyAttestation(wireOf(v), expectFor(v));
      expect(proof).toBe(v.expected_proof);
      expect(attester).toBe(v.signer_address);
    });
  }

  const v = usable[0]!;
  it("refuses an attestation for another payee, verifier, chain or with a foreign proof", () => {
    expect(refusalOf(() => verifyAttestation(wireOf(v), { ...expectFor(v), payee: OTHER }))).toBe(
      "attestation_mismatch",
    );
    expect(
      refusalOf(() => verifyAttestation(wireOf(v), { ...expectFor(v), verifier: OTHER })),
    ).toBe("attestation_mismatch");
    expect(
      refusalOf(() => verifyAttestation(wireOf(v), { ...expectFor(v), originChainId: 10 })),
    ).toBe("attestation_mismatch");
    const foreign = { ...wireOf(v), proof: v.expected_proof.slice(0, -2) + "ff" };
    expect(refusalOf(() => verifyAttestation(foreign, expectFor(v)))).toBe("attestation_mismatch");
  });
});

describe("award wire", () => {
  it("parses the escrow-fill server's numeric fillAuth.deadline as a decimal string", () => {
    const wire = JSON.parse(JSON.stringify(awardFor(baseline)));
    wire.escrow.fillAuth.deadline = 1899990000;
    const event = parseSolverEvent({ type: "award", award: wire });
    if (event.type !== "award") throw new Error("expected an award");
    expect(event.award.escrow?.fillAuth?.deadline).toBe("1899990000");
    expect(verifyAward(event.award, expectationsFor(baseline)).orderId).toBe(
      baseline.expected_order_id,
    );
  });

  it("refuses a numeric uint past 2^53, which JSON has already rounded", () => {
    const wire = JSON.parse(JSON.stringify(awardFor(baseline)));
    wire.escrow.fillAuth.deadline = 2 ** 53;
    expect(() => parseSolverEvent({ type: "award", award: wire })).toThrow();
  });

  // A parse error ends `SolverClient.run` (or silently drops a won award):
  // a partial FillAuth must reach the solver and be refused at fill time.
  it("parses a partial fillAuth and refuses it at fill time as malformed", () => {
    const wire = JSON.parse(JSON.stringify(awardFor(baseline)));
    wire.escrow.fillAuth = { filler: SOLVER, deadline: 1899990000, signature: DUMMY_SIG };
    const event = parseSolverEvent({ type: "award", award: wire });
    if (event.type !== "award") throw new Error("expected an award");
    expect(refusalOf(() => verifyAward(event.award, expectationsFor(baseline)))).toBe(
      "malformed_award",
    );
  });

  it("refuses a fillAuth member that is present but malformed", () => {
    const wire = JSON.parse(JSON.stringify(awardFor(baseline)));
    wire.escrow.fillAuth.to = "not-an-address";
    expect(() => parseSolverEvent({ type: "award", award: wire })).toThrow();
  });
});

describe("FillAcceptance over a verified award (SOLVER-RFC §5.3)", () => {
  const BOND = { chainId: "8453", address: "0x6666666666666666666666666666666666666666" };
  const withBond = (a: Award) => withEscrow(a, (e) => (e.bond = { ...BOND }));

  it("binds the order terms and commits to exactly the verified FillAuth", () => {
    const award = awardFor(baseline);
    const fa = award.escrow!.fillAuth!;
    // Expectation from the award wire through ethers' own EIP-712 encoder, not
    // from the builder: the FillAuth digest on its RiddlerFiller domain.
    const fillAuthOf = (f: typeof fa) =>
      ethers.TypedDataEncoder.hash(
        {
          name: "RiddlerFiller",
          version: "1",
          chainId: f.chainId,
          verifyingContract: f.fillerContract,
        },
        {
          FillAuth: [
            { name: "fillId", type: "bytes32" },
            { name: "filler", type: "address" },
            { name: "to", type: "address" },
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        f,
      );
    const acceptance = fillAcceptanceFor(verifyAward(award, expectationsFor(baseline)));
    expect(acceptance).toEqual({
      orderId: baseline.expected_order_id,
      originChainId: BigInt(baseline.terms.fromChainId),
      escrow: baseline.terms.escrow,
      filler: fa.filler,
      deadline: fa.deadline,
      fillAuth: fillAuthOf(fa),
    });
    // The plaintext FillAuth never enters the acceptance (ESCROW-RFC §9.3 C2/C3).
    expect(Object.keys(acceptance)).not.toContain("fillId");
    // ...and a FillAuth differing in any field is a different commitment.
    for (const [k, alt] of [
      ["fillId", "0x" + "cd".repeat(32)],
      ["amount", "1"],
      ["to", OTHER],
      ["token", OTHER],
      ["chainId", "1"],
      ["fillerContract", OTHER],
    ] as const) {
      expect(fillAuthOf({ ...fa, [k]: alt }), k).not.toBe(acceptance.fillAuth);
    }
  });

  it("accepts only the bond this solver trusts", () => {
    const award = withBond(awardFor(baseline));
    expect(checkAwardBond(award, BOND)).toEqual({
      chainId: 8453n,
      verifyingContract: BOND.address,
    });
    expect(
      checkAwardBond(award, {
        chainId: 8453n,
        address: BOND.address.toUpperCase().replace("0X", "0x"),
      }),
    ).toEqual({
      chainId: 8453n,
      verifyingContract: BOND.address,
    });
    expect(refusalOf(() => checkAwardBond(awardFor(baseline), BOND))).toBe("malformed_award");
    expect(refusalOf(() => checkAwardBond(award, { ...BOND, chainId: "1" }))).toBe("bond_mismatch");
    expect(refusalOf(() => checkAwardBond(award, { ...BOND, address: OTHER }))).toBe(
      "bond_mismatch",
    );
  });

  it("parses the bond off the award wire", () => {
    const award = withBond(awardFor(baseline));
    const parsed = parseSolverEvent({ type: "award", award: JSON.parse(JSON.stringify(award)) });
    expect(parsed.type === "award" && parsed.award.escrow?.bond).toEqual(BOND);
  });
});
