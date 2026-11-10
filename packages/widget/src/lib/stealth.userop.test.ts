/**
 * ERC-4337 keyless stealth claim signing, through `@xochi/signer`'s
 * `signUserOpHash` (hash first, hex key second).
 *
 * Signs a raw 32-byte userOpHash with a fixed stealth spending key and asserts:
 * - the exact signature for a fixed key and hash (RFC 6979, low-s, v = recovery + 27,
 *   computed independently with noble below)
 * - the 65-byte / 130-hex r||s||v format, v in {27, 28}
 * - address recovered from the raw hash + signature equals the address derived
 *   from the private key's public key (round-trip, EntryPoint ECDSA.recover parity)
 * No network.
 */

import { describe, it, expect } from "vitest";
import { keccak256, bytesToHex, hexToBytes, toHex, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { signUserOpHash } from "@xochi/signer";

// Fixed, well-known secp256k1 scalar (a common test private key) and a fixed hash.
const PRIV_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const USER_OP_HASH: Hex = `0x${"ab".repeat(32)}`;
const EXPECTED_SIGNATURE: Hex =
  "0x67c6ff1e6296be61f3a5d0531fc42448c1fa9cda50c25bab5ca6fcf9e04b79ab21b76dd66b2fbcaaba8efcf8cdc559b57be766d0f00360a7441f618e18e7263a1b";

/** keccak(uncompressedPubKey[1:])[-20:] -> checksummed-lowercase EVM address. */
function addressFromUncompressedPubKey(uncompressed: Uint8Array): string {
  const hash = keccak256(bytesToHex(uncompressed.slice(1)));
  return `0x${hash.slice(-40)}`.toLowerCase();
}

/** Raw-digest secp256k1 signature as EntryPoint v0.8's SimpleAccount recovers it. */
function nobleRawDigestSignature(privKey: Hex, digest: Hex): Hex {
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(privKey));
  const full = new Uint8Array(65);
  full.set(sig.toCompactRawBytes(), 0);
  full[64] = sig.recovery + 27;
  return bytesToHex(full);
}

describe("signUserOpHash", () => {
  it("produces the known signature for a fixed key and hash", () => {
    expect(signUserOpHash(USER_OP_HASH, PRIV_KEY)).toBe(EXPECTED_SIGNATURE);
  });

  it("matches a raw-digest noble signature across keys and hashes", () => {
    for (let i = 0; i < 64; i++) {
      const key = keccak256(toHex(`stealth-key-${i}`));
      const hash = keccak256(toHex(`user-op-${i}`));
      expect(signUserOpHash(hash, key)).toBe(nobleRawDigestSignature(key, hash));
    }
  });

  it("returns a 65-byte / 130-hex signature with v in {27,28}", () => {
    const sig = signUserOpHash(USER_OP_HASH, PRIV_KEY);

    expect(sig).toMatch(/^0x[a-f0-9]{130}$/);

    const v = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(v);
  });

  it("recovers the signer address from the raw hash (round-trip)", () => {
    const sig = signUserOpHash(USER_OP_HASH, PRIV_KEY);

    // Expected address = address of the private key's public key.
    const expectedAddress = addressFromUncompressedPubKey(
      secp256k1.getPublicKey(hexToBytes(PRIV_KEY), false),
    );

    // Recover from the raw hash + parsed signature (no EIP-191 prefix).
    const sigBytes = hexToBytes(sig as Hex);
    const rs = sigBytes.slice(0, 64);
    const recovery = sigBytes[64] - 27;
    const hashBytes = hexToBytes(USER_OP_HASH);

    const recoveredPoint = secp256k1.Signature.fromCompact(rs)
      .addRecoveryBit(recovery)
      .recoverPublicKey(hashBytes);
    const recoveredAddress = addressFromUncompressedPubKey(recoveredPoint.toRawBytes(false));

    expect(recoveredAddress).toBe(expectedAddress);
  });
});
