/**
 * Reference signing daemon entry point.
 *
 * Loads config + key, instantiates the signer + signing ledger + audit log,
 * starts the HTTP/HTTPS server, registers signal handlers for graceful
 * shutdown.
 *
 * Runs as TypeScript source under Node's type stripping (Node 22.6+ with
 * `--experimental-strip-types`, on by default from Node 23.6). The SDK is
 * imported by its package name, `@xochi/sdk/provider`: inside this repo that
 * self-references the built `dist/` (run `npm run build` first, which
 * `npm run daemon` does), and a copied daemon resolves the installed SDK.
 *
 *   SIGNER_PRIVATE_KEY_HEX=0x... \
 *   SIGNER_API_KEY=$(openssl rand -hex 32) \
 *   SIGNER_CHAIN_ID=8453 SIGNER_ORACLE_ADDRESS=0x... \
 *   npm run daemon
 *
 * Or with TLS + mTLS:
 *
 *   SIGNER_PRIVATE_KEY_HEX=0x... \
 *   SIGNER_CHAIN_ID=8453 SIGNER_ORACLE_ADDRESS=0x... \
 *   SIGNER_TLS_CERT=server.crt SIGNER_TLS_KEY=server.key \
 *   SIGNER_CLIENT_CA=clients-ca.crt \
 *   npm run daemon
 */

import { Barretenberg } from "@aztec/bb.js";

import { HexKeyLoader, loadSignerKey, MemoryReplayDb } from "@xochi/sdk/provider";
import { loadConfig } from "./config.ts";
import { makeAuditSink } from "./audit.ts";
import { createDaemonServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  process.stderr.write(
    `[xochi-signer] starting on ${config.host}:${String(config.port)}` +
      ` (tls=${String(Boolean(config.tlsCertPath))} mtls=${String(Boolean(config.clientCaPath))})` +
      ` chainId=${config.chainId.toString()} oracle=${config.oracleAddress}\n`,
  );

  const api = await Barretenberg.new();
  const signerKey = await loadSignerKey(
    new HexKeyLoader(config.signerKeyHex, config.providerLabel),
  );
  // Nothing older than the freshness window can be signed again, so records
  // past it are dead weight.
  const replayDb = new MemoryReplayDb({
    retentionSeconds: config.maxTimestampAgeSeconds + config.maxTimestampSkewSeconds,
  });
  const audit = makeAuditSink(config.auditLogPath);

  const server = createDaemonServer({ api, signerKey, replayDb, audit }, config);

  const { host, port } = await server.listen();
  process.stderr.write(`[xochi-signer] listening on ${host}:${String(port)}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[xochi-signer] received ${signal}, shutting down\n`);
    try {
      await server.close();
      await audit.close();
      await api.destroy();
    } catch (err) {
      process.stderr.write(`[xochi-signer] shutdown error: ${(err as Error).message}\n`);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: Error) => {
  process.stderr.write(`[xochi-signer] fatal: ${err.message}\n`);
  process.exit(1);
});
