// Xochi Settlement Protocol (XSP) hash primitives (riddler #1223, xochi #548/#551/#552).
// HASH-ONLY: typehashes, EIP-712 digests and the deposit-address derivation. There is
// deliberately no signing here -- the obligation is signed by the user's wallet and the
// Depository messages by the Allocator, neither of which this package holds a key for.
//
// These are a DIFFERENT instrument from the M6 escrow order (escrow.ts): XSP's
// `destAmount` is EXACT (release predicate `==`), while `DestOpening.toAmount` is a
// FLOOR (`>=`). See @xochi/spec ESCROW-RFC.md "XSP obligation".
//
// Every hash is computed by hand from `abi.encode` (never a generic typed-data
// encoder), so the test suite can cross-check against ethers' TypedDataEncoder and
// getCreate2Address as independent implementations.

import { ethers } from "ethers";
import type { Hex } from "./types";

type UintLike = bigint | number | string;

const coder = ethers.AbiCoder.defaultAbiCoder();
const keccak = (data: ethers.BytesLike): Hex => ethers.keccak256(data) as Hex;

export const EIP712_DOMAIN_TYPEHASH = ethers.id(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
) as Hex;

// ---------------------------------------------------------------------------
// Obligation (user-signed, origin chain)
// ---------------------------------------------------------------------------

export const OBLIGATION_DOMAIN_NAME = "Xochi Settlement";
export const OBLIGATION_DOMAIN_VERSION = "4";

// Field order is the spec struct's (xochi-spec settlement-protocol D3 §3.2); no
// contract implements it yet (xochi #551/#552 drafts), so this is the canonical form.
export const OBLIGATION_TYPE_STRING =
  "XochiObligation(uint256 originChainId,address originToken,uint256 originAmount,uint256 destChainId,bytes32 destToken,uint256 destAmount,bytes32 recipientCommitment,bytes32 refundCommitment,bool recoverable,address solver,uint8 settlementType,uint64 deadline,bytes32 quoteId,uint256 nonce)";
export const OBLIGATION_TYPEHASH = ethers.id(OBLIGATION_TYPE_STRING) as Hex;

export const SETTLEMENT_TYPE_PUBLIC = 1;
export const SETTLEMENT_TYPE_STEALTH = 2;
export const SETTLEMENT_TYPE_SHIELDED = 3;

export interface XochiObligation {
  originChainId: UintLike;
  originToken: string; // address; address(0) = native
  originAmount: UintLike;
  destChainId: UintLike;
  destToken: string; // bytes32; an EVM address is left-padded
  destAmount: UintLike; // EXACT
  recipientCommitment: string; // bytes32
  refundCommitment: string; // bytes32 = computeRefundCommitment(...)
  recoverable: boolean;
  solver: string; // address; address(0) = any solver
  settlementType: number; // 1 public, 2 stealth, 3 shielded
  deadline: UintLike; // uint64
  quoteId: string; // bytes32
  nonce: UintLike;
}

export interface XspDomain {
  name: string;
  version: string;
  chainId: UintLike;
  verifyingContract: string;
}

const UINT64_MAX = 2n ** 64n - 1n;

function uint64(value: UintLike, field: string): bigint {
  const v = BigInt(value);
  if (v < 0n || v > UINT64_MAX) throw new Error(`${field} out of uint64 range: ${value}`);
  return v;
}

export function xspDomainSeparator(domain: XspDomain): Hex {
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        EIP712_DOMAIN_TYPEHASH,
        ethers.id(domain.name),
        ethers.id(domain.version),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
}

function typedDataDigest(separator: string, structHash: string): Hex {
  return keccak(ethers.concat(["0x1901", separator, structHash]));
}

/** Obligation domain: chainId = originChainId, verifyingContract = XochiDepository on origin. */
export function obligationDomain(originChainId: UintLike, depository: string): XspDomain {
  return {
    name: OBLIGATION_DOMAIN_NAME,
    version: OBLIGATION_DOMAIN_VERSION,
    chainId: originChainId,
    verifyingContract: depository,
  };
}

export function computeRefundCommitment(refundAddress: string, refundSalt: string): Hex {
  return keccak(coder.encode(["address", "bytes32"], [refundAddress, refundSalt]));
}

export function hashObligation(terms: XochiObligation): Hex {
  const st = terms.settlementType;
  if (!Number.isInteger(st) || st < SETTLEMENT_TYPE_PUBLIC || st > SETTLEMENT_TYPE_SHIELDED) {
    throw new Error(`settlementType must be 1 (public), 2 (stealth) or 3 (shielded): ${st}`);
  }
  return keccak(
    coder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "bytes32",
        "bool",
        "address",
        "uint8",
        "uint64",
        "bytes32",
        "uint256",
      ],
      [
        OBLIGATION_TYPEHASH,
        BigInt(terms.originChainId),
        terms.originToken,
        BigInt(terms.originAmount),
        BigInt(terms.destChainId),
        terms.destToken,
        BigInt(terms.destAmount),
        terms.recipientCommitment,
        terms.refundCommitment,
        terms.recoverable,
        terms.solver,
        st,
        uint64(terms.deadline, "deadline"),
        terms.quoteId,
        BigInt(terms.nonce),
      ],
    ),
  );
}

/**
 * obligationId = EIP-712 digest of the obligation under the origin depository's domain.
 * It is also the ERC-3009 nonce and the Permit2 OriginPullWitness.orderId.
 */
export function computeObligationId(terms: XochiObligation, depository: string): Hex {
  return typedDataDigest(
    xspDomainSeparator(obligationDomain(terms.originChainId, depository)),
    hashObligation(terms),
  );
}

// ---------------------------------------------------------------------------
// Depository (Allocator-signed) -- strings exactly as XochiDepository.sol
// ---------------------------------------------------------------------------

export const DEPOSITORY_DOMAIN_NAME = "Xochi Depository";
export const DEPOSITORY_DOMAIN_VERSION = "1";

const TRANSFER_TYPE = "Transfer(address token,address to,uint256 amount)";
const RECORD_TYPE =
  "Record(bytes32 obligationId,bytes32 refundCommitment,address depositor,address token,uint256 amount,uint64 depositedAt)";

export const TRANSFER_TYPEHASH = ethers.id(TRANSFER_TYPE) as Hex;
export const RECORD_TYPEHASH = ethers.id(RECORD_TYPE) as Hex;
export const CALL_REQUEST_TYPEHASH = ethers.id(
  "CallRequest(bytes32 id,uint64 expiry,Transfer[] transfers,Record[] consume)" +
    RECORD_TYPE +
    TRANSFER_TYPE,
) as Hex;
export const MARK_CONSUMED_TYPEHASH = ethers.id(
  "MarkConsumed(Record[] consume,uint64 expiry,bytes32 salt)" + RECORD_TYPE,
) as Hex;

export interface DepositoryTransfer {
  token: string;
  to: string;
  amount: UintLike;
}

export interface DepositoryRecord {
  obligationId: string;
  refundCommitment: string;
  depositor: string;
  token: string;
  amount: UintLike;
  depositedAt: UintLike; // uint64
}

export interface CallRequest {
  id: string; // bytes32
  expiry: UintLike; // uint64
  transfers: DepositoryTransfer[];
  consume: DepositoryRecord[];
}

export interface MarkConsumed {
  consume: DepositoryRecord[];
  expiry: UintLike; // uint64
  salt: string; // bytes32
}

export function depositoryDomain(chainId: UintLike, depository: string): XspDomain {
  return {
    name: DEPOSITORY_DOMAIN_NAME,
    version: DEPOSITORY_DOMAIN_VERSION,
    chainId,
    verifyingContract: depository,
  };
}

function hashTransfers(transfers: DepositoryTransfer[]): Hex {
  return keccak(
    ethers.concat(
      transfers.map((t) =>
        keccak(
          coder.encode(
            ["bytes32", "address", "address", "uint256"],
            [TRANSFER_TYPEHASH, t.token, t.to, BigInt(t.amount)],
          ),
        ),
      ),
    ),
  );
}

function hashRecords(records: DepositoryRecord[]): Hex {
  return keccak(
    ethers.concat(
      records.map((r) =>
        keccak(
          coder.encode(
            ["bytes32", "bytes32", "bytes32", "address", "address", "uint256", "uint64"],
            [
              RECORD_TYPEHASH,
              r.obligationId,
              r.refundCommitment,
              r.depositor,
              r.token,
              BigInt(r.amount),
              uint64(r.depositedAt, "depositedAt"),
            ],
          ),
        ),
      ),
    ),
  );
}

export function hashCallRequest(req: CallRequest): Hex {
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "uint64", "bytes32", "bytes32"],
      [
        CALL_REQUEST_TYPEHASH,
        req.id,
        uint64(req.expiry, "expiry"),
        hashTransfers(req.transfers),
        hashRecords(req.consume),
      ],
    ),
  );
}

export function hashMarkConsumed(msg: MarkConsumed): Hex {
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "uint64", "bytes32"],
      [MARK_CONSUMED_TYPEHASH, hashRecords(msg.consume), uint64(msg.expiry, "expiry"), msg.salt],
    ),
  );
}

export function callRequestDigest(req: CallRequest, chainId: UintLike, depository: string): Hex {
  return typedDataDigest(
    xspDomainSeparator(depositoryDomain(chainId, depository)),
    hashCallRequest(req),
  );
}

export function markConsumedDigest(msg: MarkConsumed, chainId: UintLike, depository: string): Hex {
  return typedDataDigest(
    xspDomainSeparator(depositoryDomain(chainId, depository)),
    hashMarkConsumed(msg),
  );
}

// ---------------------------------------------------------------------------
// Deposit address (XochiDepositAddressFactory, xochi #548)
// ---------------------------------------------------------------------------

export interface DepositAddressInputs {
  obligationId: string;
  refundCommitment: string;
  recoverable: boolean;
  originToken: string;
  originAmount: UintLike;
}

/** Throws "ZeroOriginAmount" for originAmount == 0, mirroring the factory's revert. */
export function computeDepositAddressSalt(inputs: DepositAddressInputs): Hex {
  const amount = BigInt(inputs.originAmount);
  if (amount === 0n) throw new Error("ZeroOriginAmount");
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "bool", "address", "uint256"],
      [
        inputs.obligationId,
        inputs.refundCommitment,
        inputs.recoverable,
        inputs.originToken,
        amount,
      ],
    ),
  );
}

/** OpenZeppelin v5 Clones (EIP-1167) creation code for `implementation`. */
export function minimalProxyInitCode(implementation: string): Hex {
  return ethers.concat([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    ethers.getAddress(implementation),
    "0x5af43d82803e903d91602b57fd5bf3",
  ]) as Hex;
}

/** Clones.predictDeterministicAddress(implementation, salt, factory); lowercase. */
export function computeDepositAddress(
  factory: string,
  implementation: string,
  inputs: DepositAddressInputs,
): Hex {
  const salt = computeDepositAddressSalt(inputs);
  const hash = keccak(
    ethers.concat([
      "0xff",
      ethers.getAddress(factory),
      salt,
      keccak(minimalProxyInitCode(implementation)),
    ]),
  );
  return ethers.dataSlice(hash, 12).toLowerCase() as Hex;
}
