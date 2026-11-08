// BrowserWalletStorage in real Chromium: the encrypted sqlite-opfs PXE store persists per
// recipient and network, refuses a different key, and the wallet DB stays in memory. The
// sqlite-opfs worker is bundled on its own and served at the URL the store resolves
// (`./worker.js` beside the module); the worker fetches the wasm from
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
    walletStorage: typeof WalletStorageModule & { PXE_DATA_SCHEMA_VERSION: number };
  }
}

const srcDir = fileURLToPath(new URL("../../../src/browser/storage/", import.meta.url));
const require = createRequire(import.meta.url);
const kvStoreDir = dirname(require.resolve("@aztec-labs/kv-store/sqlite-opfs"));
const sqliteWasm = require.resolve("@aztec-labs/sqlite3mc-wasm/vendor/jswasm/sqlite3.wasm");
// Node built-ins the Aztec packages import at module scope, as an app bundler stubs them.
const nodeShim = fileURLToPath(new URL("./node-shim.ts", import.meta.url));
const nodeShims = { tty: nodeShim, net: nodeShim };

// Recipient addresses: 0x + 64 lowercase hex.
const SCOPE = `0x${"0a1b".repeat(16)}`;
const OTHER_SCOPE = `0x${"2c3d".repeat(16)}`;
// Hex letters in the rollup, so an upper-cased address really differs from the stored name.
const MAINNET = { l1ChainId: 1, rollupAddress: `0x${"ab".repeat(20)}` };

let server: TestServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const [module, worker, wasm] = await Promise.all([
    bundle(
      [
        `export * from "./browser-wallet-storage.js";`,
        `export { PXE_DATA_SCHEMA_VERSION } from "@aztec-labs/pxe/client/lazy";`,
      ].join("\n"),
      srcDir,
      nodeShims,
    ),
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
  it("persists only the encrypted PXE store; the wallet DB lives in memory per session", async () => {
    const result = await page.evaluate(
      async ([scope, network]) => {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const storage = new window.walletStorage.BrowserWalletStorage(async () => key.slice());
        const options = await storage.embeddedWalletOptions(scope, network);
        await options.pxe.store!.openMap<string, string>("smoke").set("k", "pxe-value");
        await options.walletDb.store!.openMap<string, string>("smoke").set("k", "wallet-value");
        await options.pxe.store!.close();
        await options.walletDb.store!.close();

        const pools: string[] = [];
        for await (const name of (await navigator.storage.getDirectory()).keys()) pools.push(name);

        const reopened = await storage.embeddedWalletOptions(scope, network);
        const values = [
          await reopened.pxe.store!.openMap<string, string>("smoke").getAsync("k"),
          await reopened.walletDb.store!.openMap<string, string>("smoke").getAsync("k"),
        ];
        await reopened.pxe.store!.close();
        await reopened.walletDb.store!.close();
        return { pools: pools.sort(), values };
      },
      [SCOPE, MAINNET] as const,
    );
    const schemaVersion = await page.evaluate(() => window.walletStorage.PXE_DATA_SCHEMA_VERSION);
    expect(result).toEqual({
      pools: [
        `.aztec-kv-xochi-recipient-${SCOPE}-pxe_1-${MAINNET.rollupAddress}-v${schemaVersion}`,
      ],
      values: ["pxe-value", undefined],
    });
  });

  it("resets a PXE store encrypted under another key and reopens it empty", async () => {
    const result = await page.evaluate(
      async ([scope, network]) => {
        const { BrowserWalletStorage } = window.walletStorage;
        // Reads the PXE store's value, then leaves `written` there for the next open.
        const readThenWrite = async (
          storage: InstanceType<typeof BrowserWalletStorage>,
          written: string,
        ) => {
          const options = await storage.embeddedWalletOptions(scope, network);
          const map = options.pxe.store!.openMap<string, string>("smoke");
          const value = await map.getAsync("k");
          await map.set("k", written);
          await options.pxe.store!.close();
          await options.walletDb.store!.close();
          return value ?? null;
        };
        const keyA = crypto.getRandomValues(new Uint8Array(32));
        const keyB = crypto.getRandomValues(new Uint8Array(32));
        const underA = new BrowserWalletStorage(async () => keyA.slice());
        const underB = new BrowserWalletStorage(async () => keyB.slice());
        const firstUnderA = await readThenWrite(underA, "under-a");
        const firstUnderB = await readThenWrite(underB, "under-b");
        const againUnderB = await readThenWrite(underB, "under-b");
        const pools: string[] = [];
        for await (const name of (await navigator.storage.getDirectory()).keys()) {
          if (name.includes(scope)) pools.push(name);
        }
        return { firstUnderA, firstUnderB, againUnderB, pools: pools.length };
      },
      [`0x${"8c9d".repeat(16)}`, MAINNET] as const,
    );
    expect(result).toEqual({
      firstUnderA: null,
      firstUnderB: null,
      againUnderB: "under-b",
      pools: 1,
    });
  });

  it("selects a different PXE store for a different network or PXE schema", async () => {
    const result = await page.evaluate(
      async ([scope, mainnet]) => {
        const { BrowserWalletStorage, pxeStoreName, PXE_DATA_SCHEMA_VERSION } =
          window.walletStorage;
        const key = crypto.getRandomValues(new Uint8Array(32));
        const storage = new BrowserWalletStorage(async () => key.slice());
        const read = async (network: { l1ChainId: number; rollupAddress: string }) => {
          const options = await storage.embeddedWalletOptions(scope, network);
          const map = options.pxe.store!.openMap<string, string>("smoke");
          const value = await map.getAsync("k");
          if (value === undefined)
            await map.set("k", `${network.l1ChainId}:${network.rollupAddress}`);
          await options.pxe.store!.close();
          await options.walletDb.store!.close();
          return value ?? null;
        };
        const sepolia = { ...mainnet, l1ChainId: 11155111 };
        const otherRollup = { ...mainnet, rollupAddress: `0x${"22".repeat(20)}` };
        return {
          first: await read(mainnet),
          sepolia: await read(sepolia),
          otherRollup: await read(otherRollup),
          mainnetAgain: await read(mainnet),
          checksummedRollup: await read({
            ...mainnet,
            rollupAddress: mainnet.rollupAddress.toUpperCase().replace("0X", "0x"),
          }),
          nextSchema:
            pxeStoreName(scope, mainnet, PXE_DATA_SCHEMA_VERSION + 1) !==
            pxeStoreName(scope, mainnet, PXE_DATA_SCHEMA_VERSION),
        };
      },
      [OTHER_SCOPE, MAINNET] as const,
    );
    expect(result).toEqual({
      first: null,
      sepolia: null,
      otherRollup: null,
      mainnetAgain: `1:${MAINNET.rollupAddress}`,
      checksummedRollup: `1:${MAINNET.rollupAddress}`,
      nextSchema: true,
    });
  });

  it("refuses a PXE store whose recorded identity differs from its name, and unlocks it", async () => {
    const outcomes = await page.evaluate(
      async ([scope, network]) => {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const storage = new window.walletStorage.BrowserWalletStorage(async () => key.slice());
        const options = await storage.embeddedWalletOptions(scope, network);
        await options.pxe.store!.openSingleton<string>("dbVersion").set("not this network");
        await options.pxe.store!.close();
        await options.walletDb.store!.close();
        const outcomes: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          outcomes.push(
            await storage.embeddedWalletOptions(scope, network).then(
              () => "opened",
              (error: unknown) => (error instanceof Error ? error.name : String(error)),
            ),
          );
        }
        return outcomes;
      },
      [`0x${"4e5f".repeat(16)}`, MAINNET] as const,
    );
    expect(outcomes).toEqual(["StoreIdentityMismatchError", "StoreIdentityMismatchError"]);
  });

  it("refuses a network that is not a positive chain id and an L1 address", async () => {
    const refusals = await page.evaluate(
      async (scope) => {
        const storage = new window.walletStorage.BrowserWalletStorage(async () =>
          crypto.getRandomValues(new Uint8Array(32)),
        );
        const refusals: string[] = [];
        for (const network of [
          { l1ChainId: 0, rollupAddress: `0x${"11".repeat(20)}` },
          { l1ChainId: 1.5, rollupAddress: `0x${"11".repeat(20)}` },
          { l1ChainId: 1, rollupAddress: "0x1234" },
          { l1ChainId: 1, rollupAddress: `${"11".repeat(20)}/x` },
        ]) {
          refusals.push(
            await storage.embeddedWalletOptions(scope, network).then(
              () => "opened",
              (error: unknown) => (error instanceof TypeError ? "TypeError" : String(error)),
            ),
          );
        }
        return refusals;
      },
      `0x${"6a7b".repeat(16)}`,
    );
    expect(refusals).toEqual(Array<string>(4).fill("TypeError"));
  });

  it("refuses a scope that is not a single lowercase name segment", async () => {
    const refusals = await page.evaluate(async (network) => {
      const storage = new window.walletStorage.BrowserWalletStorage(async () =>
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const refusals: string[] = [];
      for (const scope of ["", "0xAB", "a/b", "../x", ".x"]) {
        refusals.push(
          await storage.embeddedWalletOptions(scope, network).then(
            () => "opened",
            (error: unknown) => (error instanceof TypeError ? "TypeError" : String(error)),
          ),
        );
      }
      return refusals;
    }, MAINNET);
    expect(refusals).toEqual(Array<string>(5).fill("TypeError"));
  });
});
