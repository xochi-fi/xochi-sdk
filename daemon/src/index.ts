/**
 * Reference signing daemon entry point.
 *
 * Loads config + key, instantiates the signer + replay-DB + audit log,
 * starts the HTTP/HTTPS server, registers signal handlers for graceful
 * shutdown.
 *
 * Run via:
 *
 *   SIGNER_PRIVATE_KEY_HEX=0x... \
 *   SIGNER_API_KEY=$(openssl rand -hex 32) \
 *   node --experimental-strip-types daemon/src/index.ts
 *
 * Or with TLS + mTLS:
 *
 *   SIGNER_PRIVATE_KEY_HEX=0x... \
 *   SIGNER_TLS_CERT=server.crt SIGNER_TLS_KEY=server.key \
 *   SIGNER_CLIENT_CA=clients-ca.crt \
 *   node --experimental-strip-types daemon/src/index.ts
 */

import { Barretenberg } from "@aztec/bb.js";

import { HexKeyLoader, loadSignerKey, MemoryReplayDb } from "../../src/provider/index.js";
import { loadConfig } from "./config.js";
import { makeAuditSink } from "./audit.js";
import { createDaemonServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  process.stderr.write(
    `[xochi-signer] starting on ${config.host}:${String(config.port)}` +
      ` (tls=${String(Boolean(config.tlsCertPath))} mtls=${String(Boolean(config.clientCaPath))})\n`,
  );

  const api = await Barretenberg.new();
  const signerKey = await loadSignerKey(
    new HexKeyLoader(config.signerKeyHex, config.providerLabel),
  );
  const replayDb = new MemoryReplayDb();
  const audit = makeAuditSink(config.auditLogPath);

  const server = createDaemonServer({ api, signerKey, replayDb, audit }, config);

  const { host, port } = await server.listen();
  process.stderr.write(`[xochi-signer] listening on ${host}:${String(port)}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[xochi-signer] received ${signal}, shutting down\n`);
    try {
      await server.close();
      audit.close();
      await api.destroy();
    } catch (err) {
      process.stderr.write(`[xochi-signer] shutdown error: ${(err as Error).message}\n`);
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
