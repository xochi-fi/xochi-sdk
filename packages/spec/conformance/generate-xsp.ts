#!/usr/bin/env node
// Generates `conformance/xsp.json` (+ `xsp.schema.json`): the cross-implementation
// vector set for the Xochi Settlement Protocol (riddler #1223, ESCROW-RFC "XSP
// obligation"): the user-signed XochiObligation EIP-712 digest (obligationId), the
// refund commitment, the Allocator-signed Depository CallRequest/MarkConsumed digests,
// and the deposit-address derivation (XochiDepositAddressFactory, xochi #548).
//
// `@xochi/signer` is the REFERENCE. The Riddler server vendors this file
// byte-identical (test/support/vectors/xochi_xsp.json) and must reproduce every value.
// All addresses here are FIXTURES: no XSP contract is deployed.
//
// Run: npm run generate:xsp

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
  depositoryDomain,
  xspDomainSeparator,
  hashCallRequest,
  hashMarkConsumed,
  hashObligation,
  markConsumedDigest,
  obligationDomain,
  type CallRequest,
  type DepositAddressInputs,
  type DepositoryRecord,
  type MarkConsumed,
  type XochiObligation,
} from "@xochi/signer";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT64_MAX = (2n ** 64n - 1n).toString();

// Fixture contract addresses (no deployment exists).
const DEPOSITORY_BASE = "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";
const DEPOSITORY_ETH = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";
const FACTORY = "0xfac7000000000000000000000000000000000001";
const IMPLEMENTATION = "0x1111000000000000000000000000000000000002";

const pad32 = (addr: string) => ethers.zeroPadValue(addr, 32).toLowerCase();

const REFUND_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const REFUND_SALT = "0x" + "a5".repeat(32);
const REFUND_COMMITMENT = computeRefundCommitment(REFUND_ADDRESS, REFUND_SALT);

// Tron USDT TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: base58check decodes to 21 bytes
// (0x41 prefix + 20-byte address); destToken is those 21 bytes left-padded to 32.
const TRON_USDT_21 = "0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

const BASE: XochiObligation = {
  originChainId: 8453,
  originToken: "0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5",
  originAmount: "100000000",
  destChainId: 10,
  destToken: pad32("0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
  destAmount: "99700000",
  recipientCommitment: "0x" + "c1".repeat(32),
  refundCommitment: REFUND_COMMITMENT,
  recoverable: true,
  solver: "0x3333333333333333333333333333333333333333",
  settlementType: 1,
  deadline: 1900000000,
  quoteId: "0x" + "9e".repeat(32),
  nonce: "1",
};

type ObligationCase = { name: string; depository: string; terms: XochiObligation };

const OBLIGATIONS: ObligationCase[] = [
  { name: "public-base-usdc", depository: DEPOSITORY_BASE, terms: BASE },
  {
    name: "public-base-usdc-dest-amount-plus-one",
    depository: DEPOSITORY_BASE,
    terms: { ...BASE, destAmount: "99700001" },
  },
  {
    name: "public-base-usdc-not-recoverable",
    depository: DEPOSITORY_BASE,
    terms: { ...BASE, recoverable: false },
  },
  { name: "stealth-base-usdc", depository: DEPOSITORY_BASE, terms: { ...BASE, settlementType: 2 } },
  {
    name: "shielded-eth-native-any-solver",
    depository: DEPOSITORY_ETH,
    terms: {
      ...BASE,
      originChainId: 1,
      originToken: ZERO_ADDRESS,
      originAmount: "1000000000000000000",
      solver: ZERO_ADDRESS,
      settlementType: 3,
      nonce: "7",
    },
  },
  {
    name: "public-max-uint64-deadline",
    depository: DEPOSITORY_BASE,
    terms: { ...BASE, deadline: UINT64_MAX },
  },
  {
    name: "public-tron-dest-usdt",
    depository: DEPOSITORY_BASE,
    terms: {
      ...BASE,
      destChainId: 728126428,
      destToken: ethers.zeroPadValue(TRON_USDT_21, 32).toLowerCase(),
      destAmount: "99650000",
    },
  },
];

const termsJson = (t: XochiObligation) => ({
  originChainId: String(t.originChainId),
  originToken: t.originToken.toLowerCase(),
  originAmount: String(t.originAmount),
  destChainId: String(t.destChainId),
  destToken: t.destToken.toLowerCase(),
  destAmount: String(t.destAmount),
  recipientCommitment: t.recipientCommitment.toLowerCase(),
  refundCommitment: t.refundCommitment.toLowerCase(),
  recoverable: t.recoverable,
  solver: t.solver.toLowerCase(),
  settlementType: t.settlementType,
  deadline: String(t.deadline),
  quoteId: t.quoteId.toLowerCase(),
  nonce: String(t.nonce),
});

const domainJson = (d: {
  name: string;
  version: string;
  chainId: unknown;
  verifyingContract: string;
}) => ({
  name: d.name,
  version: d.version,
  chainId: String(d.chainId),
  verifyingContract: d.verifyingContract.toLowerCase(),
});

const obligationVectors = OBLIGATIONS.map(({ name, depository, terms }) => {
  const domain = obligationDomain(terms.originChainId, depository);
  return {
    name,
    domain: domainJson(domain),
    terms: termsJson(terms),
    domainSeparator: xspDomainSeparator(domain),
    structHash: hashObligation(terms),
    obligationId: computeObligationId(terms, depository),
  };
});

const refundCommitments = [
  { name: "baseline", refundAddress: REFUND_ADDRESS, refundSalt: REFUND_SALT },
  { name: "zero-salt", refundAddress: REFUND_ADDRESS, refundSalt: ethers.ZeroHash },
  {
    name: "high-bit-salt",
    refundAddress: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
    refundSalt: "0x" + "ff" + "00".repeat(30) + "01",
  },
].map((r) => ({ ...r, refundCommitment: computeRefundCommitment(r.refundAddress, r.refundSalt) }));

// --- Depository ------------------------------------------------------------

const OBL_A = obligationVectors[0]!.obligationId;
const OBL_B = obligationVectors[4]!.obligationId;

const RECORD_A: DepositoryRecord = {
  obligationId: OBL_A,
  refundCommitment: REFUND_COMMITMENT,
  depositor: "0x1111111111111111111111111111111111111111",
  token: BASE.originToken,
  amount: "100000000",
  depositedAt: 1899990000,
};
const RECORD_B: DepositoryRecord = {
  obligationId: OBL_B,
  refundCommitment: refundCommitments[2]!.refundCommitment,
  depositor: "0x2222222222222222222222222222222222222222",
  token: ZERO_ADDRESS,
  amount: "1000000000000000000",
  depositedAt: UINT64_MAX,
};

const recordJson = (r: DepositoryRecord) => ({
  obligationId: r.obligationId.toLowerCase(),
  refundCommitment: r.refundCommitment.toLowerCase(),
  depositor: r.depositor.toLowerCase(),
  token: r.token.toLowerCase(),
  amount: String(r.amount),
  depositedAt: String(r.depositedAt),
});

type DepoCase =
  | { name: string; kind: "callRequest"; chainId: number; depository: string; message: CallRequest }
  | {
      name: string;
      kind: "markConsumed";
      chainId: number;
      depository: string;
      message: MarkConsumed;
    };

const DEPOSITORY_CASES: DepoCase[] = [
  {
    name: "call-request-empty",
    kind: "callRequest",
    chainId: 8453,
    depository: DEPOSITORY_BASE,
    message: { id: "0x" + "01".repeat(32), expiry: 1900000100, transfers: [], consume: [] },
  },
  {
    name: "call-request-two-transfers-two-records",
    kind: "callRequest",
    chainId: 8453,
    depository: DEPOSITORY_BASE,
    message: {
      id: "0x" + "02".repeat(32),
      expiry: UINT64_MAX,
      transfers: [
        {
          token: BASE.originToken,
          to: "0x4444444444444444444444444444444444444444",
          amount: "60000000",
        },
        {
          token: ZERO_ADDRESS,
          to: "0x5555555555555555555555555555555555555555",
          amount: "40000000",
        },
      ],
      consume: [RECORD_A, RECORD_B],
    },
  },
  {
    name: "mark-consumed-one-record",
    kind: "markConsumed",
    chainId: 8453,
    depository: DEPOSITORY_BASE,
    message: { consume: [RECORD_A], expiry: 1900000200, salt: "0x" + "5a".repeat(32) },
  },
  {
    name: "mark-consumed-two-records-mainnet",
    kind: "markConsumed",
    chainId: 1,
    depository: DEPOSITORY_ETH,
    message: { consume: [RECORD_A, RECORD_B], expiry: 1900000300, salt: ethers.ZeroHash },
  },
];

const depositoryVectors = DEPOSITORY_CASES.map((c) => {
  const domain = depositoryDomain(c.chainId, c.depository);
  const common = { name: c.name, kind: c.kind, domain: domainJson(domain) };
  if (c.kind === "callRequest") {
    const m = c.message;
    return {
      ...common,
      message: {
        id: m.id.toLowerCase(),
        expiry: String(m.expiry),
        transfers: m.transfers.map((t) => ({
          token: t.token.toLowerCase(),
          to: t.to.toLowerCase(),
          amount: String(t.amount),
        })),
        consume: m.consume.map(recordJson),
      },
      domainSeparator: xspDomainSeparator(domain),
      structHash: hashCallRequest(m),
      digest: callRequestDigest(m, c.chainId, c.depository),
    };
  }
  const m = c.message;
  return {
    ...common,
    message: {
      consume: m.consume.map(recordJson),
      expiry: String(m.expiry),
      salt: m.salt.toLowerCase(),
    },
    domainSeparator: xspDomainSeparator(domain),
    structHash: hashMarkConsumed(m),
    digest: markConsumedDigest(m, c.chainId, c.depository),
  };
});

// --- Deposit address ---------------------------------------------------------

type AddrCase = { name: string; inputs: DepositAddressInputs };
const ADDR_CASES: AddrCase[] = [
  {
    name: "erc20-recoverable",
    inputs: {
      obligationId: OBL_A,
      refundCommitment: REFUND_COMMITMENT,
      recoverable: true,
      originToken: BASE.originToken,
      originAmount: "100000000",
    },
  },
  {
    name: "erc20-not-recoverable",
    inputs: {
      obligationId: OBL_A,
      refundCommitment: REFUND_COMMITMENT,
      recoverable: false,
      originToken: BASE.originToken,
      originAmount: "100000000",
    },
  },
  {
    name: "native-recoverable",
    inputs: {
      obligationId: OBL_B,
      refundCommitment: REFUND_COMMITMENT,
      recoverable: true,
      originToken: ZERO_ADDRESS,
      originAmount: "1000000000000000000",
    },
  },
];

const addrInputsJson = (i: DepositAddressInputs) => ({
  obligationId: i.obligationId.toLowerCase(),
  refundCommitment: i.refundCommitment.toLowerCase(),
  recoverable: i.recoverable,
  originToken: i.originToken.toLowerCase(),
  originAmount: String(i.originAmount),
});

const depositAddressVectors = ADDR_CASES.map(({ name, inputs }) => ({
  name,
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  ...addrInputsJson(inputs),
  salt: computeDepositAddressSalt(inputs),
  address: computeDepositAddress(FACTORY, IMPLEMENTATION, inputs),
}));

const ZERO_CASE = { ...ADDR_CASES[0]!.inputs, originAmount: "0" };
let zeroError = "";
try {
  computeDepositAddress(FACTORY, IMPLEMENTATION, ZERO_CASE);
} catch (e) {
  zeroError = (e as Error).message;
}
if (zeroError !== "ZeroOriginAmount")
  throw new Error(`zero-amount case did not reject: ${zeroError}`);
const rejections = [
  {
    name: "zero-origin-amount",
    factory: FACTORY,
    implementation: IMPLEMENTATION,
    ...addrInputsJson(ZERO_CASE),
    error: zeroError,
  },
];

const out = {
  version: 1,
  generator: "packages/spec/conformance/generate-xsp.ts",
  obligation: {
    typeString: OBLIGATION_TYPE_STRING,
    typehash: OBLIGATION_TYPEHASH,
    vectors: obligationVectors,
    refundCommitments,
  },
  depository: {
    transferTypehash: TRANSFER_TYPEHASH,
    recordTypehash: RECORD_TYPEHASH,
    callRequestTypehash: CALL_REQUEST_TYPEHASH,
    markConsumedTypehash: MARK_CONSUMED_TYPEHASH,
    vectors: depositoryVectors,
  },
  depositAddress: { vectors: depositAddressVectors, rejections },
};

// --- Schema ------------------------------------------------------------------

const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const obj = (props: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(props),
  additionalProperties: false,
  properties: props,
});
const DOMAIN = obj({
  name: { type: "string" },
  version: { type: "string" },
  chainId: UINT,
  verifyingContract: ADDR,
});
const RECORD = obj({
  obligationId: HEX32,
  refundCommitment: HEX32,
  depositor: ADDR,
  token: ADDR,
  amount: UINT,
  depositedAt: UINT,
});
const TRANSFER = obj({ token: ADDR, to: ADDR, amount: UINT });
const ADDR_INPUTS = {
  name: { type: "string" },
  factory: ADDR,
  implementation: ADDR,
  obligationId: HEX32,
  refundCommitment: HEX32,
  recoverable: { type: "boolean" },
  originToken: ADDR,
  originAmount: UINT,
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://riddler.axol.io/spec/conformance/xsp.schema.json",
  title: "Xochi Settlement Protocol (XSP) vector set",
  description:
    "Cross-implementation vectors for the XochiObligation EIP-712 obligationId, refundCommitment, the " +
    "XochiDepository CallRequest/MarkConsumed digests and the deposit-address derivation (ESCROW-RFC " +
    '"XSP obligation"). Reference: @xochi/signer. uint values are decimal strings; bytes/addresses lowercase hex.',
  ...obj({
    version: { const: 1 },
    generator: { type: "string" },
    obligation: obj({
      typeString: { type: "string" },
      typehash: HEX32,
      vectors: {
        type: "array",
        minItems: 1,
        items: obj({
          name: { type: "string" },
          domain: DOMAIN,
          terms: obj({
            originChainId: UINT,
            originToken: ADDR,
            originAmount: UINT,
            destChainId: UINT,
            destToken: HEX32,
            destAmount: UINT,
            recipientCommitment: HEX32,
            refundCommitment: HEX32,
            recoverable: { type: "boolean" },
            solver: ADDR,
            settlementType: { type: "integer", enum: [1, 2, 3] },
            deadline: UINT,
            quoteId: HEX32,
            nonce: UINT,
          }),
          domainSeparator: HEX32,
          structHash: HEX32,
          obligationId: HEX32,
        }),
      },
      refundCommitments: {
        type: "array",
        minItems: 1,
        items: obj({
          name: { type: "string" },
          refundAddress: ADDR,
          refundSalt: HEX32,
          refundCommitment: HEX32,
        }),
      },
    }),
    depository: obj({
      transferTypehash: HEX32,
      recordTypehash: HEX32,
      callRequestTypehash: HEX32,
      markConsumedTypehash: HEX32,
      vectors: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            obj({
              name: { type: "string" },
              kind: { const: "callRequest" },
              domain: DOMAIN,
              message: obj({
                id: HEX32,
                expiry: UINT,
                transfers: { type: "array", items: TRANSFER },
                consume: { type: "array", items: RECORD },
              }),
              domainSeparator: HEX32,
              structHash: HEX32,
              digest: HEX32,
            }),
            obj({
              name: { type: "string" },
              kind: { const: "markConsumed" },
              domain: DOMAIN,
              message: obj({
                consume: { type: "array", items: RECORD },
                expiry: UINT,
                salt: HEX32,
              }),
              domainSeparator: HEX32,
              structHash: HEX32,
              digest: HEX32,
            }),
          ],
        },
      },
    }),
    depositAddress: obj({
      vectors: {
        type: "array",
        minItems: 1,
        items: obj({ ...ADDR_INPUTS, salt: HEX32, address: ADDR }),
      },
      rejections: {
        type: "array",
        minItems: 1,
        items: obj({ ...ADDR_INPUTS, error: { const: "ZeroOriginAmount" } }),
      },
    }),
  }),
};

const dir = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "xsp.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "xsp.schema.json"), JSON.stringify(schema, null, 2) + "\n");
console.log(
  `wrote xsp.json: ${obligationVectors.length} obligations, ${depositoryVectors.length} depository, ${depositAddressVectors.length} deposit addresses`,
);
for (const v of obligationVectors) console.log(`  ${v.name.padEnd(40)} ${v.obligationId}`);
