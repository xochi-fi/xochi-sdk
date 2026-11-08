// Real-Chromium smoke for the browser keystore: esbuild bundles it for the browser platform (a
// node:* import fails the bundle) and a headless page runs seal/open and PKW1, where Buffer and
// process do not exist. The page origin is served by a route handler; every other request aborts.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Keystore from "../../../src/browser/keystore/index.js";
import type { SealKind } from "../../../src/ports.js";

/** tools/recipient/src/sealed.ts, loaded at run time because it lies outside this package's rootDir. */
interface NodeSealed {
  seal(kind: SealKind, plaintext: Buffer, passphrase: string): Buffer;
  open(kind: SealKind, sealed: Buffer, passphrase: string): Buffer;
}
const NODE_SEALED = new URL("../../../../../tools/recipient/src/sealed.ts", import.meta.url);
const node = (await import(fileURLToPath(NODE_SEALED))) as NodeSealed;

const ENTRY = fileURLToPath(new URL("../../../src/browser/keystore/index.ts", import.meta.url));
const ORIGIN = "https://keystore.test/";
const PASSPHRASE = "correct horse battery staple";
const PLAINTEXT = Array.from(new TextEncoder().encode('{"secret":"0x01","salt":"0x02"}'));
/** contract A.3 `zeros-ones` wrapKey and the contract B test credentialIdHash. */
const WRAP_KEY = Array.from(
  Buffer.from("88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b", "hex"),
);
const CREDENTIAL_ID_HASH = "0x0f51d6f267f479d4f99be0115f01345c551b48f352902e002a2ff851b20f63f2";

describe("browser keystore in headless Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "keystore",
      write: false,
      logLevel: "silent",
    });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url() === ORIGIN
        ? route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>keystore</title>",
          })
        : route.abort(),
    );
    await page.goto(ORIGIN);
    await page.addScriptTag({ content: bundle.outputFiles[0]?.text });
  });

  afterAll(async () => {
    await browser?.close();
  });

  // Only shows the page offers no Node globals to fall back on. The proof that the keystore imports
  // no node:* module is the platform: "browser" esbuild build in beforeAll, which fails on one.
  it("serves the page as a secure context without Buffer or process globals", async () => {
    expect(
      await page.evaluate(() => ({
        secure: isSecureContext,
        buffer: "Buffer" in globalThis,
        process: "process" in globalThis,
      })),
    ).toEqual({ secure: true, buffer: false, process: false });
  });

  it("seals and opens both kinds, interoperating with the Node implementation", async () => {
    const fromNode = Array.from(node.seal("backup", Buffer.from(PLAINTEXT), PASSPHRASE));
    const result = await page.evaluate(
      async ({ plaintext, passphrase, fromNode }) => {
        // Set by the IIFE bundle (globalName "keystore").
        const { keystore } = globalThis as unknown as { keystore: typeof Keystore };
        const crypto = new keystore.BrowserKeystoreCrypto();
        const bytes = Uint8Array.from(plaintext);
        const started = performance.now();
        const sealedKeystore = await crypto.seal("keystore", bytes, passphrase);
        const sealMs = performance.now() - started;
        const sealedBackup = await crypto.seal("backup", bytes, passphrase);
        return {
          sealMs,
          keystore: Array.from(sealedKeystore),
          backup: Array.from(sealedBackup),
          reopened: Array.from(await crypto.open("keystore", sealedKeystore, passphrase)),
          openedNode: Array.from(
            await crypto.open("backup", Uint8Array.from(fromNode), passphrase),
          ),
          kindMismatch: await crypto.open("backup", sealedKeystore, passphrase).catch(String),
        };
      },
      { plaintext: PLAINTEXT, passphrase: PASSPHRASE, fromNode },
    );
    console.info(`[keystore] Chromium scrypt N=2^17 seal: ${Math.round(result.sealMs)} ms`);
    expect(result.reopened).toEqual(PLAINTEXT);
    expect(result.openedNode).toEqual(PLAINTEXT);
    expect(result.kindMismatch).toBe("SealError: not a sealed backup");
    for (const kind of ["keystore", "backup"] as const) {
      const opened = node.open(kind, Buffer.from(result[kind]), PASSPHRASE);
      expect(Array.from(opened)).toEqual(PLAINTEXT);
    }
  });

  it("wraps and unwraps PKW1 under the A.3 wrap key and refuses another credential", async () => {
    const result = await page.evaluate(
      async ({ plaintext, wrapKeyBytes, credentialIdHash }) => {
        // Set by the IIFE bundle (globalName "keystore").
        const { keystore } = globalThis as unknown as { keystore: typeof Keystore };
        const { importWrapKey, wrapImported, unwrapImported } = keystore;
        const raw = Uint8Array.from(wrapKeyBytes);
        const wrapKey = await importWrapKey(raw);
        const hash = credentialIdHash as `0x${string}`;
        const wrapped = await wrapImported(Uint8Array.from(plaintext), wrapKey, hash);
        return {
          rawZeroed: raw.every((byte) => byte === 0),
          extractable: wrapKey.extractable,
          unwrapped: Array.from(await unwrapImported(wrapped, wrapKey, hash)),
          otherCredential: await unwrapImported(wrapped, wrapKey, `0x${"11".repeat(32)}`).catch(
            (error: Error) => error.name,
          ),
        };
      },
      { plaintext: PLAINTEXT, wrapKeyBytes: WRAP_KEY, credentialIdHash: CREDENTIAL_ID_HASH },
    );
    expect(result).toEqual({
      rawZeroed: true,
      extractable: false,
      unwrapped: PLAINTEXT,
      otherCredential: "SealError",
    });
  });
});
