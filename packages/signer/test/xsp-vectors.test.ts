// XSP (Xochi Settlement Protocol) vectors, riddler #1223: `@xochi/spec`'s
// conformance/xsp.json -- the file the Riddler server vendors as
// test/support/vectors/xochi_xsp.json.
//
// Two layers. (1) Every value in xsp.json is recomputed from @xochi/signer.
// (2) An INDEPENDENT cross-check: @xochi/signer hand-rolls each hash from
// abi.encode, so here the same values are recomputed with ethers' generic
// TypedDataEncoder (from the type definitions alone) and getCreate2Address over the
// EIP-1167 initcode. Without (2), the vectors would only ever be asserted by the code
// that produced them.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  CALL_REQUEST_TYPEHASH,
  MARK_CONSUMED_TYPEHASH,
  OBLIGATION_TYPE_STRING,
  OBLIGATION_TYPEHASH,
  RECORD_TYPEHASH,
  TRANSFER_TYPEHASH,
  callRequestDigest,
  computeDepositAddress,
  computeDepositAddressSalt,
  computeObligationId,
  computeRefundCommitment,
  hashCallRequest,
  hashMarkConsumed,
  hashObligation,
  markConsumedDigest,
  xspDomainSeparator,
} from "@xochi/signer";

type Domain = { name: string; version: string; chainId: string; verifyingContract: string };
type Terms = Parameters<typeof computeObligationId>[0];
type DepoRecord = Parameters<typeof hashMarkConsumed>[0]["consume"][number];
type DepositInputs = Parameters<typeof computeDepositAddressSalt>[0] & {
  name: string;
  factory: string;
  implementation: string;
};
type Hashes = { domainSeparator: string; structHash: string; digest: string };
interface XspFile {
  obligation: {
    typeString: string;
    typehash: string;
    vectors: { name: string; domain: Domain; terms: Terms; domainSeparator: string; structHash: string; obligationId: string }[];
    refundCommitments: { name: string; refundAddress: string; refundSalt: string; refundCommitment: string }[];
  };
  depository: {
    transferTypehash: string;
    recordTypehash: string;
    callRequestTypehash: string;
    markConsumedTypehash: string;
    vectors: (
      | ({ name: string; kind: "callRequest"; domain: Domain; message: Parameters<typeof hashCallRequest>[0] } & Hashes)
      | ({ name: string; kind: "markConsumed"; domain: Domain; message: { consume: DepoRecord[]; expiry: string; salt: string } } & Hashes)
    )[];
  };
  depositAddress: {
    vectors: (DepositInputs & { salt: string; address: string })[];
    rejections: (DepositInputs & { error: string })[];
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Parsed JSON from the spec package; every field read is asserted below.
const xsp = JSON.parse(
  fs.readFileSync(path.join(here, "../../spec/conformance/xsp.json"), "utf8"),
) as XspFile;

const OBLIGATION_TYPES = {
  XochiObligation: [
    { name: "originChainId", type: "uint256" },
    { name: "originToken", type: "address" },
    { name: "originAmount", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "destToken", type: "bytes32" },
    { name: "destAmount", type: "uint256" },
    { name: "recipientCommitment", type: "bytes32" },
    { name: "refundCommitment", type: "bytes32" },
    { name: "recoverable", type: "bool" },
    { name: "solver", type: "address" },
    { name: "settlementType", type: "uint8" },
    { name: "deadline", type: "uint64" },
    { name: "quoteId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

const RECORD_FIELDS = [
  { name: "obligationId", type: "bytes32" },
  { name: "refundCommitment", type: "bytes32" },
  { name: "depositor", type: "address" },
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "depositedAt", type: "uint64" },
];
const TRANSFER_FIELDS = [
  { name: "token", type: "address" },
  { name: "to", type: "address" },
  { name: "amount", type: "uint256" },
];
const CALL_REQUEST_TYPES = {
  CallRequest: [
    { name: "id", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "transfers", type: "Transfer[]" },
    { name: "consume", type: "Record[]" },
  ],
  Record: RECORD_FIELDS,
  Transfer: TRANSFER_FIELDS,
};
const MARK_CONSUMED_TYPES = {
  MarkConsumed: [
    { name: "consume", type: "Record[]" },
    { name: "expiry", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
  Record: RECORD_FIELDS,
};

describe("xsp.json: obligation", () => {
  it("pins the type string and typehash", () => {
    expect(xsp.obligation.typeString).toBe(OBLIGATION_TYPE_STRING);
    expect(xsp.obligation.typehash).toBe(OBLIGATION_TYPEHASH);
    expect(ethers.TypedDataEncoder.from(OBLIGATION_TYPES).encodeType("XochiObligation")).toBe(
      OBLIGATION_TYPE_STRING,
    );
  });

  for (const v of xsp.obligation.vectors) {
    it(`${v.name}: signer reproduces every value`, () => {
      const depository = v.domain.verifyingContract;
      expect(v.domain.chainId).toBe(v.terms.originChainId);
      expect(xspDomainSeparator(v.domain)).toBe(v.domainSeparator);
      expect(hashObligation(v.terms)).toBe(v.structHash);
      expect(computeObligationId(v.terms, depository)).toBe(v.obligationId);
    });

    it(`${v.name}: ethers TypedDataEncoder agrees (independent)`, () => {
      expect(ethers.TypedDataEncoder.hashDomain(v.domain)).toBe(v.domainSeparator);
      expect(ethers.TypedDataEncoder.hashStruct("XochiObligation", OBLIGATION_TYPES, v.terms)).toBe(
        v.structHash,
      );
      expect(ethers.TypedDataEncoder.hash(v.domain, OBLIGATION_TYPES, v.terms)).toBe(v.obligationId);
    });
  }

  it("binds destAmount and recoverable (single-field deltas change the id)", () => {
    const byName = (name: string) => {
      const v = xsp.obligation.vectors.find((x) => x.name === name);
      if (!v) throw new Error(`missing vector ${name}`);
      return v;
    };
    const base = byName("public-base-usdc");
    const plus = byName("public-base-usdc-dest-amount-plus-one");
    const nonRec = byName("public-base-usdc-not-recoverable");
    expect({ ...plus.terms, destAmount: base.terms.destAmount }).toEqual(base.terms);
    expect({ ...nonRec.terms, recoverable: true }).toEqual(base.terms);
    expect(plus.obligationId).not.toBe(base.obligationId);
    expect(nonRec.obligationId).not.toBe(base.obligationId);
  });

  it("rejects settlementType outside 1..3", () => {
    const [first] = xsp.obligation.vectors;
    if (!first) throw new Error("no obligation vectors");
    for (const st of [0, 4]) {
      expect(() => computeObligationId({ ...first.terms, settlementType: st }, first.domain.verifyingContract)).toThrow(
        /settlementType/,
      );
    }
  });

  for (const r of xsp.obligation.refundCommitments) {
    it(`refundCommitment ${r.name}`, () => {
      expect(computeRefundCommitment(r.refundAddress, r.refundSalt)).toBe(r.refundCommitment);
      expect(
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [r.refundAddress, r.refundSalt])),
      ).toBe(r.refundCommitment);
    });
  }
});

describe("xsp.json: depository", () => {
  it("pins the typehashes (exact XochiDepository.sol strings)", () => {
    expect(xsp.depository.transferTypehash).toBe(TRANSFER_TYPEHASH);
    expect(xsp.depository.recordTypehash).toBe(RECORD_TYPEHASH);
    expect(xsp.depository.callRequestTypehash).toBe(CALL_REQUEST_TYPEHASH);
    expect(xsp.depository.markConsumedTypehash).toBe(MARK_CONSUMED_TYPEHASH);
    expect(ethers.id(ethers.TypedDataEncoder.from(CALL_REQUEST_TYPES).encodeType("CallRequest"))).toBe(
      CALL_REQUEST_TYPEHASH,
    );
    expect(ethers.id(ethers.TypedDataEncoder.from(MARK_CONSUMED_TYPES).encodeType("MarkConsumed"))).toBe(
      MARK_CONSUMED_TYPEHASH,
    );
    expect(ethers.id(ethers.TypedDataEncoder.from({ Transfer: TRANSFER_FIELDS }).encodeType("Transfer"))).toBe(
      TRANSFER_TYPEHASH,
    );
    expect(ethers.id(ethers.TypedDataEncoder.from({ Record: RECORD_FIELDS }).encodeType("Record"))).toBe(
      RECORD_TYPEHASH,
    );
  });

  for (const v of xsp.depository.vectors) {
    it(`${v.name}: signer + ethers TypedDataEncoder agree`, () => {
      const { chainId, verifyingContract } = v.domain;
      expect(xspDomainSeparator(v.domain)).toBe(v.domainSeparator);
      expect(ethers.TypedDataEncoder.hashDomain(v.domain)).toBe(v.domainSeparator);
      if (v.kind === "callRequest") {
        expect(hashCallRequest(v.message)).toBe(v.structHash);
        expect(callRequestDigest(v.message, chainId, verifyingContract)).toBe(v.digest);
        expect(ethers.TypedDataEncoder.hash(v.domain, CALL_REQUEST_TYPES, v.message)).toBe(v.digest);
      } else {
        expect(hashMarkConsumed(v.message)).toBe(v.structHash);
        expect(markConsumedDigest(v.message, chainId, verifyingContract)).toBe(v.digest);
        expect(ethers.TypedDataEncoder.hash(v.domain, MARK_CONSUMED_TYPES, v.message)).toBe(v.digest);
      }
    });
  }

  it("covers empty arrays (keccak256 of empty bytes)", () => {
    const empty = xsp.depository.vectors.find(
      (v) =>
        v.kind === "callRequest" && v.message.transfers.length === 0 && v.message.consume.length === 0,
    );
    expect(empty).toBeDefined();
  });
});

describe("xsp.json: deposit address", () => {
  for (const v of xsp.depositAddress.vectors) {
    it(`${v.name}: signer + ethers getCreate2Address agree`, () => {
      expect(computeDepositAddressSalt(v)).toBe(v.salt);
      expect(computeDepositAddress(v.factory, v.implementation, v)).toBe(v.address);
      const initCode = ethers.concat([
        "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
        v.implementation,
        "0x5af43d82803e903d91602b57fd5bf3",
      ]);
      expect(ethers.getCreate2Address(v.factory, v.salt, ethers.keccak256(initCode)).toLowerCase()).toBe(v.address);
    });
  }

  for (const r of xsp.depositAddress.rejections) {
    it(`${r.name}: rejects with ${r.error}`, () => {
      expect(() => computeDepositAddress(r.factory, r.implementation, r)).toThrow(r.error);
    });
  }
});
