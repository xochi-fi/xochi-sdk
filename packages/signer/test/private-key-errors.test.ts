import { describe, expect, it } from "vitest";
import {
  signClaimPrepareProof,
  signERC3009,
  signPermit2,
  signPullAuthorization,
  signUserOpHash,
  signXochiIntent,
  stealthAddressFromPrivateKey,
} from "@xochi/signer";

const SECRET = "private-key-material-that-must-not-be-logged";

async function capturedError(call: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected call to fail");
}

function expectSafeError(error: Error, expectedMessage: string): void {
  expect(error.message).toBe(expectedMessage);
  expect(error.message).not.toContain(SECRET);
  expect(error.stack).not.toContain(SECRET);
}

describe("private-key errors", () => {
  it.each([
    ["zero", "0x" + "00".repeat(32)],
    ["curve order", "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"],
  ])("rejects an out-of-range %s without exposing it", async (_case, secret) => {
    const error = await capturedError(() => stealthAddressFromPrivateKey(secret));
    expect(error.message).toBe("privHex must be a valid secp256k1 private key");
    expect(error.message).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
  });
  it.each([
    [
      "stealthAddressFromPrivateKey",
      "privHex must be a valid secp256k1 private key",
      () => stealthAddressFromPrivateKey(SECRET),
    ],
    [
      "signUserOpHash",
      "stealthPrivHex must be a valid secp256k1 private key",
      () => signUserOpHash("0x" + "00".repeat(32), SECRET),
    ],
    [
      "signClaimPrepareProof",
      "stealthPrivHex must be a valid secp256k1 private key",
      () => signClaimPrepareProof(SECRET, {} as never),
    ],
    [
      "signXochiIntent",
      "privateKeyHex must be a valid secp256k1 private key",
      () => signXochiIntent({} as never, SECRET),
    ],
    [
      "signPullAuthorization",
      "privateKeyHex must be a valid secp256k1 private key",
      () => signPullAuthorization({} as never, SECRET),
    ],
    [
      "signERC3009",
      "config.PRIVATE_KEY must be a valid secp256k1 private key",
      () => signERC3009({} as never, "ethereum", { PRIVATE_KEY: SECRET } as never),
    ],
    [
      "signPermit2",
      "config.PRIVATE_KEY must be a valid secp256k1 private key",
      () => signPermit2({} as never, "ethereum", { PRIVATE_KEY: SECRET } as never),
    ],
  ])("%s rejects without exposing the input", async (_name, expectedMessage, call) => {
    expectSafeError(await capturedError(call), expectedMessage);
  });
});
