// BrowserWalletStorage in real Chromium: the encrypted sqlite-opfs PXE and wallet stores open,
// persist and refuse a different key. The sqlite-opfs worker is bundled on its own and served at
// the URL the store resolves (`./worker.js` beside the module); the worker fetches the wasm from
// `../vendor/jswasm/sqlite3.wasm` beside itself.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as WalletStorageModule from "../../../src/browser/storage/browser-wallet-storage.js";
import { bundle, modulePage, serve, type TestServer } from "./chromium.js";

declare global {
  interface Window {
    walletStorage: typeof WalletStorageModule;
  }
}

const srcDir = fileURLToPath(new URL("../../../src/browser/storage/", import.meta.url));
const require = createRequire(import.meta.url);
const kvStoreDir = dirname(require.resolve("@aztec-labs/kv-store/sqlite-opfs"));
const sqliteWasm = require.resolve("@aztec-labs/sqlite3mc-wasm/vendor/jswasm/sqlite3.wasm");
const nodeShims = { tty: fileURLToPath(new URL("./tty-shim.ts", import.meta.url)) };

// A recipient address: 0x + 64 lowercase hex.
const SCOPE = `0x${"0a1b".repeat(16)}`;

let server: TestServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const [module, worker, wasm] = await Promise.all([
    bundle(`export * from "./browser-wallet-storage.js";`, srcDir, nodeShims),
    bundle(`import "./worker.js";`, kvStoreDir, nodeShims),
    readFile(sqliteWasm),
  ]);
  server = await serve({
    "/": modulePage("walletStorage"),
    "/module.js": { type: "text/javascript", body: module },
    "/worker.js": { type: "text/javascript", body: worker },
    "/vendor/jswasm/sqlite3.wasm": { type: "application/wasm", body: wasm },
  });
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext()).newPage();
  page.on("pageerror", (error) => console.error("[wallet-storage page]", error));
  await page.goto(`${server.origin}/`);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("BrowserWalletStorage", () => {
  it("opens one encrypted sqlite-opfs pool per store, scoped by the recipient address", async () => {
    const result = await page.evaluate(async (scope) => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const storage = new window.walletStorage.BrowserWalletStorage(async () => key.slice());
      const options = await storage.embeddedWalletOptions(scope);
      await options.pxe.store!.openMap<string, string>("smoke").set("k", "pxe-value");
      await options.walletDb.store!.openMap<string, string>("smoke").set("k", "wallet-value");
      await options.pxe.store!.close();
      await options.walletDb.store!.close();

      const pools: string[] = [];
      for await (const name of (await navigator.storage.getDirectory()).keys()) pools.push(name);

      const reopened = await storage.embeddedWalletOptions(scope);
      const values = [
        await reopened.pxe.store!.openMap<string, string>("smoke").getAsync("k"),
        await reopened.walletDb.store!.openMap<string, string>("smoke").getAsync("k"),
      ];
      await reopened.pxe.store!.close();
      await reopened.walletDb.store!.close();

      const otherKey = new window.walletStorage.BrowserWalletStorage(async () =>
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const wrongKey = await otherKey.embeddedWalletOptions(scope).then(
        () => "opened",
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      );
      return { pools: pools.sort(), values, wrongKey };
    }, SCOPE);
    expect(result).toEqual({
      pools: [
        `.aztec-kv-xochi-recipient-${SCOPE}-pxe`,
        `.aztec-kv-xochi-recipient-${SCOPE}-wallet`,
      ],
      values: ["pxe-value", "wallet-value"],
      wrongKey: "EmbeddedWalletEncryptionError",
    });
  });

  it("refuses a scope that is not a single lowercase name segment", async () => {
    const refusals = await page.evaluate(async () => {
      const storage = new window.walletStorage.BrowserWalletStorage(async () =>
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const refusals: string[] = [];
      for (const scope of ["", "0xAB", "a/b", "../x", ".x"]) {
        refusals.push(
          await storage.embeddedWalletOptions(scope).then(
            () => "opened",
            (error: unknown) => (error instanceof TypeError ? "TypeError" : String(error)),
          ),
        );
      }
      return refusals;
    });
    expect(refusals).toEqual(Array<string>(5).fill("TypeError"));
  });
});
