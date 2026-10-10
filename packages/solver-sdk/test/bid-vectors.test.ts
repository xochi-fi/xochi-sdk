// Cross-implementation vector check for SolverBid v2 sealing (SOLVER-RFC.md §5.1).
//
// `client.test.ts` proves a bid this SDK signs is one this SDK verifies -- that is
// self-consistent and would stay green if the scheme changed shape. This file
// asserts the SHARED values in `@xochi/spec`'s `conformance/solver-bid-v2.json`,
// the file the Riddler server's bid intake and escrow FillAuthorizer are held to.
//
// Drift does not fail loudly: it rejects every honest bid in production, and on
// the escrow path it refuses every `:winner` FillAuth.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  bidTypedData,
  bidDigest,
  signBid,
  verifyBid,
  verifyBidDetailed,
  BidSchema,
  MAX_BID_MS,
  SOLVER_BID_DOMAIN,
  SOLVER_BID_PRIMARY_TYPE,
  SOLVER_BID_TYPES,
  ZERO_ORDER_ID,
  type Bid,
  type IntentAnnouncement,
  type SolverBidMessage,
} from "../src/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(here, "../../spec/conformance/solver-bid-v2.json");

// Literals, not re-derived from SOLVER_BID_DOMAIN / SOLVER_BID_TYPES: a value this
// repo edits on both sides of an assertion proves nothing. These are what a port
// debugs against, so a reviewer has to see them move in a diff.
const ENCODE_TYPE =
  "SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)";
const TYPE_HASH = "0x59967c7f45768718a73ec35fc3508d628c0e43fab45a375573ca244697e05b86";
const DOMAIN_SEPARATOR = "0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

interface Vector {
  name: string;
  why: string;
  bid: Omit<Bid, "signature">;
  message: SolverBidMessage;
  expected_struct_hash: string;
  expected_digest: string;
  signer_private_key: string;
  signer_address: string;
  expected_signature: string;
}

interface VectorFile {
  domain: { name: string; version: string };
  primary_type: string;
  types: unknown;
  encode_type: string;
  typehash: string;
  domain_separator: string;
  vectors: Vector[];
}

const fixture: VectorFile = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
const toBid = (v: Vector): Bid => ({ ...v.bid, signature: v.expected_signature });

function announcementFor(v: Vector): IntentAnnouncement {
  return {
    intentId: v.bid.intentId,
    auctionId: v.bid.auctionId,
    orderId: v.bid.orderId,
    fromChainId: 8453,
    toChainId: 10,
    fromToken: "USDC",
    toToken: "USDC",
    swapKind: "exact_input",
    fromAmount: "100000000",
    settlementPreference: "public",
    minOutput: "0",
    opensAt: 0,
    closesAt: 0,
    exclusiveWindowMs: 0,
  };
}

describe("SolverBid v2 conformance vectors", () => {
  it("pins the domain, type string, type hash and domain separator by value", () => {
    expect(fixture.domain).toEqual({ name: "RiddlerSolver", version: "2" });
    expect(SOLVER_BID_DOMAIN).toEqual({ name: "RiddlerSolver", version: "2" });
    expect(fixture.primary_type).toBe(SOLVER_BID_PRIMARY_TYPE);
    expect(fixture.types).toEqual(SOLVER_BID_TYPES);
    expect(fixture.encode_type).toBe(ENCODE_TYPE);
    expect(fixture.typehash).toBe(TYPE_HASH);
    expect(fixture.domain_separator).toBe(DOMAIN_SEPARATOR);
    // ...and the CODE still reaches them, which is the half that can drift.
    expect(ethers.TypedDataEncoder.from(SOLVER_BID_TYPES).encodeType(SOLVER_BID_PRIMARY_TYPE)).toBe(
      ENCODE_TYPE,
    );
    expect(ethers.keccak256(ethers.toUtf8Bytes(ENCODE_TYPE))).toBe(TYPE_HASH);
    expect(ethers.TypedDataEncoder.hashDomain(SOLVER_BID_DOMAIN)).toBe(DOMAIN_SEPARATOR);
  });

  it("covers the edge cases the server is held to", () => {
    const names = fixture.vectors.map((v) => v.name);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(5);
    expect(fixture.vectors.some((v) => v.bid.orderId === ZERO_ORDER_ID)).toBe(true);
    expect(fixture.vectors.some((v) => v.bid.output === (2n ** 256n - 1n).toString())).toBe(true);
    expect(
      fixture.vectors.some(
        (v) => v.bid.validUntilMs === MAX_BID_MS && v.bid.minExclusiveMs === MAX_BID_MS,
      ),
    ).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    // Every digest distinct: in particular the baseline and its orderId-only
    // mutation, which is what binds a bid to one order.
    expect(new Set(fixture.vectors.map((v) => v.expected_digest)).size).toBe(
      fixture.vectors.length - 1,
    );
  });

  for (const v of fixture.vectors) {
    describe(v.name, () => {
      it("is the exact wire object and signature signBid produces", async () => {
        const wallet = new ethers.Wallet(v.signer_private_key);
        const signed = await signBid(wallet, announcementFor(v), {
          output: v.bid.output,
          validUntilMs: v.bid.validUntilMs,
          minExclusiveMs: v.bid.minExclusiveMs,
        });
        // Through JSON, so a dropped or renamed key fails rather than being an
        // `undefined` toEqual forgives.
        const { signature, ...wire } = JSON.parse(JSON.stringify(signed));
        expect(wire).toEqual(v.bid);
        expect(signature).toBe(v.expected_signature);
        expect(wallet.address).toBe(v.signer_address);
        expect(v.bid.solverId).toBe(v.signer_address);
      });

      it(`derives the struct, struct hash and digest (${v.why})`, () => {
        const { message } = bidTypedData(v.bid);
        expect(message).toEqual(v.message);
        expect(
          ethers.TypedDataEncoder.hashStruct(SOLVER_BID_PRIMARY_TYPE, SOLVER_BID_TYPES, message),
        ).toBe(v.expected_struct_hash);
        expect(bidDigest(v.bid)).toBe(v.expected_digest);
        expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(
          v.signer_address,
        );
      });

      it("passes verifyBid and BidSchema, and fails when any signed field is tampered with", () => {
        expect(verifyBidDetailed(toBid(v))).toEqual({
          ok: true,
          reason: "verified",
          signer: v.signer_address,
        });
        expect(BidSchema.safeParse(toBid(v)).success).toBe(true);
        const flips: Partial<Bid>[] = [
          { output: v.bid.output === "0" ? "1" : "0" },
          { orderId: v.bid.orderId === ZERO_ORDER_ID ? "0x" + "11".repeat(32) : ZERO_ORDER_ID },
          { validUntilMs: v.bid.validUntilMs === 0 ? 1 : v.bid.validUntilMs - 1 },
          { minExclusiveMs: v.bid.minExclusiveMs === 0 ? 1 : v.bid.minExclusiveMs - 1 },
        ];
        for (const flip of flips)
          expect(verifyBid({ ...toBid(v), ...flip }), JSON.stringify(flip)).toBe(false);
      });
    });
  }

  it("refuses the high-s twin, the EIP-2098 compact form and uppercase hex of one seal", () => {
    const v = fixture.vectors[0]!;
    const sig = ethers.Signature.from(v.expected_signature);
    const highS = ethers.concat([
      sig.r,
      ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32),
      new Uint8Array([sig.v === 27 ? 28 : 27]),
    ]);
    for (const respelled of [
      highS,
      sig.compactSerialized,
      `0x${v.expected_signature.slice(2).toUpperCase()}`,
    ]) {
      const verdict = verifyBidDetailed({ ...toBid(v), signature: respelled });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe("bad_signature");
    }
  });

  it("refuses the v1 domain: a v1-sealed bid does not verify under v2", async () => {
    const v = fixture.vectors[0]!;
    const wallet = new ethers.Wallet(v.signer_private_key);
    const v1 = await wallet.signTypedData(
      { name: "RiddlerSolver", version: "1" },
      SOLVER_BID_TYPES,
      v.message,
    );
    expect(verifyBidDetailed({ ...toBid(v), signature: v1 }).reason).toBe("signer_mismatch");
  });
});
