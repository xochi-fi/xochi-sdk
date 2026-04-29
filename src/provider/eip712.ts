/**
 * EIP-712 typed-data digest for `CredentialRootPublication`.
 *
 * Mirrors `src/libraries/EIP712CredentialRoot.sol` byte-for-byte. A parity test
 * lives at `xochi-sdk/test/eip712-credential-root.test.ts`; if either side
 * drifts, both test suites fail.
 *
 * Domain: name="XochiZKPOracle", version="1", chainId, verifyingContract
 * (same domain as `EIP712Attestation` so wallets render a familiar prompt).
 */

import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

export const CREDENTIAL_ROOT_TYPEHASH = keccak256(
  toBytes(
    "CredentialRootPublication(uint256 providerId,bytes32 root,bytes32 cidHash,uint64 notBefore,uint64 notAfter)",
  ),
);

const DOMAIN_NAME_HASH = keccak256(toBytes("XochiZKPOracle"));
const DOMAIN_VERSION_HASH = keccak256(toBytes("1"));

export function buildDomainSeparator(chainId: bigint, verifyingContract: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, chainId, verifyingContract],
    ),
  );
}

export interface CredentialRootPublication {
  providerId: bigint;
  root: Hex;
  cidHash: Hex;
  notBefore: bigint;
  notAfter: bigint;
}

export function hashPublication(p: CredentialRootPublication): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      [CREDENTIAL_ROOT_TYPEHASH, p.providerId, p.root, p.cidHash, p.notBefore, p.notAfter],
    ),
  );
}

export function toTypedDataHash(domainSeparator: Hex, publication: CredentialRootPublication): Hex {
  const structHash = hashPublication(publication);
  const concat = ("0x1901" + domainSeparator.slice(2) + structHash.slice(2)) as Hex;
  return keccak256(concat);
}

/**
 * Build the EIP-712 digest for a credential-root publication.
 * The provider's signing key signs this value via secp256k1 ECDSA.
 */
export function credentialRootDigest(args: {
  chainId: bigint;
  oracleAddress: Hex;
  publication: CredentialRootPublication;
}): Hex {
  const domainSeparator = buildDomainSeparator(args.chainId, args.oracleAddress);
  return toTypedDataHash(domainSeparator, args.publication);
}

/**
 * Hex `keccak256(bytes(cid))` matching the Solidity `keccak256(bytes(cid))`
 * call. Pass an empty string to get the canonical hash for an empty cid.
 */
export function cidHash(cid: string): Hex {
  return keccak256(toBytes(cid));
}
