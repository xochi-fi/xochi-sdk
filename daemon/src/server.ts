/**
 * HTTP/HTTPS server for the signing daemon.
 *
 * Patterned on pxe-bridge's server: Node http core (no framework), strict
 * body limits, security headers, optional bearer auth + optional mTLS.
 *
 * mTLS, when enabled, is the canonical pattern from Vouch/Dirk -- a CA
 * authorizes specific client certs to call /sign. Clients that present an
 * unknown cert are TLS-rejected before we read any request bytes.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { TLSSocket } from "node:tls";
import { timingSafeEqual } from "node:crypto";

import {
  handleHealthz,
  handlePubkeyHash,
  handleSign,
  handleSignCredentialRoot,
  type HandlerContext,
} from "./handlers.js";
import type { DaemonConfig } from "./config.js";

const MAX_BODY_BYTES = 32 * 1024; // 32 KB; sign body is ~1 KB

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        req.resume();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function authBearer(req: IncomingMessage, expectedKey: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  const expected = Buffer.from(expectedKey, "utf-8");
  const got = Buffer.from(provided, "utf-8");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(expected, got);
}

function clientSourceLabel(req: IncomingMessage, config: DaemonConfig): string {
  // mTLS path: extract Common Name from peer cert.
  const sock = req.socket as TLSSocket;
  if (config.clientCaPath && typeof sock.getPeerCertificate === "function") {
    const cert = sock.getPeerCertificate(false);
    if (cert?.subject?.CN) return `mtls:${cert.subject.CN}`;
  }
  if (config.apiKey) return "bearer";
  return "unknown";
}

function isAuthorized(req: IncomingMessage, config: DaemonConfig): boolean {
  // mTLS implicitly authorizes via the Node TLS layer (rejectUnauthorized=true).
  // If the server is mTLS and we got here, the cert chain validated against the CA.
  // For belt-and-suspenders we still check the socket is authorized.
  const sock = req.socket as TLSSocket;
  if (config.clientCaPath) {
    if (typeof sock.authorized === "boolean" && sock.authorized) return true;
    // mTLS configured but cert didn't validate: hard-fail (don't fall back to bearer).
    return false;
  }
  if (config.apiKey) {
    return authBearer(req, config.apiKey);
  }
  return false;
}

export interface DaemonServer {
  /** Start listening. Resolves when the server is bound. */
  listen(): Promise<{ host: string; port: number }>;
  /** Close all open sockets and stop listening. */
  close(): Promise<void>;
}

export function createDaemonServer(ctx: HandlerContext, config: DaemonConfig): DaemonServer {
  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  const useMtls = Boolean(config.clientCaPath);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Health check is unauthenticated (typical for liveness probes).
      if (req.method === "GET" && req.url === "/healthz") {
        const r = handleHealthz();
        if (r.ok) sendJson(res, r.status, r.body);
        else sendJson(res, r.error.status, r.error.body);
        return;
      }

      if (!isAuthorized(req, config)) {
        sendJson(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      const source = clientSourceLabel(req, config);

      if (req.method === "GET" && req.url === "/pubkey-hash") {
        const r = await handlePubkeyHash(ctx);
        if (r.ok) sendJson(res, r.status, r.body);
        else sendJson(res, r.error.status, r.error.body);
        return;
      }

      if (req.method === "POST" && req.url === "/sign") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (err) {
          sendJson(res, 413, { error: (err as Error).message, code: "BODY_TOO_LARGE" });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "invalid JSON", code: "BAD_JSON" });
          return;
        }
        const result = await handleSign(ctx, body, source);
        if (result.ok) sendJson(res, result.status, result.body);
        else sendJson(res, result.error.status, result.error.body);
        return;
      }

      if (req.method === "POST" && req.url === "/sign-credential-root") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (err) {
          sendJson(res, 413, { error: (err as Error).message, code: "BODY_TOO_LARGE" });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "invalid JSON", code: "BAD_JSON" });
          return;
        }
        const result = handleSignCredentialRoot(ctx, body, source);
        if (result.ok) sendJson(res, result.status, result.body);
        else sendJson(res, result.error.status, result.error.body);
        return;
      }

      sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message ?? "internal error", code: "INTERNAL" });
    }
  };

  let server: HttpServer | HttpsServer;
  if (useTls) {
    if (!config.tlsCertPath || !config.tlsKeyPath) throw new Error("TLS configured incompletely");
    const cert = readFileSync(config.tlsCertPath);
    const key = readFileSync(config.tlsKeyPath);
    const ca = config.clientCaPath ? readFileSync(config.clientCaPath) : undefined;
    server = createHttpsServer(
      {
        cert,
        key,
        ca,
        requestCert: useMtls,
        rejectUnauthorized: useMtls,
      },
      handler,
    );
  } else {
    server = createHttpServer(handler);
  }

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          if (typeof addr === "object" && addr) {
            resolve({ host: addr.address, port: addr.port });
          } else {
            resolve({ host: config.host, port: config.port });
          }
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
