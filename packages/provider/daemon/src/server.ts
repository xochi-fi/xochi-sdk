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
import type { AuditRoute } from "./audit.ts";
import { formatUnknownError } from "./error-format.ts";
import { assertSafeBind, type DaemonConfig } from "./config.ts";

const MAX_BODY_BYTES = 32 * 1024; // 32 KB; sign body is ~1 KB
const MAX_PENDING_BARRETENBERG_REQUESTS = 64;

class QueueFullError extends Error {}
class BodyTooLargeError extends Error {}

export class BoundedSerialQueue {
  readonly #maxPending: number;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(maxPending: number) {
    this.#maxPending = maxPending;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new QueueFullError("Barretenberg request queue is full"));
    }
    this.#pending += 1;
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#pending -= 1;
    });
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Route groups a credential can be scoped to. */
type Scope = "signals" | "credentialRoot";

/** What the caller presented: a verified client cert, or a bearer token. */
type Credential =
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
        reject(new BodyTooLargeError("body exceeds 32 KB limit"));
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

const POST_ROUTES: Record<
  string,
  { scope: Scope; usesBarretenberg: boolean; handle: PostHandler }
> = {
  "/sign": { scope: "signals", usesBarretenberg: true, handle: handleSign },
  "/sign-multi": { scope: "signals", usesBarretenberg: true, handle: handleSignMulti },
  "/sign-credential-root": {
    scope: "credentialRoot",
    usesBarretenberg: false,
    handle: handleSignCredentialRoot,
  },
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
  const barretenbergQueue = new BoundedSerialQueue(MAX_PENDING_BARRETENBERG_REQUESTS);

  const auditRejection = async (
    res: ServerResponse,
    route: AuditRoute,
    source: string,
    reason: string,
    status: number,
    code: string,
    error: string,
  ): Promise<void> => {
    try {
      await ctx.audit.record({ ts: Date.now(), route, outcome: "rejected", source, reason });
    } catch (auditError) {
      process.stderr.write(
        `[xochi-provider] audit record failed: ${formatUnknownError(auditError)}\n`,
      );
      sendJson(res, 500, { error: "audit record failed", code: "AUDIT_FAILED" });
      return;
    }
    sendJson(res, status, { error, code });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        sendResult(res, handleHealthz());
        return;
      }

      const credential = presentedCredential(req, config);
      const scopes = credential ? scopesFor(credential, config) : [];
      if (!credential || scopes.length === 0) {
        sendJson(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
        return;
      }

      if (req.method === "GET" && req.url === "/pubkey-hash") {
        sendResult(res, await barretenbergQueue.run(() => handlePubkeyHash(ctx)));
        return;
      }

      const route =
        req.method === "POST" && req.url && Object.hasOwn(POST_ROUTES, req.url)
          ? POST_ROUTES[req.url]
          : undefined;
      if (!route) {
        sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
        return;
      }

      const routeName = req.url as AuditRoute;
      const source = sourceLabel(credential, route.scope);
      if (!scopes.includes(route.scope)) {
        await auditRejection(
          res,
          routeName,
          source,
          "credential not permitted on this route",
          403,
          "ROUTE_NOT_PERMITTED",
          "credential not permitted on this route",
        );
        return;
      }

      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        await auditRejection(
          res,
          routeName,
          source,
          formatUnknownError(err),
          tooLarge ? 413 : 400,
          tooLarge ? "BODY_TOO_LARGE" : "BODY_READ_FAILED",
          tooLarge ? "request body too large" : "request body read failed",
        );
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch (err) {
        await auditRejection(
          res,
          routeName,
          source,
          `invalid JSON: ${formatUnknownError(err)}`,
          400,
          "BAD_JSON",
          "invalid JSON",
        );
        return;
      }

      const invoke = (): Promise<HandlerResult<unknown>> => route.handle(ctx, policy, body, source);
      try {
        sendResult(res, await (route.usesBarretenberg ? barretenbergQueue.run(invoke) : invoke()));
      } catch (err) {
        const overloaded = err instanceof QueueFullError;
        await auditRejection(
          res,
          routeName,
          source,
          formatUnknownError(err),
          overloaded ? 503 : 500,
          overloaded ? "OVERLOADED" : "INTERNAL",
          overloaded ? "signing service overloaded" : "internal error",
        );
      }
    } catch (err) {
      process.stderr.write(`[xochi-provider] request failed: ${formatUnknownError(err)}\n`);
      sendJson(res, 500, { error: "internal error", code: "INTERNAL" });
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
