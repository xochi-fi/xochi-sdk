// `verifyClaimUserOp`: the fail-closed claim check that binds the served op to the
// announcement and to the signing key. Ported from `@xochi-fi/shared`'s `userop.test.ts`
// (xochi#472), which verified the same op with viem; every refusal case there is here,
// plus the ones it lacked (marked "not in shared").
//
// The op is Riddler's own vector, from `test/riddler/evm/erc4337/user_operation_test.exs`,
// and `RIDDLER_SPONSORED_HASH` is Riddler's `UserOperation.compute_hash/2` over it on
// Ethereum. Shared pinned that value against viem; pinning it here against this SDK's
// ethers implementation makes three implementations that share no code agree on it.

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  computeUserOpHash,
  decodeCreateAccountCall,
  decodeErc20TransferExecute,
  ENTRYPOINT_V08_ADDRESS,
  UserOperationError,
  verifyClaimUserOp,
  type UserOperationV08,
  type ClaimAnnouncement,
  type VerifyClaimUserOpParams,
} from "@xochi/signer";

const SENDER = "0xdfca25a7250bafac013c3bb9a3640c781e95765e";
const RECIPIENT = "0xe9674277e85d7e5ddf1340dce118d1b887bee727";
/** USDC on L1: the token Riddler's vector settles, and what the announcement names. */
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
/** A contract the caller never asked about, standing in for a substituted target. */
const HOSTILE = "0x1111111111111111111111111111111111111111";
/** Owner encoded in the vector's `factoryData`, and so the key that must sign. */
const OWNER = "0xee933252c346fd09e81df6eb1d6b4824c92268c5";
/** SimpleAccountFactory from the vector, matching production announcements. */
const FACTORY = "0x13E9ed32155810FDbd067D4522C492D6f68E5944";
/** CREATE2 salt in the vector's `factoryData`. Production announcements use 0. */
const SALT = 0x40n;

const ABI = new ethers.Interface([
  "function execute(address dest, uint256 value, bytes func)",
  "function transfer(address to, uint256 amount)",
  "function createAccount(address owner, uint256 salt)",
]);

/** Build an outer `execute` the way a hostile prepare would. */
const executeCall = (dest: string, value: bigint, to: string, amount: bigint) =>
  ABI.encodeFunctionData("execute", [
    dest,
    value,
    ABI.encodeFunctionData("transfer", [to, amount]),
  ]);

const createAccountCall = (owner: string, salt: bigint) =>
  ABI.encodeFunctionData("createAccount", [owner, salt]);

/**
 * The announcement's decoded metadata, in the full shape a scanner decodes from the
 * ERC-5564 blob `[viewTag(1)][token(20)][selector(4)][amount(32)][factory(20)][salt(32)]`.
 * The verifier reads only token, factory and salt, and echoes the rest back.
 */
const announcementFor = (token: string) => ({
  viewTag: 0x0c,
  token,
  selector: "0xa9059cbb",
  amount: 1_000_000n,
  factory: FACTORY.toLowerCase(),
  salt: SALT,
});

/** `execute(USDC, 0, transfer(0xe967..., 1000000))`, from Riddler's vectors. */
const CALL_DATA =
  "0xb61d27f6000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000e9674277e85d7e5ddf1340dce118d1b887bee72700000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000";

const BASE_OP: UserOperationV08 = {
  sender: SENDER,
  nonce: "0x0",
  factory: null,
  factoryData: "0x",
  callData: CALL_DATA,
  callGasLimit: "0x30000",
  verificationGasLimit: "0x30000",
  preVerificationGas: "0x10000",
  maxFeePerGas: "0x77359400",
  maxPriorityFeePerGas: "0x3b9aca00",
  paymaster: null,
  paymasterVerificationGasLimit: "0x0",
  paymasterPostOpGasLimit: "0x0",
  paymasterData: "0x",
  signature: "0x",
};

/** A real claim is always sponsored and always deploys the account. */
const SPONSORED_OP: UserOperationV08 = {
  ...BASE_OP,
  factory: FACTORY,
  factoryData:
    "0x5fbfb9cf000000000000000000000000ee933252c346fd09e81df6eb1d6b4824c92268c50000000000000000000000000000000000000000000000000000000000000040",
  callGasLimit: "0x15f90",
  verificationGasLimit: "0x16e360",
  preVerificationGas: "0xe528",
  paymaster: "0x0000000000000039cd5e8ae05257ce51c473ddd1",
  paymasterVerificationGasLimit: "0xffff",
  paymasterPostOpGasLimit: "0x1",
  paymasterData: "0x01000000678122b100000000000000000000aaaaabbbbccccc",
};

const hashOf = (op: UserOperationV08, chainId = 1) =>
  computeUserOpHash(op, ENTRYPOINT_V08_ADDRESS, chainId);

/** Riddler's `UserOperation.compute_hash/2` for `SPONSORED_OP` on Ethereum. */
const RIDDLER_SPONSORED_HASH = "0x923304c1a7902b3020ace3c7809bc06b868380a6f35b44c5efe98556ab4e72bd";

describe("computeUserOpHash (shared's vector)", () => {
  it("matches Riddler's pinned EntryPoint v0.8 hash for the vector", () => {
    expect(hashOf(SPONSORED_OP)).toBe(RIDDLER_SPONSORED_HASH);
  });

  it("is deterministic and 32 bytes", () => {
    const hash = hashOf(BASE_OP);
    expect(hash).toBe(hashOf(BASE_OP));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("binds the chain id", () => {
    expect(hashOf(BASE_OP, 1)).not.toBe(hashOf(BASE_OP, 8453));
  });

  it("binds the factory, so initCode cannot be swapped silently", () => {
    expect(hashOf(SPONSORED_OP)).not.toBe(
      hashOf({ ...SPONSORED_OP, factory: null, factoryData: "0x" }),
    );
  });

  it("binds the paymaster fields that sponsorship rewrites", () => {
    expect(hashOf(SPONSORED_OP)).not.toBe(
      hashOf({
        ...SPONSORED_OP,
        paymaster: null,
        paymasterVerificationGasLimit: "0x0",
        paymasterPostOpGasLimit: "0x0",
        paymasterData: "0x",
      }),
    );
  });

  it("binds every field an attacker would change", () => {
    const base = hashOf(SPONSORED_OP);
    for (const mutation of [
      { sender: HOSTILE },
      { nonce: "0x1" },
      { callData: CALL_DATA.replace("e9674277", "dead4277") },
      { callGasLimit: "0x30001" },
      { maxFeePerGas: "0x77359401" },
    ] as Partial<UserOperationV08>[]) {
      expect(hashOf({ ...SPONSORED_OP, ...mutation }), JSON.stringify(mutation)).not.toBe(base);
    }
  });
});

describe("decodeErc20TransferExecute (shared's vector)", () => {
  it("reads the token, recipient, amount and native value out of the nested calldata", () => {
    expect(decodeErc20TransferExecute(SPONSORED_OP.callData)).toEqual({
      token: ethers.getAddress(TOKEN),
      to: ethers.getAddress(RECIPIENT),
      amount: 1_000_000n,
      value: 0n,
    });
  });

  it("refuses calldata that is not a payment", () => {
    expect(() => decodeErc20TransferExecute("0xdeadbeef")).toThrow(UserOperationError);
  });
});

describe("decodeCreateAccountCall", () => {
  it("reads the owner and salt out of factoryData", () => {
    expect(decodeCreateAccountCall(SPONSORED_OP.factoryData)).toEqual({
      owner: ethers.getAddress(OWNER),
      salt: SALT,
    });
  });

  it("refuses factoryData that is not createAccount(address,uint256)", () => {
    expect(() => decodeCreateAccountCall("0xdeadbeef")).toThrow(UserOperationError);
    expect(() => decodeCreateAccountCall("0x")).toThrow(UserOperationError);
    expect(() => decodeCreateAccountCall(undefined)).toThrow(UserOperationError);
  });

  // Not in shared.
  it("refuses a createAccount selector over truncated arguments rather than reading zeros", () => {
    expect(() => decodeCreateAccountCall("0x5fbfb9cf" + "00".repeat(40))).toThrow(
      UserOperationError,
    );
  });

  it("refuses factoryData that is not even-length hex", () => {
    expect(() => decodeCreateAccountCall("0x5fbfb9cf0")).toThrow(UserOperationError);
  });
});

describe("verifyClaimUserOp", () => {
  const good = () => ({
    userOperation: SPONSORED_OP,
    entryPoint: ENTRYPOINT_V08_ADDRESS,
    servedUserOpHash: RIDDLER_SPONSORED_HASH,
    servedChainId: 1,
    expectedChainId: 1,
    counterfactualAddress: SENDER,
    recipientAddress: RECIPIENT,
    expectedOwner: OWNER,
    announced: announcementFor(TOKEN),
  });

  /** Re-serve an op under its own (correct) hash, as a hostile prepare would. */
  const served = (mutation: Partial<UserOperationV08>) => {
    const op = { ...SPONSORED_OP, ...mutation };
    return { ...good(), userOperation: op, servedUserOpHash: hashOf(op) };
  };

  const reasonOf = <A extends ClaimAnnouncement>(params: VerifyClaimUserOpParams<A>) => {
    const result = verifyClaimUserOp(params);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("accepts an operation that matches its hash and pays the right recipient", () => {
    const result = verifyClaimUserOp(good());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded).toEqual({
      sender: SENDER,
      token: ethers.getAddress(TOKEN),
      recipient: ethers.getAddress(RECIPIENT),
      amount: 1_000_000n,
      value: 0n,
    });
    // Echoed back so the caller can show the payout without re-deriving it.
    expect(result.announced.token).toBe(TOKEN);
    expect(result.announced.amount).toBe(1_000_000n);
  });

  // Not in shared: the announcement comes back as the caller's own object and type, so the
  // fields the verifier does not read (amount, view tag) survive for display.
  it("echoes the caller's announcement object unchanged", () => {
    const params = good();
    const result = verifyClaimUserOp(params);
    expect(result.ok && result.announced).toBe(params.announced);
  });

  it("is case-insensitive about addresses", () => {
    const upper = (a: string) => a.toUpperCase().replace("0X", "0x");
    const result = verifyClaimUserOp({
      ...good(),
      entryPoint: upper(ENTRYPOINT_V08_ADDRESS),
      counterfactualAddress: upper(SENDER),
      recipientAddress: upper(RECIPIENT),
      expectedOwner: upper(OWNER),
      // Not in shared: the announced side is folded too.
      announced: { ...announcementFor(upper(TOKEN)), factory: upper(FACTORY) },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an operation built for a different network", () => {
    expect(reasonOf({ ...good(), expectedChainId: 8453 })).toContain("different network");
  });

  it("refuses a server that renames the chain to make its own hash check out", () => {
    // The op hashed for 8453 and served as 8453 is internally consistent: the recompute
    // would agree. Only the expected-chain check catches it.
    expect(
      reasonOf({
        ...good(),
        servedChainId: 8453,
        servedUserOpHash: hashOf(SPONSORED_OP, 8453),
      }),
    ).toContain("different network");
  });

  it("refuses an operation that would pay somebody else", () => {
    const swapped = CALL_DATA.replace("e9674277e85d7e5ddf1340dce118d1b887bee727", "1".repeat(40));
    expect(reasonOf(served({ callData: swapped }))).toContain("somewhere else");
  });

  // `execute(dest, value, transfer(to, amount))` decodes the same whatever `dest` is, so
  // this op names the right recipient and moves none of the settled USDC.
  it("refuses an operation whose outer call is not the token that was received", () => {
    expect(
      reasonOf(served({ callData: executeCall(HOSTILE, 0n, RECIPIENT, 1_000_000n) })),
    ).toContain("different token");
  });

  it("refuses an operation that ships ether alongside the transfer", () => {
    expect(
      reasonOf(served({ callData: executeCall(TOKEN, 10n ** 18n, RECIPIENT, 1_000_000n) })),
    ).toContain("ether");
  });

  it("refuses when the announcement decoded to nothing", () => {
    expect(reasonOf({ ...good(), announced: null })).toContain("which token");
  });

  it("refuses when the announced token is not the one the operation calls", () => {
    expect(reasonOf({ ...good(), announced: announcementFor(HOSTILE) })).toContain(
      "different token",
    );
  });

  describe("account deployment", () => {
    it("refuses an operation that would hand the account to someone else", () => {
      expect(reasonOf(served({ factoryData: createAccountCall(HOSTILE, SALT) }))).toContain(
        "different owner",
      );
    });

    it("refuses an unexpected factory", () => {
      expect(reasonOf(served({ factory: HOSTILE }))).toContain("account factory");
    });

    // Not in shared: the announcement is the side that names the factory, so swapping it
    // has to refuse just as swapping the op does.
    it("refuses when the announced factory is not the op's", () => {
      expect(
        reasonOf({ ...good(), announced: { ...announcementFor(TOKEN), factory: HOSTILE } }),
      ).toContain("account factory");
    });

    // Not in shared: an op that deploys nothing names no owner the signing key can be
    // checked against.
    it("refuses an operation that names no factory", () => {
      expect(reasonOf(served({ factory: null, factoryData: "0x" }))).toContain("account factory");
    });

    it("refuses a salt the announcement does not name", () => {
      // Shared asserted only the refusal; the reason is pinned here.
      expect(reasonOf(served({ factoryData: createAccountCall(OWNER, SALT + 1n) }))).toContain(
        "different payment",
      );
    });

    // Not in shared: the op is right and the announcement names another salt.
    it("refuses when the announced salt is not the op's", () => {
      expect(reasonOf({ ...good(), announced: { ...announcementFor(TOKEN), salt: 0n } })).toContain(
        "different payment",
      );
    });

    it("refuses factoryData it cannot read", () => {
      expect(reasonOf(served({ factoryData: "0xdeadbeef" }))).toContain("who would own");
    });
  });

  it("refuses when the hash does not belong to the operation", () => {
    expect(reasonOf({ ...good(), servedUserOpHash: `0x${"ab".repeat(32)}` })).toContain(
      "does not match",
    );
  });

  // Not in shared: a prepare response with no hash at all is a mismatch, not a crash.
  it("refuses a served hash that is absent at runtime", () => {
    expect(reasonOf({ ...good(), servedUserOpHash: undefined as unknown as string })).toContain(
      "does not match",
    );
  });

  it("refuses when the operation would pay out of a different account", () => {
    expect(reasonOf(served({ sender: "0x2222222222222222222222222222222222222222" }))).toContain(
      "different account",
    );
  });

  it("refuses when the operation is missing entirely", () => {
    expect(reasonOf({ ...good(), userOperation: undefined })).toContain("did not send");
    expect(reasonOf({ ...good(), entryPoint: undefined })).toContain("did not send");
  });

  // Not in shared: a missing op is reported ahead of a missing announcement, so the
  // reason names the server's gap rather than the payment's.
  it("reports a missing operation before a missing announcement", () => {
    expect(reasonOf({ ...good(), userOperation: undefined, announced: null })).toContain(
      "did not send",
    );
  });

  it("refuses an unrecognised EntryPoint", () => {
    expect(
      reasonOf({ ...good(), entryPoint: "0x3333333333333333333333333333333333333333" }),
    ).toContain("EntryPoint");
  });

  it("refuses calldata it cannot read", () => {
    // Shared asserted only the refusal; the reason is pinned here.
    expect(reasonOf(served({ callData: "0xdeadbeef" }))).toContain("does not look like a payment");
  });

  // Not in shared: a field the hash cannot be recomputed over refuses with a reason
  // rather than throwing out of the verifier.
  it("refuses an operation it cannot recompute the hash over", () => {
    for (const mutation of [
      { nonce: "not a number" },
      { sender: "0x1234" },
      { callGasLimit: `0x${"f".repeat(33)}` },
      { paymasterData: "0xabc" },
    ] as Partial<UserOperationV08>[]) {
      expect(
        reasonOf({ ...good(), userOperation: { ...SPONSORED_OP, ...mutation } }),
        JSON.stringify(mutation),
      ).toContain("could not be read");
    }
  });

  // Not in shared, which accepted this op. `value` bounds what the call spends, not what
  // the op spends on gas: without a paymaster the account pays its own prefund from
  // server-chosen gas fields, so maxed fees drain its native balance while the token
  // transfer still checks out. A claim is always sponsored.
  it("refuses an unsponsored operation, whose gas the account itself would pay", () => {
    const params = served({
      paymaster: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
      paymasterData: null,
      maxFeePerGas: `0x${"f".repeat(32)}`,
    });
    expect(reasonOf(params)).toContain("not sponsored");
  });

  it("refuses when the operation's owner is not the signing key", () => {
    expect(
      reasonOf({ ...good(), expectedOwner: "0x4444444444444444444444444444444444444444" }),
    ).toContain("different owner");
  });

  it("takes no optional parameter, so no check can be skipped by omission", () => {
    // The assertion is the type annotation: `Required<T>` stops compiling the day someone
    // adds `foo?:` to VerifyClaimUserOpParams. An optional input on a fail-closed verifier
    // is a check with an off switch.
    const params: Required<VerifyClaimUserOpParams> = good();
    expect(verifyClaimUserOp(params).ok).toBe(true);
  });
});
