import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";

// Browser-targeted scratch consumer of the package's public entry. Execute the
// emitted bundle in a fresh realm so test-runner polyfills cannot mask ordering.
const scratch = mkdtempSync(join(tmpdir(), "peer-consumer-"));
try {
  writeFileSync(
    join(scratch, "entry.js"),
    `import { peerConfiguration, fetchPeerCapabilities, previewPeerOffer } from '@xochi/widget';
globalThis.peerConsumer = { config: peerConfiguration(), fetchPeerCapabilities, previewPeerOffer };`,
  );
  await build({
    configFile: false,
    root: scratch,
    logLevel: "error",
    resolve: { alias: { "@xochi/widget": resolve("packages/widget/dist/index.js") } },
    build: {
      outDir: join(scratch, "dist"),
      minify: false,
      lib: {
        entry: join(scratch, "entry.js"),
        formats: ["iife"],
        name: "PeerConsumer",
        fileName: () => "consumer.js",
      },
    },
  });
  const realm = {
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    crypto: globalThis.crypto,
  };
  runInNewContext(readFileSync(join(scratch, "dist/consumer.js"), "utf8"), realm, {
    timeout: 10000,
  });
  assert.equal(realm.peerConsumer.config.settlement.chain_id, "eip155:8453");
  assert.equal(typeof realm.peerConsumer.fetchPeerCapabilities, "function");
  assert.equal(typeof realm.peerConsumer.previewPeerOffer, "function");
  console.log("PASS: public Peer exports build and execute in a fresh browser realm");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
