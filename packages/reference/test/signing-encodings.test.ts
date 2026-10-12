/**
 * Input-handling and layout properties of the two on-chain-verified signers.
 *
 * `conformance.test.ts` pins the happy path byte-for-byte against the frozen
 * fixture. It cannot see the cases below, because every vector in that fixture
 * carries a well-formed 32-byte nonce and a normal token address -- the inputs
 * these guard are exactly the ones no vector contains.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";

import { CONFIG } from "../src/config";
import { signERC3009, signPermit2, type Quote } from "@xochi/signer";
import type { SignerConfig } from "@xochi/signer";

const TEST_CONFIG: SignerConfig = {
  ...CONFIG,
  PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

const FULL_NONCE = "0x" + "ab".repeat(32);

function erc3009Quote(nonce: string | Uint8Array): Quote {
  return {
    request: { inputAmount: "1000000" },
    quoteExpires: 1_900_000_000,
    gasless: { to: "0x1111111111111111111111111111111111111111", nonce },
  };
}

function permit2Quote(overrides: Partial<Quote["gasless"]> = {}): Quote {
  return {
    request: { inputAmount: "1000000" },
    quoteExpires: 1_900_000_000,
    gasless: {
      to: "0x1111111111111111111111111111111111111111",
      nonce: "123456789",
      orderId: "0x" + "cd".repeat(32),
      ...overrides,
    },
  };
}

describe("ERC-3009 nonce normalization", () => {
  // `padStart(64, "0").slice(0, 64)` leaves the padStart a no-op on an over-length
  // nonce and lets the slice discard the tail: the client then signs an
  // authorization for a nonce the server never issued, surfacing much later as an
  // unexplained rejected pull, with no signal at signing time.
  it("refuses an over-length nonce rather than truncating it", async () => {
    const tooLong = "0x" + "ab".repeat(40); // 40 bytes, does not fit bytes32

    await expect(signERC3009(erc3009Quote(tooLong), "base", TEST_CONFIG)).rejects.toThrow(
      /does not fit bytes32/,
    );
  });

  it("left-pads a short nonce -- the reference normalization is deliberate", async () => {
    // The server mirrors this, so removing it would break any quote carrying a
    // short nonce. Asserted rather than assumed: it is the reason this function
    // is more permissive than the Python/Go/Rust conformance runners.
    const short = await signERC3009(erc3009Quote("0x1234"), "base", TEST_CONFIG);
    const padded = await signERC3009(
      erc3009Quote("0x" + "1234".padStart(64, "0")),
      "base",
      TEST_CONFIG,
    );

    expect(short.signature).toBe(padded.signature);
    expect(short.signedObject).toBe(padded.signedObject);
  });

  it("rejects a non-hex nonce instead of encoding garbage", async () => {
    await expect(signERC3009(erc3009Quote("0xzzzz"), "base", TEST_CONFIG)).rejects.toThrow(
      /not valid hex/,
    );
  });

  it("is case-insensitive on the nonce", async () => {
    const lower = await signERC3009(erc3009Quote(FULL_NONCE), "base", TEST_CONFIG);
    const upper = await signERC3009(erc3009Quote("0x" + "AB".repeat(32)), "base", TEST_CONFIG);

    expect(lower.signature).toBe(upper.signature);
  });

  // Both accepted spellings of the same nonce must get the same rules: an
  // over-length array is refused with the size rather than ethers' generic
  // "invalid length for bytes32", and a short one is padded like the hex string.
  describe("applies the same rules to a byte-array nonce", () => {
    it("refuses an over-length array with the size, not an ethers error", async () => {
      await expect(
        signERC3009(erc3009Quote(new Uint8Array(33).fill(0xab)), "base", TEST_CONFIG),
      ).rejects.toThrow(/33 bytes.*does not fit bytes32/s);
    });

    it("left-pads a short array exactly as it left-pads the hex string", async () => {
      const fromBytes = await signERC3009(
        erc3009Quote(new Uint8Array([0x12, 0x34])),
        "base",
        TEST_CONFIG,
      );
      const fromHex = await signERC3009(erc3009Quote("0x1234"), "base", TEST_CONFIG);

      expect(fromBytes.signature).toBe(fromHex.signature);
      expect(fromBytes.signedObject).toBe(fromHex.signedObject);
    });

    it("agrees with the hex string on a full-width nonce", async () => {
      const fromBytes = await signERC3009(
        erc3009Quote(new Uint8Array(32).fill(0xab)),
        "base",
        TEST_CONFIG,
      );
      const fromHex = await signERC3009(erc3009Quote("0x" + "ab".repeat(32)), "base", TEST_CONFIG);

      expect(fromBytes.signature).toBe(fromHex.signature);
    });
  });
});

describe("Permit2 signedObject layout", () => {
  // The struct is five static words with no offset pointer. A heuristic that reads
  // word 0 -- `permitted.token` -- as a candidate offset strips the encoding when
  // the address falls in [32, 1000); `0x...064` is 100, inside that window.
  it("does not corrupt the encoding for a low-numbered token address", async () => {
    const lowToken = "0x0000000000000000000000000000000000000064";
    const result = await signPermit2(permit2Quote(), "base", TEST_CONFIG, lowToken);

    expect(result.signedObject).toMatch(/^0x[0-9a-f]{320}$/);
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "address", "uint256", "uint256"],
      result.signedObject!,
    );
    expect(decoded[0]).toBe(ethers.getAddress(lowToken));
    expect(decoded[1]).toBe(1000000n);
  });

  it("rejects a malformed orderId", async () => {
    await expect(
      signPermit2(permit2Quote({ orderId: "0xdeadbeef" }), "base", TEST_CONFIG),
    ).rejects.toThrow(/orderId must be 32 bytes/);
  });
});
