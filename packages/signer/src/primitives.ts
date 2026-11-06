// ABI, EIP-712 and address primitives shared by the hash modules. INTERNAL: the index
// re-exports only `EIP712_DOMAIN_TYPEHASH`, through `xsp.ts`.

import { ethers } from "ethers";
import type { Hex } from "./types";

export const coder = ethers.AbiCoder.defaultAbiCoder();
export const keccak = (data: ethers.BytesLike): Hex => ethers.keccak256(data) as Hex;

/** EIP-712 domain typehash for `{ name, version, chainId, verifyingContract }`. */
export const EIP712_DOMAIN_TYPEHASH = ethers.id(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
) as Hex;

/** EIP-712 digest: `keccak256(0x1901 || domainSeparator || structHash)`. */
export function typedDigest(separator: string, structHash: string): Hex {
  return keccak(ethers.concat(["0x1901", separator, structHash]));
}

/** A 20-byte EVM address, `0x` + 40 hex, any case. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
