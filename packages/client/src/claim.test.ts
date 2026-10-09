/**
 * `checkPreparedClaim` over a sponsored v0.8 UserOperation built here the way
 * Riddler builds one: `execute(token, 0, transfer(recipient, amount))` from the
 * counterfactual account, hashed under the pinned EntryPoint. The hash function
 * itself is pinned to Riddler-generated vectors in `@riddler/signer`; these test
 * the refusal mapping and that every gap refuses.
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { ENTRYPOINT_V08_ADDRESS, computeUserOpHash, type PreparedClaim } from "@riddler/signer";
import { checkPreparedClaim, type PreparedClaimExpectation } from "./claim.js";

const COUNTERFACTUAL = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const RECIPIENT = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PAYMASTER = "0x0000000000000000000000000000000000009999";
const AMOUNT = 2_500_000n;

const EXECUTE = parseAbi(["function execute(address dest, uint256 value, bytes func)"]);
const TRANSFER = parseAbi(["function transfer(address to, uint256 amount)"]);

function prepared(
  over: { to?: string; value?: bigint; chainId?: number; paymaster?: string | null } = {},
): PreparedClaim {
  const callData = encodeFunctionData({
    abi: EXECUTE,
    functionName: "execute",
    args: [
      USDC_MAINNET,
      over.value ?? 0n,
      encodeFunctionData({
        abi: TRANSFER,
        functionName: "transfer",
        args: [(over.to ?? RECIPIENT) as `0x${string}`, AMOUNT],
      }),
    ],
  });
  const userOperation = {
    sender: COUNTERFACTUAL,
    nonce: "0x0",
    factory: null,
    factoryData: null,
    callData,
    callGasLimit: "0x186a0",
    verificationGasLimit: "0x30d40",
    preVerificationGas: "0xc350",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: over.paymaster === undefined ? PAYMASTER : over.paymaster,
    paymasterVerificationGasLimit: "0x186a0",
    paymasterPostOpGasLimit: "0xc350",
    paymasterData: "0x",
    signature: "0x",
  };
  const chainId = over.chainId ?? 1;
  return {
    userOpHash: computeUserOpHash(userOperation, ENTRYPOINT_V08_ADDRESS, chainId),
    chainId,
    counterfactualAddress: COUNTERFACTUAL,
    entryPoint: ENTRYPOINT_V08_ADDRESS,
    userOperation,
  };
}

const expected: PreparedClaimExpectation = {
  recipient: RECIPIENT,
  counterfactualAddress: COUNTERFACTUAL,
  settlementChainId: 1,
};

describe("checkPreparedClaim", () => {
  it("passes the claim that was asked for, reporting what it moves", () => {
    expect(checkPreparedClaim(prepared(), expected)).toEqual({
      ok: true,
      token: USDC_MAINNET,
      amount: AMOUNT.toString(),
    });
  });

  it("pins token and amount when the caller knows them", () => {
    expect(
      checkPreparedClaim(prepared(), {
        ...expected,
        expectedToken: USDC_MAINNET,
        expectedAmount: AMOUNT,
      }).ok,
    ).toBe(true);
    expect(checkPreparedClaim(prepared(), { ...expected, expectedAmount: 1n }).ok).toBe(false);
  });

  it.each([
    ["the sweep goes to someone else", prepared({ to: ATTACKER }), expected],
    ["the op also moves native value", prepared({ value: 1n }), expected],
    ["the op is unsponsored", prepared({ paymaster: null }), expected],
    ["the op is for another chain", prepared({ chainId: 8453 }), expected],
    [
      "the op spends from another account",
      prepared(),
      { ...expected, counterfactualAddress: RECIPIENT },
    ],
    [
      "the served hash is not the op's",
      { ...prepared(), userOpHash: "0x" + "11".repeat(32) },
      expected,
    ],
    ["the EntryPoint is not the pinned one", { ...prepared(), entryPoint: PAYMASTER }, expected],
  ] as [string, PreparedClaim, PreparedClaimExpectation][])(
    "refuses when %s",
    (_why, served, exp) => {
      const result = checkPreparedClaim(served, exp);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorCategory).toBe("claim_op_unverified");
    },
  );

  // requireVerified is forced: every gap is a refusal, never a warning.
  it.each([
    ["no userOperation", { ...prepared(), userOperation: undefined }, expected],
    ["no entryPoint", { ...prepared(), entryPoint: undefined }, expected],
    ["no settlement chain to bind to", prepared(), { ...expected, settlementChainId: null }],
  ] as [string, PreparedClaim, PreparedClaimExpectation][])(
    "refuses a gap: %s",
    (_why, served, exp) => {
      const result = checkPreparedClaim(served, exp);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Refusing to sign");
    },
  );
});
