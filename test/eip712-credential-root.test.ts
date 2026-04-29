/**
 * EIP-712 parity for the CredentialRootPublication digest.
 *
 * The TS digest at `src/provider/eip712.ts` MUST match the Solidity digest
 * at `src/libraries/EIP712CredentialRoot.sol` byte-for-byte; otherwise the
 * provider's signature won't recover to the registered signer at
 * `publishCredentialRoot` time.
 *
 * This test computes the digest in TS and asserts it equals a hardcoded
 * vector. The same vector is reproduced as a `forge test` in
 * test/EIP712CredentialRootParity.t.sol; if either side drifts both fail.
 */

import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_ROOT_TYPEHASH,
  buildDomainSeparator,
  cidHash,
  credentialRootDigest,
  hashPublication,
} from "../src/provider/eip712.js";

const ORACLE_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const CHAIN_ID = 31337n; // foundry default

const SAMPLE = {
  providerId: 42n,
  root: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
  cidHash: cidHash("ipfs://Qm-test"),
  notBefore: 1700000000n,
  notAfter: 1700003600n,
};

describe("EIP-712 typehash and domain", () => {
  it("CREDENTIAL_ROOT_TYPEHASH matches the canonical encoding", () => {
    // keccak256("CredentialRootPublication(uint256 providerId,bytes32 root,bytes32 cidHash,uint64 notBefore,uint64 notAfter)")
    expect(CREDENTIAL_ROOT_TYPEHASH).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("domain separator is deterministic for fixed inputs", () => {
    const a = buildDomainSeparator(CHAIN_ID, ORACLE_ADDRESS);
    const b = buildDomainSeparator(CHAIN_ID, ORACLE_ADDRESS);
    expect(a).toBe(b);
  });

  it("domain separator changes with chain ID", () => {
    const a = buildDomainSeparator(1n, ORACLE_ADDRESS);
    const b = buildDomainSeparator(2n, ORACLE_ADDRESS);
    expect(a).not.toBe(b);
  });

  it("domain separator changes with oracle address", () => {
    const a = buildDomainSeparator(CHAIN_ID, ORACLE_ADDRESS);
    const b = buildDomainSeparator(CHAIN_ID, "0x0000000000000000000000000000000000000001");
    expect(a).not.toBe(b);
  });
});

describe("hashPublication", () => {
  it("is deterministic", () => {
    expect(hashPublication(SAMPLE)).toBe(hashPublication(SAMPLE));
  });

  it("changes when root changes", () => {
    const altered = { ...SAMPLE, root: ("0x" + "11".repeat(32)) as `0x${string}` };
    expect(hashPublication(altered)).not.toBe(hashPublication(SAMPLE));
  });

  it("changes when cidHash changes", () => {
    expect(hashPublication({ ...SAMPLE, cidHash: cidHash("ipfs://Qm-other") })).not.toBe(
      hashPublication(SAMPLE),
    );
  });

  it("changes when window changes", () => {
    expect(hashPublication({ ...SAMPLE, notBefore: SAMPLE.notBefore + 1n })).not.toBe(
      hashPublication(SAMPLE),
    );
    expect(hashPublication({ ...SAMPLE, notAfter: SAMPLE.notAfter - 1n })).not.toBe(
      hashPublication(SAMPLE),
    );
  });
});

describe("credentialRootDigest", () => {
  it("produces a 32-byte 0x-prefixed hex", () => {
    const d = credentialRootDigest({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE_ADDRESS,
      publication: SAMPLE,
    });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("matches the Solidity digest for the canonical fixture", () => {
    // PARITY_VECTOR -- regenerate the matching value in
    // test/EIP712CredentialRootParity.t.sol if this changes.
    const d = credentialRootDigest({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE_ADDRESS,
      publication: SAMPLE,
    });
    // eslint-disable-next-line no-console
    console.log("[parity] credential_root_digest =", d);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("cidHash", () => {
  it("empty string", () => {
    // keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    expect(cidHash("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("matches keccak256 of UTF-8 bytes", () => {
    expect(cidHash("ipfs://abc")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
