import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  importWrapKey,
  unwrapImported,
  wrapImported,
} from "../../../src/browser/keystore/index.js";
import { SealError } from "../../../src/ports.js";

/** contract A.3 `zeros-ones` wrapKey. */
const WRAP_KEY_HEX = "88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b";
/** keccak256(UTF8("TEST ONLY credential id")), contract B. */
const CREDENTIAL_ID_HASH = "0x0f51d6f267f479d4f99be0115f01345c551b48f352902e002a2ff851b20f63f2";
const PLAINTEXT = new TextEncoder().encode('{"version":1,"account":{"secret":"0x01"}}');
const DID_NOT_OPEN = /^PKW1 did not open: wrong passkey, another credential or corrupted bytes/;

const wrapKeyBytes = (): Uint8Array => Uint8Array.from(Buffer.from(WRAP_KEY_HEX, "hex"));

describe("PKW1 wrapped import", () => {
  it("round-trips under the A.3 zeros-ones wrap key", async () => {
    const wrapKey = await importWrapKey(wrapKeyBytes());
    const wrapped = await wrapImported(PLAINTEXT, wrapKey, CREDENTIAL_ID_HASH);
    expect(await unwrapImported(wrapped, wrapKey, CREDENTIAL_ID_HASH)).toEqual(PLAINTEXT);
  });

  it("imports the wrap key as non-extractable AES-256-GCM and zeroes the raw bytes", async () => {
    const raw = wrapKeyBytes();
    const wrapKey = await importWrapKey(raw);
    expect(raw).toEqual(new Uint8Array(32));
    expect(wrapKey.extractable).toBe(false);
    expect(wrapKey.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect([...wrapKey.usages].sort()).toEqual(["decrypt", "encrypt"]);
  });

  it("refuses a wrap key that is not 32 bytes, and still zeroes it", async () => {
    const raw = wrapKeyBytes().slice(0, 16);
    await expect(importWrapKey(raw)).rejects.toThrow(new SealError("wrap key must be 32 bytes"));
    expect(raw).toEqual(new Uint8Array(16));
  });

  describe("layout against node:crypto AES-256-GCM", () => {
    const MAGIC = Buffer.from("XOCHI-RCPT-PKW1\n", "ascii");
    const AAD = Buffer.concat([MAGIC, Buffer.from(CREDENTIAL_ID_HASH.slice(2), "hex")]);
    const KEY = Buffer.from(WRAP_KEY_HEX, "hex");

    it("opens MAGIC || IV || ciphertext || tag sealed by node:crypto", async () => {
      const iv = Buffer.alloc(12, 7);
      const cipher = createCipheriv("aes-256-gcm", KEY, iv).setAAD(AAD);
      const body = Buffer.concat([cipher.update(PLAINTEXT), cipher.final(), cipher.getAuthTag()]);
      const wrapped = Uint8Array.from(Buffer.concat([MAGIC, iv, body]));
      const wrapKey = await importWrapKey(wrapKeyBytes());
      expect(await unwrapImported(wrapped, wrapKey, CREDENTIAL_ID_HASH)).toEqual(PLAINTEXT);
    });

    it("wraps bytes that node:crypto opens", async () => {
      const wrapKey = await importWrapKey(wrapKeyBytes());
      const wrapped = Buffer.from(await wrapImported(PLAINTEXT, wrapKey, CREDENTIAL_ID_HASH));
      expect(wrapped.subarray(0, 16)).toEqual(MAGIC);
      const decipher = createDecipheriv("aes-256-gcm", KEY, wrapped.subarray(16, 28)).setAAD(AAD);
      decipher.setAuthTag(wrapped.subarray(-16));
      const opened = Buffer.concat([decipher.update(wrapped.subarray(28, -16)), decipher.final()]);
      expect(Uint8Array.from(opened)).toEqual(PLAINTEXT);
    });
  });

  describe("refusals", () => {
    const wrap = async (): Promise<{ wrapKey: CryptoKey; wrapped: Uint8Array }> => {
      const wrapKey = await importWrapKey(wrapKeyBytes());
      return { wrapKey, wrapped: await wrapImported(PLAINTEXT, wrapKey, CREDENTIAL_ID_HASH) };
    };

    it("refuses another credential's hash", async () => {
      const { wrapKey, wrapped } = await wrap();
      const other = `0x${"11".repeat(32)}` as const;
      const attempt = unwrapImported(wrapped, wrapKey, other);
      await expect(attempt).rejects.toBeInstanceOf(SealError);
      await expect(attempt).rejects.toThrow(DID_NOT_OPEN);
    });

    it("refuses bytes that do not start with the PKW1 magic", async () => {
      const { wrapKey, wrapped } = await wrap();
      const renamed = wrapped.slice();
      renamed.set(new TextEncoder().encode("XOCHI-RCPT-PKW2\n"));
      const attempt = unwrapImported(renamed, wrapKey, CREDENTIAL_ID_HASH);
      await expect(attempt).rejects.toBeInstanceOf(SealError);
      await expect(attempt).rejects.toThrow("not a PKW1 wrapped import");
    });

    it("refuses another wrap key", async () => {
      const { wrapped } = await wrap();
      const other = await importWrapKey(new Uint8Array(32).fill(0x42));
      await expect(unwrapImported(wrapped, other, CREDENTIAL_ID_HASH)).rejects.toThrow(
        DID_NOT_OPEN,
      );
    });

    it.each([
      ["iv", 16],
      ["ciphertext", 28],
      ["tag", -1],
    ])("refuses a flipped %s byte", async (_, at) => {
      const { wrapKey, wrapped } = await wrap();
      const tampered = wrapped.slice();
      const index = at < 0 ? tampered.length + at : at;
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      const attempt = unwrapImported(tampered, wrapKey, CREDENTIAL_ID_HASH);
      await expect(attempt).rejects.toBeInstanceOf(SealError);
      await expect(attempt).rejects.toThrow(DID_NOT_OPEN);
    });

    it.each([
      ["below the minimum", 43],
      ["by one tag byte", -1],
    ])("refuses bytes truncated %s", async (_, end) => {
      const { wrapKey, wrapped } = await wrap();
      const attempt = unwrapImported(wrapped.slice(0, end), wrapKey, CREDENTIAL_ID_HASH);
      await expect(attempt).rejects.toBeInstanceOf(SealError);
      await expect(attempt).rejects.toThrow(end < 0 ? DID_NOT_OPEN : /^not a PKW1 wrapped import$/);
    });

    it.each([
      ["short", `0x${"ab".repeat(31)}`],
      ["uppercase", `0x${"AB".repeat(32)}`],
      ["unprefixed", "ab".repeat(32)],
    ])("refuses a %s credentialIdHash on wrap and unwrap", async (_, hash) => {
      const { wrapKey, wrapped } = await wrap();
      const malformed = hash as `0x${string}`;
      for (const attempt of [
        () => wrapImported(PLAINTEXT, wrapKey, malformed),
        () => unwrapImported(wrapped, wrapKey, malformed),
      ]) {
        await expect(attempt()).rejects.toThrow(
          new SealError("credentialIdHash must be 0x followed by 64 lowercase hex digits"),
        );
      }
    });

    it("refuses a CryptoKey that is not AES-256-GCM on wrap and unwrap", async () => {
      const { wrapped } = await wrap();
      const aes128 = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      for (const attempt of [
        () => wrapImported(PLAINTEXT, aes128, CREDENTIAL_ID_HASH),
        () => unwrapImported(wrapped, aes128, CREDENTIAL_ID_HASH),
      ]) {
        await expect(attempt()).rejects.toThrow(new SealError("wrap key must be AES-256-GCM"));
      }
    });

    it("refuses an extractable wrap key on wrap and unwrap", async () => {
      const { wrapped } = await wrap();
      const extractable = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(Buffer.from(WRAP_KEY_HEX, "hex")),
        "AES-GCM",
        true,
        ["encrypt", "decrypt"],
      );
      for (const attempt of [
        () => wrapImported(PLAINTEXT, extractable, CREDENTIAL_ID_HASH),
        () => unwrapImported(wrapped, extractable, CREDENTIAL_ID_HASH),
      ]) {
        await expect(attempt()).rejects.toThrow(new SealError("wrap key must be non-extractable"));
      }
    });
  });
});
