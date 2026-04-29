/**
 * Reference signing daemon -- env var parsing.
 *
 * The daemon is a thin HTTP wrapper around `@xochi/sdk/provider`'s `signSignals`.
 * Production deployments typically replace this with a service that authenticates
 * to a KMS for the signing key; this reference parses the key from an env var
 * (HEX) for simplicity. NEVER use SIGNER_PRIVATE_KEY_HEX in production.
 */

export interface DaemonConfig {
  /** Bind address. Default 127.0.0.1 (localhost-only). */
  host: string;
  /** Listen port. Default 8548. */
  port: number;
  /** Hex-encoded secp256k1 signing key (32 bytes, "0x..."-prefixed or bare). */
  signerKeyHex: string;
  /** Optional bearer token; if set, requests must include `Authorization: Bearer <token>`. */
  apiKey: string | undefined;
  /** Path to TLS server certificate (PEM). Both this and `tlsKeyPath` enable HTTPS. */
  tlsCertPath: string | undefined;
  /** Path to TLS server key (PEM). */
  tlsKeyPath: string | undefined;
  /** Path to a CA cert that signs client certs. Setting this enables mTLS (rejects unauth). */
  clientCaPath: string | undefined;
  /** Path to write JSONL audit log. Default stdout. */
  auditLogPath: string | undefined;
  /** Provider label surfaced in audit logs. */
  providerLabel: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be an integer in 0..65535; got ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const signerKeyHex = env.SIGNER_PRIVATE_KEY_HEX;
  if (!signerKeyHex) {
    throw new Error("SIGNER_PRIVATE_KEY_HEX is required");
  }

  const tlsCertPath = env.SIGNER_TLS_CERT;
  const tlsKeyPath = env.SIGNER_TLS_KEY;
  if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) {
    throw new Error("SIGNER_TLS_CERT and SIGNER_TLS_KEY must be set together");
  }
  const clientCaPath = env.SIGNER_CLIENT_CA;
  if (clientCaPath && !tlsCertPath) {
    throw new Error("SIGNER_CLIENT_CA requires SIGNER_TLS_CERT/SIGNER_TLS_KEY (mTLS implies TLS)");
  }

  const apiKey = env.SIGNER_API_KEY;
  // mTLS-only mode: when client cert verification is on, also having a bearer
  // token is fine but discouraged (two auth modes invite confusion). Refuse
  // *unauthenticated* operation -- the daemon must have at least one of mTLS
  // or bearer key.
  if (!clientCaPath && !apiKey) {
    throw new Error(
      "Refusing to start: must configure SIGNER_API_KEY or SIGNER_CLIENT_CA (no auth = key oracle for the world)",
    );
  }

  return {
    host: env.SIGNER_HTTP_HOST ?? "127.0.0.1",
    port: envInt("SIGNER_HTTP_PORT", 8548),
    signerKeyHex,
    apiKey: apiKey ?? undefined,
    tlsCertPath: tlsCertPath ?? undefined,
    tlsKeyPath: tlsKeyPath ?? undefined,
    clientCaPath: clientCaPath ?? undefined,
    auditLogPath: env.SIGNER_AUDIT_LOG ?? undefined,
    providerLabel: env.SIGNER_PROVIDER_LABEL ?? "xochi-provider",
  };
}
