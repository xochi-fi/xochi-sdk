/**
 * Reference signing daemon -- env var parsing.
 *
 * The daemon is a thin HTTP wrapper around `@xochi/sdk/provider`'s signers.
 * Production deployments typically replace this with a service that authenticates
 * to a KMS for the signing key; this reference parses the key from an env var
 * (HEX) for simplicity. NEVER use SIGNER_PRIVATE_KEY_HEX in production.
 *
 * The signing policy is pinned here rather than taken from request bodies: the
 * daemon signs only for one Oracle deployment (chain ID + address), only fresh
 * timestamps, and (optionally) only one provider ID. A caller holding a valid
 * credential cannot redirect the key at another chain, another Oracle, or a
 * backdated/future-dated bundle.
 */

export interface DaemonConfig {
  /** Bind address. Default 127.0.0.1 (localhost-only). */
  host: string;
  /** Listen port. Default 8548. */
  port: number;
  /** Hex-encoded secp256k1 signing key (32 bytes, "0x..."-prefixed or bare). */
  signerKeyHex: string;
  /** Bearer token for the signal routes (/sign, /sign-multi) and /pubkey-hash. */
  apiKey: string | undefined;
  /**
   * Bearer token for /sign-credential-root (and /pubkey-hash). Must differ from
   * `apiKey`. Unset (and no `credentialRootClientCns`) disables the route.
   */
  credentialRootApiKey: string | undefined;
  /** Path to TLS server certificate (PEM). Both this and `tlsKeyPath` enable HTTPS. */
  tlsCertPath: string | undefined;
  /** Path to TLS server key (PEM). */
  tlsKeyPath: string | undefined;
  /** Path to a CA cert that signs client certs. Setting this enables mTLS (rejects unauth). */
  clientCaPath: string | undefined;
  /**
   * mTLS: client-cert CNs allowed on the signal routes. Unset means any
   * CA-signed cert whose CN is not in `credentialRootClientCns`.
   */
  signalsClientCns: string[] | undefined;
  /** mTLS: client-cert CNs allowed on /sign-credential-root. Unset disables the route. */
  credentialRootClientCns: string[] | undefined;
  /** Path to write JSONL audit log. Default stdout. */
  auditLogPath: string | undefined;
  /** Provider label surfaced in audit logs. */
  providerLabel: string;
  /** Chain ID of the only Oracle deployment this daemon signs for. */
  chainId: bigint;
  /** Address of the only Oracle deployment this daemon signs for. */
  oracleAddress: `0x${string}`;
  /** If set, /sign-credential-root signs only for this provider ID. */
  providerId: bigint | undefined;
  /** Oldest accepted signal timestamp, in seconds before now. */
  maxTimestampAgeSeconds: number;
  /** Furthest-future accepted signal timestamp, in seconds after now (clock skew). */
  maxTimestampSkewSeconds: number;
  /** Longest accepted credential-root signature lifetime (`notAfter - now`), in seconds. */
  credentialRootMaxValiditySeconds: number;
  /** Permit binding a non-loopback host over plain HTTP. Default false. */
  allowInsecureBind: boolean;
}

export const DEFAULT_MAX_TIMESTAMP_AGE_SECONDS = 300;
export const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 30;
export const DEFAULT_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS = 3600;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer; got ${raw}`);
  }
  const n = Number(raw);
  if (n > max) {
    throw new Error(`${name} must be <= ${String(max)}; got ${raw}`);
  }
  return n;
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const items = raw.split(",").map((s) => s.trim());
  if (items.some((s) => s === "")) {
    throw new Error(`${name} must be a comma-separated list with no empty entries; got ${raw}`);
  }
  return items;
}

/** True for addresses that never leave the host. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuse to expose the signer over cleartext: a non-loopback bind requires TLS
 * unless explicitly overridden. Enforced by both `loadConfig` and
 * `createDaemonServer`, so a hand-built config cannot skip it.
 */
export function assertSafeBind(config: DaemonConfig): void {
  const tls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  if (!tls && !isLoopbackHost(config.host) && !config.allowInsecureBind) {
    throw new Error(
      `Refusing to bind non-loopback host ${config.host} over plain HTTP: set ` +
        "SIGNER_TLS_CERT/SIGNER_TLS_KEY, bind 127.0.0.1, or set SIGNER_ALLOW_INSECURE_BIND=1",
    );
  }
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

  // Credential-root signing authorizes a publisher to mint credential roots,
  // a different trust role from signal signing (EIP712CredentialRoot keeps the
  // HSM key and the publisher separate). It gets its own credential.
  const credentialRootApiKey = env.SIGNER_CREDENTIAL_ROOT_API_KEY;
  const signalsClientCns = envList(env, "SIGNER_SIGNALS_CLIENT_CNS");
  const credentialRootClientCns = envList(env, "SIGNER_CREDENTIAL_ROOT_CLIENT_CNS");
  if (credentialRootApiKey && clientCaPath) {
    throw new Error(
      "SIGNER_CREDENTIAL_ROOT_API_KEY is ignored under mTLS; use SIGNER_CREDENTIAL_ROOT_CLIENT_CNS",
    );
  }
  if (credentialRootApiKey && credentialRootApiKey === apiKey) {
    throw new Error("SIGNER_CREDENTIAL_ROOT_API_KEY must differ from SIGNER_API_KEY");
  }
  if ((signalsClientCns || credentialRootClientCns) && !clientCaPath) {
    throw new Error(
      "SIGNER_SIGNALS_CLIENT_CNS / SIGNER_CREDENTIAL_ROOT_CLIENT_CNS require SIGNER_CLIENT_CA",
    );
  }
  const overlap = signalsClientCns?.filter((cn) => credentialRootClientCns?.includes(cn)) ?? [];
  if (overlap.length > 0) {
    throw new Error(
      `A client CN may not hold both signal and credential-root scopes; got ${overlap.join(", ")}`,
    );
  }

  const chainIdRaw = env.SIGNER_CHAIN_ID;
  if (!chainIdRaw || !/^[1-9]\d*$/.test(chainIdRaw)) {
    throw new Error(
      `SIGNER_CHAIN_ID is required (positive decimal chain ID of the Oracle); got ${String(chainIdRaw)}`,
    );
  }
  const oracleAddress = env.SIGNER_ORACLE_ADDRESS;
  if (!oracleAddress || !ADDRESS_RE.test(oracleAddress)) {
    throw new Error(
      `SIGNER_ORACLE_ADDRESS is required (0x-prefixed 20-byte Oracle address); got ${String(oracleAddress)}`,
    );
  }
  const providerIdRaw = env.SIGNER_PROVIDER_ID;
  if (providerIdRaw !== undefined && providerIdRaw !== "" && !/^\d+$/.test(providerIdRaw)) {
    throw new Error(`SIGNER_PROVIDER_ID must be a decimal integer; got ${providerIdRaw}`);
  }

  const insecure = env.SIGNER_ALLOW_INSECURE_BIND;
  if (insecure !== undefined && insecure !== "" && insecure !== "0" && insecure !== "1") {
    throw new Error(`SIGNER_ALLOW_INSECURE_BIND must be 0 or 1; got ${insecure}`);
  }

  const config: DaemonConfig = {
    host: env.SIGNER_HTTP_HOST ?? "127.0.0.1",
    port: envInt(env, "SIGNER_HTTP_PORT", 8548, 65535),
    signerKeyHex,
    apiKey: apiKey ?? undefined,
    credentialRootApiKey: credentialRootApiKey ?? undefined,
    tlsCertPath: tlsCertPath ?? undefined,
    tlsKeyPath: tlsKeyPath ?? undefined,
    clientCaPath: clientCaPath ?? undefined,
    signalsClientCns,
    credentialRootClientCns,
    auditLogPath: env.SIGNER_AUDIT_LOG ?? undefined,
    providerLabel: env.SIGNER_PROVIDER_LABEL ?? "xochi-provider",
    chainId: BigInt(chainIdRaw),
    oracleAddress: oracleAddress as `0x${string}`,
    providerId: providerIdRaw ? BigInt(providerIdRaw) : undefined,
    maxTimestampAgeSeconds: envInt(
      env,
      "SIGNER_MAX_TIMESTAMP_AGE_SECONDS",
      DEFAULT_MAX_TIMESTAMP_AGE_SECONDS,
      86_400,
    ),
    maxTimestampSkewSeconds: envInt(
      env,
      "SIGNER_MAX_TIMESTAMP_SKEW_SECONDS",
      DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
      3600,
    ),
    credentialRootMaxValiditySeconds: envInt(
      env,
      "SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS",
      DEFAULT_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS,
      172_800,
    ),
    allowInsecureBind: insecure === "1",
  };
  assertSafeBind(config);
  return config;
}
