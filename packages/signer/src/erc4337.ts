// ERC-4337 v0.8 UserOperation hashing, for the stealth-claim flow.
//
// This exists so `xochiClaim` can stop raw-signing 32 opaque bytes. A digest is
// valid over any preimage that hashes to it, so nothing about the digest alone
// tells a client whether it authorises the claim it asked for or a drain of the
// same account to somebody else. Recomputing the hash from an inspectable struct
// is what binds the two together; every other check here hangs off that one.
//
// PARITY: `computeUserOpHash` must reproduce
// `Riddler.EVM.ERC4337.UserOperation.compute_hash/2` byte-for-byte. Treat it the
// way `XOCHI_TYPES` is treated -- pinned against the server, moved only in
// lockstep with it. Drift does not fail loudly in the useful direction: it
// rejects every honest claim, which is at least safe, but it also means the
// check stops distinguishing an honest server from a hostile one.
//
// v0.8 hashes the op as EIP-712 typed data (domain `ERC4337`/`1` bound to the
// EntryPoint), which is why the resulting digest is signed raw, with no EIP-191
// wrapper -- see `signUserOpHash` in `stealth.ts`.

import { ethers } from "ethers";

/**
 * Canonical ERC-4337 v0.8 EntryPoint, the same address on every EVM chain
 * (mirrors Riddler's `Contracts.entrypoint_v08/0`, and the same reasoning as
 * `PERMIT2_ADDRESS`).
 *
 * The EntryPoint is the EIP-712 `verifyingContract` for the op, so it is part of
 * the preimage rather than metadata alongside it. A served address that is not
 * this one produces a digest the real EntryPoint will never compute, which makes
 * the resulting signature useless rather than dangerous -- but "useless" is a
 * guess about a contract nobody here has looked at, so it is refused instead.
 */
export const ENTRYPOINT_V08_ADDRESS = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";

/** `execute(address,uint256,bytes)` -- the SimpleAccount entry the claim wraps. */
export const SIMPLE_ACCOUNT_EXECUTE_SELECTOR = "0xb61d27f6";

/** `transfer(address,uint256)` -- the inner ERC-20 call the claim performs. */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

const PACKED_USEROP_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData," +
      "bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)",
  ),
);

const EIP712_DOMAIN_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

const DOMAIN_NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes("ERC4337"));
const DOMAIN_VERSION_HASH = ethers.keccak256(ethers.toUtf8Bytes("1"));

const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * A UserOperation as Riddler serves it: unpacked v0.7-style field names, hex
 * quantities, with the paymaster fields filled in by sponsorship.
 *
 * Deliberately loose, for the same reason `Eip712Signable` is: this arrives from
 * the network and every field is checked at the point it is used, rather than
 * coerced on the way in by a validator that could quietly change the preimage.
 */
export interface UserOperationV08 {
  sender?: unknown;
  nonce?: unknown;
  factory?: unknown;
  factoryData?: unknown;
  callData?: unknown;
  callGasLimit?: unknown;
  verificationGasLimit?: unknown;
  preVerificationGas?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  paymaster?: unknown;
  paymasterVerificationGasLimit?: unknown;
  paymasterPostOpGasLimit?: unknown;
  paymasterData?: unknown;
  signature?: unknown;
  [key: string]: unknown;
}

export class UserOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserOperationError";
  }
}

/** Parses a hex or decimal quantity. Rejects anything else rather than coercing it. */
function toBigInt(value: unknown, field: string): bigint {
  const reject = () =>
    new UserOperationError(
      `UserOperation.${field} is ${JSON.stringify(value)}, which is not a non-negative integer ` +
        "quantity -- the userOpHash cannot be recomputed over it, so what this signature would " +
        "authorise is unknown. Refusing to sign.",
    );

  if (typeof value === "bigint") {
    if (value < 0n) throw reject();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw reject();
    return BigInt(value);
  }
  if (typeof value === "string") {
    // Explicit, because `BigInt("")` is 0n and `BigInt(" ")` is 0n -- a missing
    // gas field would otherwise hash as zero and silently produce a digest that
    // matches nothing.
    const s = value.trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw reject();
    return BigInt(s);
  }
  throw reject();
}

/** Normalises a bytes field to hex. `null`/`undefined` are empty, per the server's `|| "0x"`. */
function toBytes(value: unknown, field: string): string {
  if (value === undefined || value === null) return "0x";
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new UserOperationError(
      `UserOperation.${field} is ${JSON.stringify(value)}, which is not an even-length 0x-prefixed ` +
        "byte string. Refusing to sign a hash recomputed over a guess.",
    );
  }
  return value;
}

/**
 * Validates an address by SHAPE, not by EIP-55 checksum.
 *
 * Deliberately not `ethers.getAddress`, which throws on a mixed-case address
 * whose checksum does not verify. Casing is not part of the ABI encoding, so a
 * checksum rule here would buy nothing and would refuse an honest claim over how
 * some server capitalised its own output -- the same reasoning behind
 * `sameAddressish` on the quote path.
 */
function toAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new UserOperationError(
      `UserOperation.${field} is ${JSON.stringify(value)}, which is not an EVM address. Refusing to sign.`,
    );
  }
  return value.toLowerCase();
}

/** One half of a packed 256-bit word. Over-wide values are refused, never truncated. */
function toUint128Word(value: bigint, field: string): string {
  if (value > MAX_UINT128) {
    throw new UserOperationError(
      `UserOperation.${field} is ${value}, which does not fit in the 128 bits ERC-4337 packs it ` +
        "into. Refusing to sign: a value this size means the served op is not the one that would " +
        "execute.",
    );
  }
  return ethers.toBeHex(value, 16);
}

/** `initCode` = factory ++ factoryData, or empty when the account is already deployed. */
function initCodeOf(op: UserOperationV08): string {
  if (op.factory === undefined || op.factory === null) return "0x";
  return ethers.concat([toAddress(op.factory, "factory"), toBytes(op.factoryData, "factoryData")]);
}

/** `paymasterAndData` = paymaster ++ pmVerificationGas(16) ++ pmPostOpGas(16) ++ paymasterData. */
function paymasterAndDataOf(op: UserOperationV08): string {
  if (op.paymaster === undefined || op.paymaster === null) return "0x";
  return ethers.concat([
    toAddress(op.paymaster, "paymaster"),
    toUint128Word(
      toBigInt(op.paymasterVerificationGasLimit, "paymasterVerificationGasLimit"),
      "paymasterVerificationGasLimit",
    ),
    toUint128Word(toBigInt(op.paymasterPostOpGasLimit, "paymasterPostOpGasLimit"), "paymasterPostOpGasLimit"),
    toBytes(op.paymasterData, "paymasterData"),
  ]);
}

/**
 * The EIP-712 struct hash for the packed UserOperation.
 *
 * Note which fields are PACKED rather than encoded whole: `accountGasLimits` is
 * verificationGasLimit ++ callGasLimit and `gasFees` is maxPriorityFeePerGas ++
 * maxFeePerGas, each 16 bytes, in that order. The priority-fee-first ordering is
 * the one place this encoding reads backwards from how the fields are usually
 * quoted, and getting it wrong yields a plausible-looking hash that matches
 * nothing.
 */
function computeStructHash(op: UserOperationV08): string {
  const accountGasLimits = ethers.concat([
    toUint128Word(toBigInt(op.verificationGasLimit, "verificationGasLimit"), "verificationGasLimit"),
    toUint128Word(toBigInt(op.callGasLimit, "callGasLimit"), "callGasLimit"),
  ]);

  const gasFees = ethers.concat([
    toUint128Word(toBigInt(op.maxPriorityFeePerGas, "maxPriorityFeePerGas"), "maxPriorityFeePerGas"),
    toUint128Word(toBigInt(op.maxFeePerGas, "maxFeePerGas"), "maxFeePerGas"),
  ]);

  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32", // typehash
        "address", // sender
        "uint256", // nonce
        "bytes32", // keccak256(initCode)
        "bytes32", // keccak256(callData)
        "bytes32", // accountGasLimits
        "uint256", // preVerificationGas
        "bytes32", // gasFees
        "bytes32", // keccak256(paymasterAndData)
      ],
      [
        PACKED_USEROP_TYPEHASH,
        toAddress(op.sender, "sender"),
        toBigInt(op.nonce, "nonce"),
        ethers.keccak256(initCodeOf(op)),
        ethers.keccak256(toBytes(op.callData, "callData")),
        accountGasLimits,
        toBigInt(op.preVerificationGas, "preVerificationGas"),
        gasFees,
        ethers.keccak256(paymasterAndDataOf(op)),
      ],
    ),
  );
}

/** The EIP-712 domain separator: `ERC4337`/`1`, bound to a chain and an EntryPoint. */
export function computeUserOpDomainSeparator(chainId: bigint | number | string, entryPoint: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        EIP712_DOMAIN_TYPEHASH,
        DOMAIN_NAME_HASH,
        DOMAIN_VERSION_HASH,
        toBigInt(chainId, "chainId"),
        toAddress(entryPoint, "entryPoint"),
      ],
    ),
  );
}

/**
 * Recomputes the v0.8 `userOpHash` a client is asked to sign.
 *
 * `keccak256(0x1901 || domainSeparator(chainId, entryPoint) || structHash(op))`,
 * matching `Riddler.EVM.ERC4337.UserOperation.compute_hash/2`. The op MUST be the
 * SPONSORED one: sponsorship rewrites the gas limits and the paymaster fields and
 * all of them are in the preimage, so hashing a pre-sponsorship op disagrees on
 * every honest claim.
 */
export function computeUserOpHash(
  op: UserOperationV08,
  entryPoint: string,
  chainId: bigint | number | string,
): string {
  return ethers.keccak256(
    ethers.concat(["0x1901", computeUserOpDomainSeparator(chainId, entryPoint), computeStructHash(op)]),
  );
}

export interface DecodedErc20TransferCall {
  /** `execute()` destination -- the ERC-20 contract the inner call runs against. */
  token: string;
  /** Native value carried by `execute()`. Zero for a token transfer. */
  value: bigint;
  /** `transfer()` recipient -- where the funds actually land. */
  to: string;
  /** `transfer()` amount, in the token's base units. */
  amount: bigint;
}

/**
 * Decodes `execute(token, 0, transfer(to, amount))` -- the only callData shape a
 * stealth claim has.
 *
 * Fails closed on anything else. Riddler's claim path builds exactly this
 * (`UserOperation.build_erc20_transfer/1` wrapping `build_erc20_transfer_data/2`),
 * so a callData that decodes to something else is not a newer server, it is a
 * different instruction to the account holding the settled funds. If the claim
 * path genuinely gains a second shape, this needs a client release in lockstep,
 * same as the pinned EIP-712 schemas.
 *
 * Trailing bytes past the encoded arguments are tolerated, because on-chain
 * `abi.decode` tolerates them too -- refusing here would reject ops that execute
 * fine, while accepting them changes nothing about what the account does.
 */
export function decodeErc20TransferExecute(callData: unknown): DecodedErc20TransferCall {
  const data = toBytes(callData, "callData");
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const refuse = (why: string): never => {
    throw new UserOperationError(
      `UserOperation.callData ${why} -- a stealth claim is always ` +
        "execute(token, 0, transfer(recipient, amount)), so this op does something else with the " +
        "account holding your settled funds. Refusing to sign.",
    );
  };

  if (!data.toLowerCase().startsWith(SIMPLE_ACCOUNT_EXECUTE_SELECTOR)) {
    return refuse(`does not call execute(address,uint256,bytes) (selector ${data.slice(0, 10)})`);
  }

  let dest: string;
  let value: bigint;
  let inner: string;
  try {
    const [d, v, i] = coder.decode(["address", "uint256", "bytes"], "0x" + data.slice(10));
    dest = String(d);
    value = BigInt(v);
    inner = String(i);
  } catch {
    return refuse("does not decode as execute(address,uint256,bytes)");
  }

  if (!inner.toLowerCase().startsWith(ERC20_TRANSFER_SELECTOR)) {
    // `"0x".slice(0, 10)` is `"0x"`, which is truthy -- an `|| "an empty call"`
    // fallback never fires and the message reads as a selector that isn't there.
    return refuse(
      inner === "0x"
        ? "wraps an empty call, not transfer(address,uint256)"
        : `wraps ${inner.slice(0, 10)}, not transfer(address,uint256)`,
    );
  }

  let to: string;
  let amount: bigint;
  try {
    const [t, a] = coder.decode(["address", "uint256"], "0x" + inner.slice(10));
    to = String(t);
    amount = BigInt(a);
  } catch {
    return refuse("wraps a call that does not decode as transfer(address,uint256)");
  }

  return { token: dest, value, to, amount };
}
