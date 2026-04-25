/**
 * Typed contract error decoder tests.
 *
 * Constructs viem `BaseError`s wrapping `ContractFunctionRevertedError`s
 * to verify the decoder maps Solidity revert names to typed JS classes.
 */

import { describe, it, expect } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";
import {
  decodeContractError,
  XochiContractError,
  SubmitterMismatchError,
  ProofAlreadyUsedError,
  ProofTimestampStaleError,
  BatchTooLargeError,
  EmptyBatchError,
  VersionRevokedError,
  TradeNotFoundError,
} from "../src/errors.js";
import { ORACLE_ABI, VERIFIER_ABI } from "../src/abis.js";
import { SETTLEMENT_REGISTRY_ABI } from "../src/settlement-registry.js";

function makeRevert(errorName: string, args: unknown[]) {
  // Build the same shape viem produces when it walks a revert.
  const inner = new ContractFunctionRevertedError({
    abi: [],
    functionName: "test",
    message: `${errorName} reverted`,
  });
  // viem populates `.data` from ABI-decoded revert data; do it manually here.
  Object.assign(inner, { data: { errorName, args } });
  return new BaseError(inner.shortMessage, { cause: inner });
}

describe("decodeContractError", () => {
  it("returns null for non-BaseError input", () => {
    expect(decodeContractError(new Error("plain"), ORACLE_ABI)).toBeNull();
    expect(decodeContractError("string", ORACLE_ABI)).toBeNull();
  });

  it("decodes SubmitterMismatch", () => {
    const err = decodeContractError(makeRevert("SubmitterMismatch", []), ORACLE_ABI);
    expect(err).toBeInstanceOf(SubmitterMismatchError);
    expect(err).toBeInstanceOf(XochiContractError);
    expect(err?.errorName).toBe("SubmitterMismatch");
    expect(err?.message).toMatch(/anti-frontrun/);
  });

  it("decodes ProofAlreadyUsed with proofHash arg", () => {
    const hash = "0xabc";
    const err = decodeContractError(makeRevert("ProofAlreadyUsed", [hash]), ORACLE_ABI);
    expect(err).toBeInstanceOf(ProofAlreadyUsedError);
    expect((err as ProofAlreadyUsedError).proofHash).toBe(hash);
  });

  it("decodes ProofTimestampStale with bigint args", () => {
    const err = decodeContractError(
      makeRevert("ProofTimestampStale", [1700000000n, 1700003700n]),
      ORACLE_ABI,
    );
    expect(err).toBeInstanceOf(ProofTimestampStaleError);
    expect((err as ProofTimestampStaleError).proofTimestamp).toBe(1700000000n);
    expect((err as ProofTimestampStaleError).blockTimestamp).toBe(1700003700n);
  });

  it("decodes BatchTooLarge and EmptyBatch (no args)", () => {
    expect(decodeContractError(makeRevert("BatchTooLarge", []), ORACLE_ABI)).toBeInstanceOf(
      BatchTooLargeError,
    );
    expect(decodeContractError(makeRevert("EmptyBatch", []), ORACLE_ABI)).toBeInstanceOf(
      EmptyBatchError,
    );
  });

  it("decodes verifier VersionRevoked", () => {
    const err = decodeContractError(makeRevert("VersionRevoked", [1, 5n]), VERIFIER_ABI);
    expect(err).toBeInstanceOf(VersionRevokedError);
    expect((err as VersionRevokedError).proofType).toBe(1);
    expect((err as VersionRevokedError).version).toBe(5n);
  });

  it("decodes registry TradeNotFound", () => {
    const tradeId = "0x1234";
    const err = decodeContractError(
      makeRevert("TradeNotFound", [tradeId]),
      SETTLEMENT_REGISTRY_ABI,
    );
    expect(err).toBeInstanceOf(TradeNotFoundError);
    expect((err as TradeNotFoundError).tradeId).toBe(tradeId);
  });

  it("falls back to base XochiContractError for unrecognized error names", () => {
    const err = decodeContractError(makeRevert("SomeUnknownError", [42]), ORACLE_ABI);
    expect(err).toBeInstanceOf(XochiContractError);
    expect(err?.errorName).toBe("SomeUnknownError");
    expect(err?.args).toEqual([42]);
  });
});
