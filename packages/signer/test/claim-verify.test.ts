// `verifyClaimUserOp`: the fail-closed claim check that binds the served op to the
// announcement and to the signing key. Ported from `@xochi-fi/shared` 0.2.1 (xochi#472),
// whose verifier runs `@xochi/client`'s `checkPreparedClaim` (this package's
// `assertPreparedClaimMatchesRequest` with `requireVerified`) and returns its message as the
// reason. The widget shows that reason verbatim, so every refusal below is pinned by EXACT
// text, and the multi-defect cases pin which refusal wins. Every case here was also run
// through the published shared 0.2.1 and returned the identical result.
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

  /** Re-serve a mutated op under its own (correct) hash, as a hostile prepare would. */
  const served = (mutation: Partial<UserOperationV08>) => {
    const op = { ...SPONSORED_OP, ...mutation };
    return { ...good(), userOperation: op, servedUserOpHash: hashOf(op) };
  };

  const reasonOf = <A extends ClaimAnnouncement>(params: VerifyClaimUserOpParams<A>) => {
    const result = verifyClaimUserOp(params);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  const BAD_ENTRYPOINT = "0x3333333333333333333333333333333333333333";
  const BAD_HASH = `0x${"ab".repeat(32)}`;
  const OTHER_SENDER = "0x2222222222222222222222222222222222222222";
  const OTHER_KEY = "0x4444444444444444444444444444444444444444";
  const SWAPPED_RECIPIENT = CALL_DATA.replace(RECIPIENT.slice(2), "1".repeat(40));
  const MAX_FEE = `0x${"f".repeat(32)}`;
  const UNSPONSORED: Partial<UserOperationV08> = {
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    maxFeePerGas: MAX_FEE,
  };

  // The verifier's own refusals, in shared's words.
  const NO_OP = "The server did not send the operation to check, so it cannot be verified.";
  const NO_ANNOUNCEMENT =
    "This payment's announcement does not say which token it is in, so the operation cannot be checked.";
  const WRONG_NETWORK = "The operation was built for a different network.";
  const BAD_FACTORY = "The operation names an unexpected account factory.";
  const NO_OWNER = "The operation does not say who would own the account, so it was not signed.";
  const OTHER_OWNER = "The operation would hand the account to a different owner.";
  const OTHER_SALT = "The operation is for a different payment.";

  // `assertPreparedClaimMatchesRequest`'s refusals, which shared passes through as the reason.
  const BAD_ENTRYPOINT_REASON =
    `claim/prepare names EntryPoint "${BAD_ENTRYPOINT}", but ERC-4337 v0.8 is ` +
    `${ENTRYPOINT_V08_ADDRESS} on every EVM chain -- recomputing the hash against the served ` +
    "address would just agree with whatever was sent. Refusing to sign.";
  const hashMismatchReason = (servedHash: string, recomputed: string) =>
    `claim/prepare asks for a signature over ${servedHash}, but the UserOperation it served ` +
    `hashes to ${recomputed} -- the digest is not this op's. Whatever it IS the hash of is not ` +
    "something this client can see. Refusing to sign.";
  const BAD_NONCE_REASON =
    'UserOperation.nonce is "not a number", which is not a non-negative integer quantity -- ' +
    "the userOpHash cannot be recomputed over it, so what this signature would authorise is " +
    "unknown. Refusing to sign.";
  const OTHER_SENDER_REASON =
    `the UserOperation spends from "${OTHER_SENDER}" but this intent settled to ${SENDER} -- ` +
    "refusing to sign an operation against a different account.";
  const OTHER_RECIPIENT_REASON =
    `the UserOperation transfers to ${HOSTILE} but ${RECIPIENT} was requested -- this is the ` +
    "field that decides where the settled funds land. Refusing to sign.";
  const etherReason = (wei: bigint) =>
    `the UserOperation also sends ${wei} wei of the account's native balance alongside the ` +
    "token transfer -- a stealth claim carries no value. Refusing to sign.";
  const UNSPONSORED_REASON =
    "the UserOperation names no paymaster, so the counterfactual account would pay its own gas " +
    `at maxFeePerGas="${MAX_FEE}" -- a stealth claim is always sponsored, and an unsponsored one ` +
    "can drain the account's native balance as gas regardless of the token transfer being " +
    "correct. Refusing to sign.";
  const HOSTILE_TOKEN_REASON = `the UserOperation sweeps token ${HOSTILE} but ${TOKEN} was expected -- refusing to sign.`;

  type Case = [name: string, params: () => VerifyClaimUserOpParams, reason: string];

  it("accepts Riddler's sponsored vector under its pinned hash", () => {
    const result = verifyClaimUserOp(good());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decoded).toEqual({ token: ethers.getAddress(TOKEN), amount: 1_000_000n });
    // Echoed back so the caller can show the payout without re-deriving it.
    expect(result.announced.token).toBe(TOKEN);
    expect(result.announced.amount).toBe(1_000_000n);
  });

  // Not in shared's tests: the announcement comes back as the caller's own object and type,
  // so the fields the verifier does not read (amount, view tag) survive for display.
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
      // Not in shared's tests: the announced side is folded too.
      announced: { ...announcementFor(upper(TOKEN)), factory: upper(FACTORY) },
    });
    expect(result.ok).toBe(true);
  });

  describe("refuses, with shared's exact reason", () => {
    const cases: Case[] = [
      ["no operation", () => ({ ...good(), userOperation: undefined }), NO_OP],
      ["no EntryPoint", () => ({ ...good(), entryPoint: undefined }), NO_OP],
      [
        "an announcement that decoded to nothing",
        () => ({ ...good(), announced: null }),
        NO_ANNOUNCEMENT,
      ],
      [
        "an op built for a different network",
        () => ({ ...good(), expectedChainId: 8453 }),
        WRONG_NETWORK,
      ],
      // The op hashed for 8453 and served as 8453 is internally consistent: only the
      // expected-chain check catches it.
      [
        "a server that renames the chain to make its own hash check out",
        () => ({ ...good(), servedChainId: 8453, servedUserOpHash: hashOf(SPONSORED_OP, 8453) }),
        WRONG_NETWORK,
      ],
      [
        "an unrecognised EntryPoint",
        () => ({ ...good(), entryPoint: BAD_ENTRYPOINT }),
        BAD_ENTRYPOINT_REASON,
      ],
      [
        "a hash that is not the op's",
        () => ({ ...good(), servedUserOpHash: BAD_HASH }),
        hashMismatchReason(BAD_HASH, RIDDLER_SPONSORED_HASH),
      ],
      // Not in shared's tests: a prepare response with no hash is a mismatch, not a crash.
      [
        "a served hash that is absent at runtime",
        () => ({ ...good(), servedUserOpHash: undefined as unknown as string }),
        hashMismatchReason("undefined", RIDDLER_SPONSORED_HASH),
      ],
      // Not in shared's tests: fields the hash cannot be recomputed over.
      [
        "a nonce that is not a quantity",
        () => ({ ...good(), userOperation: { ...SPONSORED_OP, nonce: "not a number" } }),
        BAD_NONCE_REASON,
      ],
      [
        "a sender that is not an address",
        () => ({ ...good(), userOperation: { ...SPONSORED_OP, sender: "0x1234" } }),
        'UserOperation.sender is "0x1234", which is not an EVM address. Refusing to sign.',
      ],
      [
        "a gas limit wider than 128 bits",
        () => ({
          ...good(),
          userOperation: { ...SPONSORED_OP, callGasLimit: `0x${"f".repeat(33)}` },
        }),
        "UserOperation.callGasLimit is 5444517870735015415413993718908291383295, which does not " +
          "fit in the 128 bits ERC-4337 packs it into. Refusing to sign: a value this size means " +
          "the served op is not the one that would execute.",
      ],
      [
        "odd-length paymasterData",
        () => ({ ...good(), userOperation: { ...SPONSORED_OP, paymasterData: "0xabc" } }),
        'UserOperation.paymasterData is "0xabc", which is not an even-length 0x-prefixed byte ' +
          "string. Refusing to sign a hash recomputed over a guess.",
      ],
      [
        "an op paying out of a different account",
        () => served({ sender: OTHER_SENDER }),
        OTHER_SENDER_REASON,
      ],
      [
        "calldata that is not a payment",
        () => served({ callData: "0xdeadbeef" }),
        "UserOperation.callData does not call execute(address,uint256,bytes) (selector " +
          "0xdeadbeef) -- a stealth claim is always execute(token, 0, transfer(recipient, " +
          "amount)), so this op does something else with the account holding your settled " +
          "funds. Refusing to sign.",
      ],
      [
        "an op that would pay somebody else",
        () => served({ callData: SWAPPED_RECIPIENT }),
        OTHER_RECIPIENT_REASON,
      ],
      [
        "an op that ships ether alongside the transfer",
        () => served({ callData: executeCall(TOKEN, 10n ** 18n, RECIPIENT, 1_000_000n) }),
        etherReason(10n ** 18n),
      ],
      // Shared refuses this through `checkPreparedClaim`'s paymaster check: with no paymaster
      // the account pays its own gas at server-chosen fees.
      ["an unsponsored op", () => served(UNSPONSORED), UNSPONSORED_REASON],
      // `execute(dest, value, transfer(to, amount))` decodes the same whatever `dest` is, so
      // this op names the right recipient and moves none of the settled USDC.
      [
        "an outer call that is not the token received",
        () => served({ callData: executeCall(HOSTILE, 0n, RECIPIENT, 1_000_000n) }),
        HOSTILE_TOKEN_REASON,
      ],
      [
        "an announced token that is not the one the op calls",
        () => ({ ...good(), announced: announcementFor(HOSTILE) }),
        `the UserOperation sweeps token ${ethers.getAddress(TOKEN)} but ${HOSTILE} was expected ` +
          "-- refusing to sign.",
      ],
      ["an unexpected factory", () => served({ factory: HOSTILE }), BAD_FACTORY],
      [
        "an op that deploys no account",
        () => served({ factory: null, factoryData: null }),
        BAD_FACTORY,
      ],
      // Not in shared's tests: the announced side of the factory swapped.
      [
        "an announced factory that is not the op's",
        () => ({ ...good(), announced: { ...announcementFor(TOKEN), factory: HOSTILE } }),
        BAD_FACTORY,
      ],
      ["factoryData it cannot read", () => served({ factoryData: "0xdeadbeef" }), NO_OWNER],
      [
        "an op that would hand the account to someone else",
        () => served({ factoryData: createAccountCall(HOSTILE, SALT) }),
        OTHER_OWNER,
      ],
      [
        "an owner that is not the signing key",
        () => ({ ...good(), expectedOwner: OTHER_KEY }),
        OTHER_OWNER,
      ],
      [
        "a salt the announcement does not name",
        () => served({ factoryData: createAccountCall(OWNER, SALT + 1n) }),
        OTHER_SALT,
      ],
      // Not in shared's tests: the announced side of the salt swapped.
      [
        "an announced salt that is not the op's",
        () => ({ ...good(), announced: { ...announcementFor(TOKEN), salt: 0n } }),
        OTHER_SALT,
      ],
    ];

    for (const [name, params, reason] of cases) {
      it(name, () => {
        expect(reasonOf(params())).toBe(reason);
      });
    }
  });

  // Not in shared's tests. With more than one defect the reason names the first check in
  // shared's order: op present, announcement present, chain, then the signer's EntryPoint,
  // hash, sender, recipient, value, paymaster, token, then factory, owner, salt.
  describe("precedence: with two defects, the earlier check's reason wins", () => {
    const cases: Case[] = [
      [
        "no op over no announcement",
        () => ({ ...good(), userOperation: undefined, announced: null }),
        NO_OP,
      ],
      [
        "no announcement over a wrong network",
        () => ({ ...good(), announced: null, expectedChainId: 8453 }),
        NO_ANNOUNCEMENT,
      ],
      [
        "a wrong network over an unrecognised EntryPoint",
        () => ({ ...good(), expectedChainId: 8453, entryPoint: BAD_ENTRYPOINT }),
        WRONG_NETWORK,
      ],
      [
        "a wrong network over a hash mismatch",
        () => ({ ...good(), expectedChainId: 8453, servedUserOpHash: BAD_HASH }),
        WRONG_NETWORK,
      ],
      [
        "an unrecognised EntryPoint over a hash mismatch",
        () => ({ ...good(), entryPoint: BAD_ENTRYPOINT, servedUserOpHash: BAD_HASH }),
        BAD_ENTRYPOINT_REASON,
      ],
      [
        "an unreadable op field over a hash mismatch",
        () => ({
          ...good(),
          userOperation: { ...SPONSORED_OP, nonce: "not a number" },
          servedUserOpHash: BAD_HASH,
        }),
        BAD_NONCE_REASON,
      ],
      [
        "a hash mismatch over a swapped recipient",
        () => ({ ...good(), userOperation: { ...SPONSORED_OP, callData: SWAPPED_RECIPIENT } }),
        hashMismatchReason(
          RIDDLER_SPONSORED_HASH,
          hashOf({ ...SPONSORED_OP, callData: SWAPPED_RECIPIENT }),
        ),
      ],
      [
        "a different sender over a swapped recipient",
        () => served({ sender: OTHER_SENDER, callData: SWAPPED_RECIPIENT }),
        OTHER_SENDER_REASON,
      ],
      [
        "a swapped recipient over a hostile token",
        () => served({ callData: executeCall(HOSTILE, 0n, HOSTILE, 1_000_000n) }),
        OTHER_RECIPIENT_REASON,
      ],
      [
        "native value over a hostile token",
        () => served({ callData: executeCall(HOSTILE, 1n, RECIPIENT, 1_000_000n) }),
        etherReason(1n),
      ],
      [
        "native value over a missing paymaster",
        () => served({ ...UNSPONSORED, callData: executeCall(TOKEN, 1n, RECIPIENT, 1_000_000n) }),
        etherReason(1n),
      ],
      [
        "a missing paymaster over a hostile token",
        () => served({ ...UNSPONSORED, callData: executeCall(HOSTILE, 0n, RECIPIENT, 1_000_000n) }),
        UNSPONSORED_REASON,
      ],
      [
        "a hostile token over an owner that is not the signing key",
        () => ({
          ...served({ callData: executeCall(HOSTILE, 0n, RECIPIENT, 1_000_000n) }),
          expectedOwner: OTHER_KEY,
        }),
        HOSTILE_TOKEN_REASON,
      ],
      [
        "a swapped recipient over an unexpected factory",
        () => served({ callData: SWAPPED_RECIPIENT, factory: HOSTILE }),
        OTHER_RECIPIENT_REASON,
      ],
      [
        "an unexpected factory over a different owner",
        () => served({ factory: HOSTILE, factoryData: createAccountCall(HOSTILE, SALT) }),
        BAD_FACTORY,
      ],
      [
        "a different owner over a different salt",
        () => served({ factoryData: createAccountCall(HOSTILE, SALT + 1n) }),
        OTHER_OWNER,
      ],
    ];

    for (const [name, params, reason] of cases) {
      it(name, () => {
        expect(reasonOf(params())).toBe(reason);
      });
    }
  });

  it("takes no optional parameter, so no check can be skipped by omission", () => {
    // The assertion is the type annotation: `Required<T>` stops compiling the day someone
    // adds `foo?:` to VerifyClaimUserOpParams. An optional input on a fail-closed verifier
    // is a check with an off switch.
    const params: Required<VerifyClaimUserOpParams> = good();
    expect(verifyClaimUserOp(params).ok).toBe(true);
  });
});
