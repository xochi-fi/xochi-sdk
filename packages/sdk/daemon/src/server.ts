/**
 * HTTP/HTTPS server for the signing daemon.
 *
 * Patterned on pxe-bridge's server: Node http core (no framework), strict
 * body limits, security headers, bearer auth or mTLS.
 *
 * mTLS, when enabled, is the canonical pattern from Vouch/Dirk -- a CA
 * authorizes specific client certs to call /sign. Clients that present an
 * unknown cert are TLS-rejected before we read any request bytes.
 *
 * Credentials are scoped per route group. The signal routes (/sign,
 * /sign-multi) and /sign-credential-root are separate trust roles: a
 * credential-root signature lets its holder publish credential roots, which
 * `EIP712CredentialRoot` deliberately keeps apart from whoever drives signal
 * signing. Each group has its own credential, and neither opens the other.
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
  handleSignMulti,
  handleSignCredentialRoot,
  signingPolicy,
  type HandlerContext,
  type HandlerResult,
  type SigningPolicy,
} from "./handlers.ts";
import { assertSafeBind, type DaemonConfig } from "./config.ts";

const MAX_BODY_BYTES = 32 * 1024; // 32 KB; sign body is ~1 KB

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Route groups a credential can be scoped to. */
export type Scope = "signals" | "credentialRoot";

/** What the caller presented: a verified client cert, or a bearer token. */
export type Credential =
  | { kind: "mtls"; commonName: string | undefined }
  | { kind: "bearer"; token: string | undefined };

function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(provided, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Scopes held by a credential. mTLS: a CN listed in `credentialRootClientCns`
 * holds only `credentialRoot`; any other verified cert holds `signals` (or only
 * CNs in `signalsClientCns`, when that allowlist is set). Bearer: `apiKey`
 * holds `signals`, `credentialRootApiKey` holds `credentialRoot`.
 */
export function scopesFor(credential: Credential, config: DaemonConfig): Scope[] {
  if (credential.kind === "mtls") {
    const cn = credential.commonName;
    if (cn !== undefined && config.credentialRootClientCns?.includes(cn)) {
      return ["credentialRoot"];
    }
    if (config.signalsClientCns && (cn === undefined || !config.signalsClientCns.includes(cn))) {
      return [];
    }
    return ["signals"];
  }
  const token = credential.token;
  if (token === undefined) return [];
  // Compare against both keys unconditionally so timing does not reveal which matched.
  const signals = config.apiKey !== undefined && tokenEquals(token, config.apiKey);
  const credentialRoot =
    config.credentialRootApiKey !== undefined && tokenEquals(token, config.credentialRootApiKey);
  const scopes: Scope[] = [];
  if (signals) scopes.push("signals");
  if (credentialRoot) scopes.push("credentialRoot");
  return scopes;
}

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

function sendResult<T>(res: ServerResponse, result: HandlerResult<T>): void {
  if (result.ok) sendJson(res, result.status, result.body);
  else sendJson(res, result.error.status, result.error.body);
}

/**
 * Identify the caller. Under mTLS the TLS layer already rejected unknown
 * certs (rejectUnauthorized); the `authorized` check is belt-and-suspenders
 * and never falls back to bearer.
 */
function presentedCredential(req: IncomingMessage, config: DaemonConfig): Credential | undefined {
  if (config.clientCaPath) {
    const sock = req.socket as TLSSocket;
    if (sock.authorized !== true || typeof sock.getPeerCertificate !== "function") {
      return undefined;
    }
    const cn = sock.getPeerCertificate(false)?.subject?.CN;
    return { kind: "mtls", commonName: typeof cn === "string" ? cn : undefined };
  }
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return { kind: "bearer", token: undefined };
  }
  return { kind: "bearer", token: header.slice("Bearer ".length) };
}

function sourceLabel(credential: Credential, scope: Scope): string {
  if (credential.kind === "mtls") return `mtls:${credential.commonName ?? "unknown"}`;
  return scope === "credentialRoot" ? "bearer:credential-root" : "bearer:signals";
}

type PostHandler = (
  ctx: HandlerContext,
  policy: SigningPolicy,
  body: unknown,
  source: string,
) => Promise<HandlerResult<unknown>>;

const POST_ROUTES: Record<string, { scope: Scope; handle: PostHandler }> = {
  "/sign": { scope: "signals", handle: handleSign },
  "/sign-multi": { scope: "signals", handle: handleSignMulti },
  "/sign-credential-root": { scope: "credentialRoot", handle: handleSignCredentialRoot },
};

export interface DaemonServer {
  /** Start listening. Resolves when the server is bound. */
  listen(): Promise<{ host: string; port: number }>;
  /** Close all open sockets and stop listening. */
  close(): Promise<void>;
}

export function createDaemonServer(
  ctx: HandlerContext,
  config: DaemonConfig,
  policy: SigningPolicy = signingPolicy(config),
): DaemonServer {
  assertSafeBind(config);
  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  const useMtls = Boolean(config.clientCaPath);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Health check is unauthenticated (typical for liveness probes).
      if (req.method === "GET" && req.url === "/healthz") {
        sendResult(res, handleHealthz());
        return;
      }

      // Authenticate before routing or reading the body.
      const credential = presentedCredential(req, config);
      const scopes = credential ? scopesFor(credential, config) : [];
      if (!credential || scopes.length === 0) {
        sendJson(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
        return;
      }

      if (req.method === "GET" && req.url === "/pubkey-hash") {
        sendResult(res, await handlePubkeyHash(ctx));
        return;
      }

      // Own-property check: the URL is caller input and must not resolve to an
      // inherited Object property (a request target of "constructor", say).
      const route =
        req.method === "POST" && req.url && Object.hasOwn(POST_ROUTES, req.url)
          ? POST_ROUTES[req.url]
          : undefined;
      if (!route) {
        sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
        return;
      }
      if (!scopes.includes(route.scope)) {
        sendJson(res, 403, {
          error: "credential not permitted on this route",
          code: "ROUTE_NOT_PERMITTED",
        });
        return;
      }

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
      sendResult(res, await route.handle(ctx, policy, body, sourceLabel(credential, route.scope)));
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
