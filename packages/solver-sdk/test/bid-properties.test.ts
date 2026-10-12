/**
 * Properties of the solver bid sealing (EIP-712).
 *
 * A SolverBid v2 digest commits to six struct members, so the property that matters is
 * that distinct bids never share a digest: if two do, a signature issued for
 * one is valid for the other, and a solver could be held to a price -- or a
 * order, lifetime or exclusive window -- it never bid.
 *
 * Under the old JSON scheme this was a question about escaping and delimiters.
 * Under EIP-712 each string member is hashed independently
 * (`keccak256(utf8_bytes)`) and the members are concatenated as fixed-width
 * words, so no input can move a field boundary. These properties are what say
 * so for inputs nobody thought to write down -- the vectors in
 * `conformance/solver-bid-v2.json` pin the values, this pins the shape.
 *
 * Deterministic: fixed seed and bounded runs.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ethers } from "ethers";

import { bidTypedData, bidDigest, verifyBid, solverIdFromKey, MAX_BID_MS } from "../src/index";

const CFG = {
  seed: Number(process.env.PBT_SEED || 0x5eed),
  numRuns: Number(process.env.PBT_RUNS || 200),
};

const SIGNING_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SIGNER = solverIdFromKey(SIGNING_KEY);

// Awkward on purpose: quotes, backslashes, control characters and astral-plane
// codepoints are what break a delimiter-based scheme and what exercise UTF-8
// encoding. Plain alphanumerics prove nothing here.
//
// Unpaired surrogates are filtered out because they have no UTF-8 encoding at
// all, and the last test below pins that the signer REFUSES them rather than
// substituting U+FFFD.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const nastyText = fc
  .oneof(
    fc.string(),
    fc.constantFrom(
      "",
      "\n",
      "\\n",
      '"',
      "\\",
      "\t",
      "\r",
      " ",
      ",",
      ":",
      "|",
      "ü",
      "日本語",
      "\u{1F984}",
    ),
    fc.string().map((s) => `${s}\n${s}`),
    fc.string().map((s) => `"${s}"`),
  )
  .filter((s) => !LONE_SURROGATE.test(s));

const amount = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }).map((n) => n.toString());

type BidFields = {
  orderId: string;
  auctionId: string;
  intentId: string;
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
};

const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => ethers.hexlify(b));
const ms = fc.integer({ min: 0, max: MAX_BID_MS - 1 });

describe("solver bid sealing (v2)", () => {
  const bid: fc.Arbitrary<BidFields> = fc.record({
    orderId: bytes32,
    auctionId: nastyText,
    intentId: nastyText,
    output: amount,
    validUntilMs: ms,
    minExclusiveMs: ms,
  });

  // A single-field MUTATION is falsifiable: it fails for an encoder that drops
  // a member (the mutation stops changing the digest) or normalizes `output`
  // (the padded spelling stops being refused).
  const MUTATIONS: {
    label: string;
    outcome: "differs" | "refused";
    apply: (b: BidFields) => BidFields;
  }[] = [
    {
      label: "orderId",
      outcome: "differs",
      apply: (b) => ({
        ...b,
        orderId: b.orderId.slice(0, -1) + (b.orderId.endsWith("0") ? "1" : "0"),
      }),
    },
    {
      label: "auctionId",
      outcome: "differs",
      apply: (b) => ({ ...b, auctionId: `${b.auctionId}x` }),
    },
    { label: "intentId", outcome: "differs", apply: (b) => ({ ...b, intentId: `${b.intentId}x` }) },
    {
      label: "output+1",
      outcome: "differs",
      apply: (b) => ({ ...b, output: (BigInt(b.output) + 1n).toString() }),
    },
    {
      label: "validUntilMs+1",
      outcome: "differs",
      apply: (b) => ({ ...b, validUntilMs: b.validUntilMs + 1 }),
    },
    {
      label: "minExclusiveMs+1",
      outcome: "differs",
      apply: (b) => ({ ...b, minExclusiveMs: b.minExclusiveMs + 1 }),
    },
    // validUntilMs and minExclusiveMs are both uint64: a swapped pair must not
    // collide, or a venue could read a window as a deadline.
    {
      label: "time fields swapped",
      outcome: "differs",
      apply: (b) => ({ ...b, validUntilMs: b.minExclusiveMs, minExclusiveMs: b.validUntilMs }),
    },
    {
      label: "output zero-padded",
      outcome: "refused",
      apply: (b) => ({ ...b, output: `0${b.output}` }),
    },
  ];

  it("no single-field mutation leaves the digest unchanged", () => {
    fc.assert(
      fc.property(bid, fc.constantFrom(...MUTATIONS), (a, mutation) => {
        if (mutation.label === "output+1" && BigInt(a.output) === 2n ** 256n - 1n) return true;
        if (mutation.label === "time fields swapped" && a.validUntilMs === a.minExclusiveMs)
          return true;
        const mutated = mutation.apply(a);
        if (mutation.outcome === "refused") {
          expect(() => bidDigest(mutated)).toThrow(/canonical/);
          // Load-bearing: the padded spelling is the same uint256.
          expect(BigInt(mutated.output).toString()).toBe(a.output);
          return true;
        }
        return bidDigest(a) !== bidDigest(mutated);
      }),
      CFG,
    );
  });

  it("round-trips: a signed bid recovers to its signer", async () => {
    const wallet = new ethers.Wallet(SIGNING_KEY);
    await fc.assert(
      fc.asyncProperty(bid, async (a) => {
        const { domain, types, message } = bidTypedData(a);
        const signature = await wallet.signTypedData(domain, types, message);
        return verifyBid({ ...a, solverId: SIGNER, signature });
      }),
      { ...CFG, numRuns: Math.min(CFG.numRuns, 50) },
    );
  });

  it("refuses a non-canonical output rather than normalizing it", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 64n }),
        fc.integer({ min: 1, max: 3 }),
        (n, zeros) => {
          const padded = "0".repeat(zeros) + n.toString();
          expect(() => bidTypedData(fields({ output: padded }))).toThrow(/canonical/);
          return true;
        },
      ),
      CFG,
    );
  });

  it("refuses times past the range the wire can carry, and admits the boundary", () => {
    // uint64 in the struct, a bare JSON number on the wire: past 2^53-1 a
    // receiver reads back a different number than was signed.
    expect(() =>
      bidTypedData(fields({ validUntilMs: MAX_BID_MS, minExclusiveMs: MAX_BID_MS })),
    ).not.toThrow();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (delta) => {
        expect(() => bidTypedData(fields({ validUntilMs: MAX_BID_MS + delta }))).toThrow(
          /validUntilMs/,
        );
        expect(() => bidTypedData(fields({ minExclusiveMs: MAX_BID_MS + delta }))).toThrow(
          /minExclusiveMs/,
        );
        return true;
      }),
      CFG,
    );
    expect(() => bidTypedData(fields({ validUntilMs: -1 }))).toThrow(/validUntilMs/);
    expect(() => bidTypedData(fields({ minExclusiveMs: 1.5 }))).toThrow(/minExclusiveMs/);
  });

  it("refuses an orderId that is not 0x + 64 lowercase hex", () => {
    // Mixed case would be a second wire spelling of one bytes32 -- one digest,
    // two strings -- the same hazard a padded `output` is.
    for (const orderId of ["0x" + "AB".repeat(32), "0x" + "00".repeat(31), "00".repeat(32), ""]) {
      expect(() => bidTypedData(fields({ orderId }))).toThrow(/orderId/);
    }
  });

  it("refuses a lone surrogate instead of substituting U+FFFD", () => {
    expect(() => bidTypedData(fields({ auctionId: "\uD800" }))).toThrow();
    expect(
      verifyBid({ ...fields({ auctionId: "\uD800" }), solverId: SIGNER, signature: "0x" }),
    ).toBe(false);
  });
});

function fields(over: Partial<BidFields> = {}): BidFields {
  return {
    orderId: "0x" + "00".repeat(32),
    auctionId: "a",
    intentId: "i",
    output: "1",
    validUntilMs: 1,
    minExclusiveMs: 1,
    ...over,
  };
}
