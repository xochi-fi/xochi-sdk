import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NodeKeyValueStore } from "../src/node/kv.js";
import { NodePidLockManager } from "../src/node/locks.js";

import { SealedKeystoreKeySource } from "../src/node/data-dir.js";
import { NodeKeystoreCrypto } from "../src/node/sealed.js";

describe("CLI key source", () => {
  it("is the sealed keystore kind (never the passkey backup mode)", () => {
    const source = new SealedKeystoreKeySource(
      "/nonexistent/keystore.sealed",
      async () => "unused passphrase",
      new NodeKeystoreCrypto(),
    );
    expect(source.kind).toBe("keystore");
  });
});

describe("Node key-value store grammar", () => {
  it("accepts segments starting with an underscore and leaves only dot-prefixed temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "xochi-kv-"));
    const kv = new NodeKeyValueStore(root);
    await kv.put("receipts/_intent.json", new Uint8Array([1]));
    await kv.put("receipts/_intent.json", new Uint8Array([2]));
    expect(await kv.list("receipts/")).toEqual(["receipts/_intent.json"]);
    expect(readdirSync(join(root, "receipts")).filter((name) => !name.startsWith("."))).toEqual([
      "_intent.json",
    ]);
    expect(() => kv.pathOf("receipts/../state.json")).toThrow(/invalid storage key/);
    expect(() => kv.pathOf("receipts/Upper.json")).toThrow(/invalid storage key/);
  });

  it("refuses to list a directory holding a foreign entry, but skips dot temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "xochi-kv-"));
    const kv = new NodeKeyValueStore(root);
    mkdirSync(join(root, "operations"));
    writeFileSync(join(root, "operations", ".active.lock.x.tmp"), "");
    expect(await kv.list("operations/")).toEqual([]);
    writeFileSync(join(root, "operations", "Foreign.json"), "");
    await expect(kv.list("operations/")).rejects.toThrow(/Foreign\.json/);
  });
});

describe("Node pid lock manager", () => {
  it("answers live for this process and recoverable for a dead pid", async () => {
    const locks = new NodePidLockManager();
    const holder = { id: "1", nonce: "n", kind: "probe" };
    expect(await locks.tryAcquire(`x:holder:${process.pid}`, holder)).toBeNull();
    expect(await locks.tryAcquire("x:holder:2147483647", holder)).not.toBeNull();
    await expect(locks.tryAcquire("x:other", holder)).rejects.toThrow(/holder locks/);
  });
});
