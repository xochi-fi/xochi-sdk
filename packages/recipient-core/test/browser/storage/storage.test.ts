// IndexedDbKeyValueStore and WebLocksManager in real Chromium: tabs are pages of one persistent
// context, so they share an origin's IndexedDB and Web Locks exactly like two browser tabs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Ports from "../../../src/ports.js";
import type * as KvStoreModule from "../../../src/browser/storage/indexeddb-kv-store.js";
import type * as WebLocksModule from "../../../src/browser/storage/web-locks.js";
import { bundle, modulePage, serve, type TestServer } from "./chromium.js";

declare global {
  interface Window {
    storage: typeof KvStoreModule & typeof WebLocksModule & Pick<typeof Ports, "KeyExistsError">;
    lease?: Ports.LockLease;
    lockFreed?: Promise<void>;
  }
}

const srcDir = fileURLToPath(new URL("../../../src/browser/storage/", import.meta.url));

let server: TestServer;
let userDataDir: string;
let context: BrowserContext;

async function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, { headless: true });
}

async function openTab(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  return page;
}

beforeAll(async () => {
  const module = await bundle(
    [
      `export * from "./indexeddb-kv-store.js";`,
      `export * from "./web-locks.js";`,
      `export { KeyExistsError } from "../../ports.js";`,
    ].join("\n"),
    srcDir,
  );
  server = await serve({
    "/": modulePage("storage"),
    "/module.js": { type: "text/javascript", body: module },
  });
  userDataDir = await mkdtemp(join(tmpdir(), "recipient-core-storage-"));
  context = await launch();
});

afterAll(async () => {
  await context?.close();
  await server?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe("IndexedDbKeyValueStore", () => {
  it("returns null for a missing key and the bytes that were put", async () => {
    const page = await openTab();
    const result = await page.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-roundtrip");
      const missing = await kv.get("state.json");
      await kv.put("state.json", new Uint8Array([1, 2, 3]));
      const found = await kv.get("state.json");
      kv.close();
      return { missing, found: found && Array.from(found) };
    });
    expect(result).toEqual({ missing: null, found: [1, 2, 3] });
    await page.close();
  });

  it("keeps a put value across a browser restart", async () => {
    const writer = await openTab();
    await writer.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-durable");
      await kv.put("operations/op-1.json", new TextEncoder().encode('{"state":"broadcast"}'));
    });
    await context.close();
    context = await launch();
    const reader = await openTab();
    const value = await reader.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-durable");
      const bytes = await kv.get("operations/op-1.json");
      kv.close();
      return bytes && new TextDecoder().decode(bytes);
    });
    expect(value).toBe('{"state":"broadcast"}');
    await reader.close();
  });

  it("creates a missing key and refuses an existing one with KeyExistsError", async () => {
    const page = await openTab();
    const result = await page.evaluate(async () => {
      const { IndexedDbKeyValueStore, KeyExistsError } = window.storage;
      const kv = await IndexedDbKeyValueStore.open("kv-create");
      await kv.create("receipts/intent-1.json", new Uint8Array([1]));
      const refused = await kv.create("receipts/intent-1.json", new Uint8Array([2])).then(
        () => null,
        (error: unknown) => ({
          isKeyExists: error instanceof KeyExistsError,
          key: error instanceof KeyExistsError ? error.key : null,
        }),
      );
      const stored = await kv.get("receipts/intent-1.json");
      kv.close();
      return { refused, stored: stored && Array.from(stored) };
    });
    expect(result).toEqual({
      refused: { isKeyExists: true, key: "receipts/intent-1.json" },
      stored: [1],
    });
    await page.close();
  });

  it("lets exactly one of two tabs racing create on a key win", async () => {
    const tabs = await Promise.all([openTab(), openTab()]);
    const race = (page: Page, marker: number) =>
      page.evaluate(async (byte) => {
        const { IndexedDbKeyValueStore, KeyExistsError } = window.storage;
        const kv = await IndexedDbKeyValueStore.open("kv-race");
        try {
          await kv.create("operations/active.json", new Uint8Array([byte]));
          return "created";
        } catch (error) {
          return error instanceof KeyExistsError ? "exists" : String(error);
        } finally {
          kv.close();
        }
      }, marker);
    const outcomes = await Promise.all([race(tabs[0]!, 1), race(tabs[1]!, 2)]);
    expect([...outcomes].sort()).toEqual(["created", "exists"]);
    const stored = await tabs[0]!.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-race");
      const bytes = await kv.get("operations/active.json");
      kv.close();
      return bytes && Array.from(bytes);
    });
    expect(stored).toEqual([outcomes[0] === "created" ? 1 : 2]);
    await Promise.all(tabs.map((tab) => tab.close()));
  });

  it("lists the keys under a prefix in ascending order and nothing outside it", async () => {
    const page = await openTab();
    const listed = await page.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-list");
      const keys = [
        "receipts/b.json",
        "operations/op-2.json",
        "receipts/a.json",
        "receipts-old/z.json",
        "receiptsz/c.json",
        "receipts/nested/c.json",
        "receipts",
        "receipts/10.json",
      ];
      for (const key of keys) await kv.put(key, new Uint8Array([0]));
      const result = { receipts: await kv.list("receipts/"), none: await kv.list("exits/") };
      kv.close();
      return result;
    });
    expect(listed).toEqual({
      receipts: [
        "receipts/10.json",
        "receipts/a.json",
        "receipts/b.json",
        "receipts/nested/c.json",
      ],
      none: [],
    });
    await page.close();
  });

  it("deletes a key, frees it for create, and ignores a missing key", async () => {
    const page = await openTab();
    const result = await page.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-delete");
      await kv.put("exits/0xab.json", new Uint8Array([1]));
      await kv.delete("exits/0xab.json");
      await kv.delete("exits/0xcd.json");
      const afterDelete = { value: await kv.get("exits/0xab.json"), keys: await kv.list("exits/") };
      await kv.create("exits/0xab.json", new Uint8Array([2]));
      const recreated = await kv.get("exits/0xab.json");
      kv.close();
      return { afterDelete, recreated: recreated && Array.from(recreated) };
    });
    expect(result).toEqual({ afterDelete: { value: null, keys: [] }, recreated: [2] });
    await page.close();
  });

  it("rejects keys and prefixes outside the port's key grammar", async () => {
    const page = await openTab();
    const result = await page.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-grammar");
      const refusal = (attempt: Promise<unknown>) =>
        attempt.then(
          () => "accepted",
          (error: unknown) => (error instanceof TypeError ? "TypeError" : String(error)),
        );
      const badKeys = [
        "",
        "State.json",
        "/state.json",
        "state.json/",
        "a//b",
        ".hidden",
        "-x",
        "a".repeat(129),
        `${"a/".repeat(256)}a`,
      ];
      const keys: string[] = [];
      for (const key of badKeys) {
        keys.push(await refusal(kv.put(key, new Uint8Array([1]))));
        keys.push(await refusal(kv.create(key, new Uint8Array([1]))));
        keys.push(await refusal(kv.get(key)));
        keys.push(await refusal(kv.delete(key)));
      }
      const prefixes: string[] = [];
      for (const prefix of ["", "receipts", "/", "Receipts/", "a//"]) {
        prefixes.push(await refusal(kv.list(prefix)));
      }
      const longestKey = ["a".repeat(128), "b".repeat(127), "c".repeat(127), "d".repeat(127)];
      const accepted = await refusal(kv.put(longestKey.join("/"), new Uint8Array([1])));
      kv.close();
      return { keys, prefixes, accepted };
    });
    expect(result).toEqual({
      keys: Array<string>(9 * 4).fill("TypeError"),
      prefixes: Array<string>(5).fill("TypeError"),
      accepted: "accepted",
    });
    await page.close();
  });

  it("replaces a value with put", async () => {
    const page = await openTab();
    const value = await page.evaluate(async () => {
      const kv = await window.storage.IndexedDbKeyValueStore.open("kv-replace");
      await kv.put("state.json", new Uint8Array([1, 1, 1, 1]));
      await kv.put("state.json", new Uint8Array([2]));
      const bytes = await kv.get("state.json");
      kv.close();
      return bytes && Array.from(bytes);
    });
    expect(value).toEqual([2]);
    await page.close();
  });
});

describe("WebLocksManager", () => {
  const holder = { id: "tab", nonce: "n-1", kind: "operations" };
  const acquire = (page: Page, name: string) =>
    page.evaluate(
      async ([lockName, lockHolder]) => {
        const lease = await new window.storage.WebLocksManager().tryAcquire(lockName, lockHolder);
        window.lease = lease ?? undefined;
        return lease && { name: lease.name, holder: lease.holder };
      },
      [name, holder] as const,
    );

  it("grants a lock to one tab at a time until the lease is released", async () => {
    const [first, second] = await Promise.all([openTab(), openTab()]);
    const release = (page: Page) => page.evaluate(() => window.lease?.release());
    const name = "xochi-recipient:0xabc:operations";

    expect(await acquire(first!, name)).toEqual({ name, holder });
    expect(await acquire(second!, name)).toBeNull();
    expect(await acquire(second!, "xochi-recipient:0xdef:operations")).not.toBeNull();
    await release(first!);
    expect(await acquire(second!, name)).toEqual({ name, holder });
    expect(await acquire(first!, name)).toBeNull();
    await Promise.all([first!.close(), second!.close()]);
  });

  it("frees a lock when the holding tab closes", async () => {
    const [holderTab, waiter] = await Promise.all([openTab(), openTab()]);
    const name = "xochi-recipient:0x123:operations";
    expect(await acquire(holderTab!, name)).not.toBeNull();
    expect(await acquire(waiter!, name)).toBeNull();
    await waiter!.evaluate((lockName) => {
      window.lockFreed = navigator.locks.request(lockName, async () => undefined);
    }, name);
    await holderTab!.close();
    await waiter!.evaluate(() => window.lockFreed);
    expect(await acquire(waiter!, name)).toEqual({ name, holder });
    await waiter!.close();
  });
});
