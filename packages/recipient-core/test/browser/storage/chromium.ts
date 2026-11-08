// Test harness: bundles a module under test with esbuild, serves it from 127.0.0.1 (a secure
// context, so IndexedDB, Web Locks and OPFS are available) and drives real Chromium via Playwright.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";

export interface Asset {
  type: string;
  body: string | Uint8Array;
}

export interface TestServer {
  origin: string;
  close(): Promise<void>;
}

/** Bundles `source` (an ES module re-exporting the code under test) for the browser. */
export async function bundle(
  source: string,
  resolveDir: string,
  alias: Record<string, string> = {},
): Promise<string> {
  const result = await build({
    stdin: { contents: source, resolveDir, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    alias,
    write: false,
    logLevel: "silent",
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error("esbuild produced no output");
  return output.text;
}

/** An HTML page that imports `/module.js` and exposes its namespace as `window[globalName]`. */
export function modulePage(globalName: string): Asset {
  return {
    type: "text/html",
    body: `<!doctype html><meta charset="utf-8"><script type="module">import * as m from "/module.js"; window[${JSON.stringify(globalName)}] = m;</script>`,
  };
}

export async function serve(assets: Record<string, Asset>): Promise<TestServer> {
  const server = createServer((request, response) => {
    const asset = assets[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
    response.end(asset.body);
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
