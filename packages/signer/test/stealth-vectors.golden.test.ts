/**
 * Forward stealth conformance vectors (TS reference -> Raxol Elixir).
 *
 * Produces the vectors the Raxol Elixir stealth implementation checks itself
 * against, computed from THIS reference (`@noble/curves` + ethers). Moved from
 * the Xochi widget unchanged in inputs and expected output.
 *
 * `test/vectors/stealth_vectors.json` is a byte copy of raxol's
 * `packages/raxol_payments/test/fixtures/stealth_vectors.json`, so the assert
 * always runs. Point STEALTH_VECTORS_PATH at a raxol checkout's fixture to check
 * it instead, and regenerate with UPDATE_GOLDENS=1 only on an intentional scheme
 * change (then commit the fixture in raxol and re-copy it here). The reverse
 * direction (Elixir -> TS, receiver discovery + spend) is
 * reverse-stealth-conformance.test.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { describe, it, expect } from "vitest";
import { deriveStealthKeys, computeStealthAddress } from "@xochi/signer";

const FIXTURE =
  process.env.STEALTH_VECTORS_PATH ??
  join(dirname(fileURLToPath(import.meta.url)), "vectors", "stealth_vectors.json");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

// Fixed inputs -- never change these values; regenerate the fixture only on an
// intentional scheme change. 65-byte (r,s,v) EVM signatures; the derivation
// hashes the hex text.
const SIGNATURES: Array<{ name: string; signature: string }> = [
  {
    name: "sig-a",
    signature:
      "0x" +
      "1c8aef3c8b9f5f3d2a1e0b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e" +
      "6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a" +
      "1b",
  },
  {
    name: "sig-b",
    signature:
      "0x" +
      "a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6" +
      "c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0" +
      "1c",
  },
  {
    // no 0x prefix on the input -- both sides slice it off the same way
    name: "sig-c-no-prefix",
    signature:
      "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" +
      "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" +
      "1b",
  },
];

// Fixed ephemeral private scalars (32 bytes, all < curve order, nonzero).
const EPHEMERALS = [
  "0x4c0883a69102937d6231471b5dbb6204fe512961708279c2f6d0f0a4a3b6c1a1",
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x7bffab5c9d3e2f10a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5",
];

function computeVectors(): unknown[] {
  const vectors: unknown[] = [];
  const derived: Array<{ spendingPubKey: string; viewingPubKey: string }> = [];

  for (const { name, signature } of SIGNATURES) {
    const k = deriveStealthKeys(signature);
    vectors.push({
      name,
      type: "derive_keys",
      signature,
      spending_priv: ethers.hexlify(k.spendingKey),
      spending_pub: k.spendingPubKey,
      viewing_priv: ethers.hexlify(k.viewingKey),
      viewing_pub: k.viewingPubKey,
    });
    derived.push({ spendingPubKey: k.spendingPubKey, viewingPubKey: k.viewingPubKey });
  }

  derived.forEach((meta, i) => {
    const ephemeral_priv = EPHEMERALS[i % EPHEMERALS.length]!;
    const s = computeStealthAddress(
      { spendingPubKey: meta.spendingPubKey, viewingPubKey: meta.viewingPubKey, chainId: 1 },
      ethers.getBytes(ephemeral_priv),
    );
    vectors.push({
      name: `generate-${SIGNATURES[i]!.name}`,
      type: "generate",
      spending_pub: meta.spendingPubKey,
      viewing_pub: meta.viewingPubKey,
      ephemeral_priv,
      expected_stealth_address: s.stealthAddress,
      expected_ephemeral_pub: s.ephemeralPubKey,
      expected_view_tag: s.viewTag,
    });
  });

  return vectors;
}

describe("forward stealth vectors (TS -> Elixir)", () => {
  if (UPDATE) {
    it("regenerates the raxol fixture (UPDATE_GOLDENS=1)", () => {
      const vectors = computeVectors();
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(vectors, null, 2)}\n`);

      console.log(`wrote ${vectors.length} vectors to ${FIXTURE}`);
      expect(vectors.length).toBeGreaterThan(0);
    });
    return;
  }

  it("reference reproduces the committed raxol fixture", () => {
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(computeVectors()).toEqual(committed);
  });
});
