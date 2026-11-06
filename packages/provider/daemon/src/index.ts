/**
 * Reference signing daemon entry point.
 *
 * Loads config + key, instantiates the signer + signing ledger + audit log,
 * starts the HTTP/HTTPS server, registers signal handlers for graceful
 * shutdown.
 *
 * Usage and environment: ../README.md.
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
  const { audit, server } = await (async () => {
    let audit: ReturnType<typeof makeAuditSink> | undefined;
    let server: ReturnType<typeof createDaemonServer> | undefined;
    try {
      audit = makeAuditSink(config.auditLogPath);
      server = createDaemonServer({ api, signer, replayDb, audit }, config);
      const { host, port } = await server.listen();
      process.stderr.write(`[xochi-provider] listening on ${host}:${String(port)}\n`);
      return { audit, server };
    } catch (cause) {
      const cleanup = await Promise.allSettled([
        ...(server ? [server.close()] : []),
        ...(audit ? [audit.close()] : []),
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
  })();

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
