// Property-based cross-check of src/stealth.ts against Riddler's ERC-5564 + v0.8
// SimpleAccount behavior. Riddler validates derivation by round-trip (sender
// pub-path == receiver priv-path: StealthAccountTest."derived key produces the
// correct stealth address"); the sender derivation below is an independent
// oracle, generated from the same secp256k1 math but not a call into stealth.ts.
//
// Deterministic: fixed seed + bounded runs so any failure reproduces exactly.
// Override with PBT_SEED / PBT_RUNS for deeper local exploration.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import {
  deriveStealthPrivateKey,
  stealthAddressFromPrivateKey,
  signUserOpHash,
} from "@xochi/signer";

import { pbtRuns, pbtSeed, pbtTimeoutMs } from "./pbt";

const N = secp256k1.CURVE.n;
const toHex = (u8: Uint8Array) => "0x" + Buffer.from(u8).toString("hex");
const noPrefix = (h: string) => h.replace(/^0x/, "");

const CFG = { seed: pbtSeed(), numRuns: pbtRuns(200) };

// The three point-math properties below each do an ECDH plus two scalar
// multiplications per round (~13ms against ~3ms for the signing ones), enough
// at 200 rounds for a loaded runner to time the file out with nothing wrong.
//
// 60 rounds: fast-check front-loads the domain boundaries (`arbPriv` spans
// [1, n-1] inclusive), so the dropped rounds are repetition rather than
// coverage, and these properties are cross-checks against an independent
// oracle -- a break shows up in the first handful of rounds, not the 137th.
// PBT_RUNS overrides for a deeper local sweep, and can only raise it.
const HEAVY = { seed: CFG.seed, numRuns: pbtRuns(60) };

// Derived from the budget it guards: every `it` carrying this ceiling runs HEAVY.
const PBT_TIMEOUT_MS = pbtTimeoutMs(HEAVY.numRuns);

// Custom generators: the domain is constrained, so plain random bytes won't do.
// arbPriv -- a valid secp256k1 scalar in [1, n-1] (includes the boundaries).
const arbPriv = fc
  .bigInt({ min: 1n, max: N - 1n })
  .map((i) => "0x" + i.toString(16).padStart(64, "0"));
// arbHash -- a 32-byte digest from arbitrary input.
const arbHash = fc.uint8Array({ minLength: 0, maxLength: 96 }).map((u) => ethers.keccak256(u));

// Independent sender-side ERC-5564 derivation (oracle).
function senderDerive(spendingPriv: string, viewingPriv: string, ephemeralPriv: string) {
  const P = secp256k1.ProjectivePoint;
  const spendingPub = secp256k1.getPublicKey(noPrefix(spendingPriv), true);
  const viewingPub = secp256k1.getPublicKey(noPrefix(viewingPriv), true);
  const ephemeralPub = secp256k1.getPublicKey(noPrefix(ephemeralPriv), true);
  const shared = secp256k1.getSharedSecret(noPrefix(ephemeralPriv), viewingPub, true);
  const hashSs = BigInt(ethers.keccak256(shared)) % N;
  const stealthPub = P.fromHex(spendingPub).add(P.BASE.multiply(hashSs));
  return {
    ephemeralPub: toHex(ephemeralPub),
    stealthAddress: ethers.computeAddress(toHex(stealthPub.toRawBytes(false))),
  };
}

describe("stealth", () => {
  it(
    "round-trip: derived key controls sender stealth address",
    () => {
      fc.assert(
        fc.property(arbPriv, arbPriv, arbPriv, (sp, vp, ep) => {
          const sender = senderDerive(sp, vp, ep);
          const stealthPriv = deriveStealthPrivateKey(sp, vp, sender.ephemeralPub);
          return (
            stealthAddressFromPrivateKey(stealthPriv).toLowerCase() ===
            sender.stealthAddress.toLowerCase()
          );
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "derived key is a canonical scalar in [1, n-1]",
    () => {
      fc.assert(
        fc.property(arbPriv, arbPriv, arbPriv, (sp, vp, ep) => {
          const { ephemeralPub } = senderDerive(sp, vp, ep);
          const k = deriveStealthPrivateKey(sp, vp, ephemeralPub);
          if (!/^0x[0-9a-f]{64}$/.test(k)) return false;
          const v = BigInt(k);
          return v >= 1n && v < N;
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "derivation ignores hex case",
    () => {
      fc.assert(
        fc.property(arbPriv, arbPriv, arbPriv, (sp, vp, ep) => {
          const { ephemeralPub } = senderDerive(sp, vp, ep);
          const up = (h: string) => "0x" + noPrefix(h).toUpperCase();
          return (
            deriveStealthPrivateKey(sp, vp, ephemeralPub) ===
            deriveStealthPrivateKey(up(sp), up(vp), up(ephemeralPub))
          );
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "signature recovers to the signing address",
    () => {
      fc.assert(
        fc.property(arbPriv, arbHash, (priv, hash) => {
          const sig = signUserOpHash(hash, priv);
          return (
            ethers.recoverAddress(hash, sig).toLowerCase() ===
            stealthAddressFromPrivateKey(priv).toLowerCase()
          );
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "signatures are low-s and canonical 65-byte hex",
    () => {
      fc.assert(
        fc.property(arbPriv, arbHash, (priv, hash) => {
          const sig = signUserOpHash(hash, priv);
          if (!/^0x[0-9a-f]{130}$/.test(sig)) return false;
          const s = BigInt("0x" + sig.slice(66, 130));
          const v = parseInt(sig.slice(130), 16);
          return s <= N / 2n && (v === 27 || v === 28);
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "signing is deterministic",
    () => {
      fc.assert(
        fc.property(
          arbPriv,
          arbHash,
          (priv, hash) => signUserOpHash(hash, priv) === signUserOpHash(hash, priv),
        ),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it("ScopeLift viewing key round-trip (explicit example)", () => {
    const vp = "0x2f8fcb2d1e06f52695e06a792b6d59c80a81ad70fc11b03b5236eed5cff09670";
    const sp = "0x" + "11".repeat(32);
    const ep = "0x" + "22".repeat(32);
    const sender = senderDerive(sp, vp, ep);
    const k = deriveStealthPrivateKey(sp, vp, sender.ephemeralPub);
    expect(stealthAddressFromPrivateKey(k).toLowerCase()).toBe(sender.stealthAddress.toLowerCase());
  });
});
