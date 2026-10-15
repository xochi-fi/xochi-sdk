import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex as viemBytesToHex, recoverAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  loadLocalSigner,
  signCredentialRoot,
  type DigestSigner,
  type PrivateKeyLoader,
  type SignCredentialRootRequest,
} from "../src/index.js";

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_KEY = new Uint8Array(32).fill(7);
const PUBLIC_KEY = secp256k1.getPublicKey(PRIVATE_KEY, false);
const REQUEST: SignCredentialRootRequest = {
  chainId: 31337n,
  oracleAddress: "0x1234567890123456789012345678901234567890",
  providerId: 42n,
  root: `0x${"ab".repeat(32)}`,
  cid: "ipfs://Qm-test",
  notBefore: 1_700_000_000n,
  notAfter: 1_700_003_600n,
};

function asyncSigner(
  sign: (digest: Uint8Array) => Uint8Array = (digest) =>
    secp256k1.sign(digest, PRIVATE_KEY, { lowS: true }).toCompactRawBytes(),
): DigestSigner {
  return {
    label: "external-async-key",
    publicKeyX: PUBLIC_KEY.slice(1, 33),
    publicKeyY: PUBLIC_KEY.slice(33, 65),
    async signDigest(digest) {
      await Promise.resolve();
      return sign(digest);
    },
  };
}

describe("DigestSigner identity boundary", () => {
  it("signs through a non-exportable asynchronous adapter and recovers its EVM address", async () => {
    const signer = asyncSigner();
    const result = await signCredentialRoot(signer, REQUEST);

    expect("privateKey" in signer).toBe(false);
    expect(
      (
        await recoverAddress({
          hash: viemBytesToHex(result.digest),
          signature: viemBytesToHex(result.signature),
        })
      ).toLowerCase(),
    ).toBe(result.signer);
  });

  it("uses one synchronous coordinate snapshot when the adapter mutates its identity", async () => {
    const x = PUBLIC_KEY.slice(1, 33);
    const y = PUBLIC_KEY.slice(33, 65);
    let xReads = 0;
    let yReads = 0;
    const signer: DigestSigner = {
      label: "mutable-adapter",
      get publicKeyX() {
        xReads += 1;
        return x;
      },
      get publicKeyY() {
        yReads += 1;
        return y;
      },
      async signDigest(digest) {
        x.fill(0);
        y.fill(0);
        await Promise.resolve();
        return secp256k1.sign(digest, PRIVATE_KEY, { lowS: true }).toCompactRawBytes();
      },
    };

    const result = await signCredentialRoot(signer, REQUEST);
    expect(xReads).toBe(1);
    expect(yReads).toBe(1);
    expect(result.signer).not.toBe("0x0000000000000000000000000000000000000000");
    expect(
      (
        await recoverAddress({
          hash: viemBytesToHex(result.digest),
          signature: viemBytesToHex(result.signature),
        })
      ).toLowerCase(),
    ).toBe(result.signer);
  });

  it("refuses a valid signature made by a different key", async () => {
    await expect(
      signCredentialRoot(
        asyncSigner((digest) =>
          secp256k1.sign(digest, OTHER_KEY, { lowS: true }).toCompactRawBytes(),
        ),
        REQUEST,
      ),
    ).rejects.toThrow(/signature for a different key/);
  });

  it.each([63, 65])("refuses a %i-byte compact signature", async (length) => {
    await expect(
      signCredentialRoot(
        asyncSigner(() => new Uint8Array(length)),
        REQUEST,
      ),
    ).rejects.toThrow(/expected 64-byte r \|\| s/);
  });

  it("refuses malformed and out-of-range compact signatures", async () => {
    const malformed = new Uint8Array(64);
    const outOfRange = new Uint8Array(64).fill(0xff);

    await expect(
      signCredentialRoot(
        asyncSigner(() => malformed),
        REQUEST,
      ),
    ).rejects.toThrow(/invalid compact signature|different key/);
    await expect(
      signCredentialRoot(
        asyncSigner(() => outOfRange),
        REQUEST,
      ),
    ).rejects.toThrow(/invalid compact signature/);
  });

  it("refuses a high-S compact signature", async () => {
    await expect(
      signCredentialRoot(
        asyncSigner((digest) => {
          const low = secp256k1.sign(digest, PRIVATE_KEY, { lowS: true });
          return new secp256k1.Signature(low.r, secp256k1.CURVE.n - low.s).toCompactRawBytes();
        }),
        REQUEST,
      ),
    ).rejects.toThrow(/high-S/);
  });

  it("validates and returns one owned copy of adapter signature bytes", async () => {
    const signer = asyncSigner((digest) => {
      const valid = secp256k1.sign(digest, PRIVATE_KEY, { lowS: true }).toCompactRawBytes();
      return new (class extends Uint8Array {
        override slice(): Uint8Array<ArrayBuffer> {
          return new Uint8Array(new ArrayBuffer(64));
        }
      })(valid);
    });

    const result = await signCredentialRoot(signer, REQUEST);
    expect(
      (
        await recoverAddress({
          hash: viemBytesToHex(result.digest),
          signature: viemBytesToHex(result.signature),
        })
      ).toLowerCase(),
    ).toBe(result.signer);
  });

  it("refuses invalid public-key coordinates before invoking the adapter", async () => {
    let called = false;
    const signer: DigestSigner = {
      label: "invalid-point",
      publicKeyX: new Uint8Array(32),
      publicKeyY: new Uint8Array(32),
      async signDigest() {
        called = true;
        return new Uint8Array(64);
      },
    };

    await expect(signCredentialRoot(signer, REQUEST)).rejects.toThrow(
      /invalid secp256k1 public key/,
    );
    expect(called).toBe(false);
  });

  it("refuses signing after a local signer is destroyed", async () => {
    const signer = await loadLocalSigner({
      label: "destroyed-local",
      async loadPrivateKey() {
        return PRIVATE_KEY.slice();
      },
    });
    signer.destroy();

    await expect(signCredentialRoot(signer, REQUEST)).rejects.toThrow(/was destroyed/);
  });

  it("takes loader ownership while retaining an independently wipeable signer copy", async () => {
    let transferred: Uint8Array | undefined;
    const loader: PrivateKeyLoader = {
      label: "owned-buffer",
      async loadPrivateKey() {
        transferred = PRIVATE_KEY.slice();
        return transferred;
      },
    };
    const signer = await loadLocalSigner(loader);
    expect(transferred).toBeDefined();
    expect(transferred?.every((byte) => byte === 0)).toBe(true);

    const first = await signCredentialRoot(signer, REQUEST);
    first.signature.fill(0);
    const second = await signCredentialRoot(signer, REQUEST);
    expect(second.signature.every((byte) => byte === 0)).toBe(false);
  });
});
