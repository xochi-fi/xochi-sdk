/**
 * Reference signing daemon entry point.
 *
 * Loads config + key, instantiates the signer + signing ledger + audit log,
 * starts the HTTP/HTTPS server, registers signal handlers for graceful
 * shutdown.
 *
 * Runs as TypeScript source under Node's type stripping (Node 22.6+ with
 * `--experimental-strip-types`, on by default from Node 23.6). The signers are
 * imported by package name, `@xochi/provider`: inside this repo that
 * self-references the built `dist/` (run `npm run build` first, which
 * `npm run daemon` does), and a copied daemon resolves the installed package.
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

import {
  HexPrivateKeyLoader,
  loadLocalSigner,
  MemoryReplayDb,
  type DestroyableDigestSigner,
} from "@xochi/provider";
import { loadConfig } from "./config.ts";
import { makeAuditSink } from "./audit.ts";
import { createDaemonServer } from "./server.ts";
import { formatUnknownError } from "./error-format.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  process.stderr.write(
    `[xochi-provider] starting on ${config.host}:${String(config.port)}` +
      ` (tls=${String(Boolean(config.tlsCertPath))} mtls=${String(Boolean(config.clientCaPath))})` +
      ` chainId=${config.chainId.toString()} oracle=${config.oracleAddress}\n`,
  );

  const api = await Barretenberg.new();
  let signer: DestroyableDigestSigner;
  try {
    signer = await loadLocalSigner(
      new HexPrivateKeyLoader(config.signerKeyHex, config.providerLabel),
    );
  } catch (cause) {
    await api.destroy();
    throw cause;
  }

  const replayDb = new MemoryReplayDb({
    retentionSeconds: config.maxTimestampAgeSeconds + config.maxTimestampSkewSeconds,
  });
  const audit = makeAuditSink(config.auditLogPath);
  const server = createDaemonServer({ api, signer, replayDb, audit }, config);

  try {
    const { host, port } = await server.listen();
    process.stderr.write(`[xochi-provider] listening on ${host}:${String(port)}\n`);
  } catch (cause) {
    const cleanup = await Promise.allSettled([
      audit.close(),
      Promise.resolve().then(() => signer.destroy()),
      api.destroy(),
    ]);
    const cleanupFailures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => formatUnknownError(result.reason));
    if (cleanupFailures.length > 0) {
      process.stderr.write(
        `[xochi-provider] startup cleanup failed: ${cleanupFailures.join("; ")}\n`,
      );
    }
    throw cause;
  }

  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.stderr.write(`[xochi-provider] received ${signal}, shutting down\n`);

    const serverCleanup = await Promise.allSettled([server.close()]);
    const dependencyCleanup = await Promise.allSettled([
      audit.close(),
      Promise.resolve().then(() => signer.destroy()),
      api.destroy(),
    ]);
    const failures = [...serverCleanup, ...dependencyCleanup]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => formatUnknownError(result.reason));
    if (failures.length > 0) {
      process.stderr.write(`[xochi-provider] shutdown error: ${failures.join("; ")}\n`);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`[xochi-provider] fatal: ${formatUnknownError(err)}\n`);
  process.exit(1);
});
