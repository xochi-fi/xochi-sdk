/**
 * Request handlers for the signing daemon.
 *
 *   POST /sign                  -- sign a screening bundle (COMPLIANCE_SIGNED / RISK_SCORE_SIGNED)
 *   POST /sign-multi            -- sign one slot of a COMPLIANCE_MULTI_SIGNED bundle
 *   POST /sign-credential-root  -- sign an EIP-712 CredentialRootPublication
 *   GET  /pubkey-hash           -- return the daemon's signer_pubkey_hash for registration
 *   GET  /healthz               -- liveness check
 *
 * Every signing request is checked against the pinned `SigningPolicy` (Oracle
 * chain ID + address, timestamp freshness, optional provider ID) and audited
 * before a signature is released.
 */

import type { Barretenberg } from "@aztec/bb.js";
import {
  bytesToHex,
  computeSignerPubkeyHash,
  signCredentialRoot,
  signSignalsWithReplayProtection,
  signSlotPayloadWithReplayProtection,
  MAX_PROVIDERS_MULTI,
  type LedgeredSignResult,
  type ReplayDb,
  type SignCredentialRootRequest,
  type SignerKey,
  type SignSignalsRequest,
  type SignSlotRequest,
} from "@xochi/sdk/provider";
import type { AuditEvent, AuditRoute, AuditSink } from "./audit.ts";
import type { DaemonConfig } from "./config.ts";

export interface HandlerContext {
  api: Barretenberg;
  signerKey: SignerKey;
  replayDb: ReplayDb;
  audit: AuditSink;
}

/** What the daemon will sign, independent of what a request asks for. */
export interface SigningPolicy {
  chainId: bigint;
  oracleAddress: bigint;
  providerId: bigint | undefined;
  maxTimestampAgeSeconds: number;
  maxTimestampSkewSeconds: number;
  credentialRootMaxValiditySeconds: number;
  /** Current time in unix seconds. */
  now: () => number;
}

export function signingPolicy(
  config: DaemonConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): SigningPolicy {
  return {
    chainId: config.chainId,
    oracleAddress: BigInt(config.oracleAddress),
    providerId: config.providerId,
    maxTimestampAgeSeconds: config.maxTimestampAgeSeconds,
    maxTimestampSkewSeconds: config.maxTimestampSkewSeconds,
    credentialRootMaxValiditySeconds: config.credentialRootMaxValiditySeconds,
    now,
  };
}

export interface SignRequestBody {
  /**
   * EVM chain ID of the consuming Oracle deployment (audit F-6 binding).
   * Decimal string or number. Must equal the daemon's SIGNER_CHAIN_ID.
   */
  chainId: string | number;
  /**
   * Address of the consuming Oracle (0x-prefixed 20-byte hex, audit F-6
   * binding). Must equal the daemon's SIGNER_ORACLE_ADDRESS.
   */
  oracleAddress: string;
  /** Hex Field for the (provider_ids, weights) Pedersen commitment. */
  providerSetHash: string;
  /** 8 integers in [0, 100]; inactive slots 0. */
  signals: Array<string | number>;
  /** 8 u32 weights; active slots first and positive, inactive slots 0. */
  weights: Array<string | number>;
  /** Seconds since epoch; must be within the daemon's freshness window. */
  timestamp: string | number;
  /** 0x-prefixed 20-byte address of the proof submitter. */
  submitter: string;
}

export interface SignResponseBody {
  signature: `0x${string}`;
  pubkeyX: `0x${string}`;
  pubkeyY: `0x${string}`;
  signerPubkeyHash: `0x${string}`;
  payloadHash: `0x${string}`;
}

export interface HandlerError {
  status: number;
  body: { error: string; code?: string };
}

export type HandlerResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; error: HandlerError };

/**
 * A request refused on purpose; `status`/`code` are what the client sees.
 * Explicit fields, not parameter properties: Node's type stripping (how the
 * daemon runs) does not support parameter properties.
 */
class RequestRejected extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RequestRejected";
    this.status = status;
    this.code = code;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const U32_MAX = 0xffffffff;
const U64_MAX = 0xffffffffffffffffn;

function asBigint(value: unknown, label: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer; got ${String(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be string or number`);
  }
  if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(value)) {
    throw new Error(`${label} must be decimal or 0x-hex; got ${value}`);
  }
  return BigInt(value);
}

function asNumber(value: unknown, label: string, max: number): number {
  const n = asBigint(value, label);
  if (n > BigInt(max)) {
    throw new Error(`${label} must be an integer in [0, ${String(max)}]; got ${String(value)}`);
  }
  return Number(n);
}

function asAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(`${label} required (0x-prefixed 20-byte hex)`);
  }
  return value as `0x${string}`;
}

/** Fields shared by the single- and multi-signed request bodies. */
interface SignalFields {
  chainId: bigint;
  oracleAddress: bigint;
  providerSetHash: bigint;
  signals: bigint[];
  weights: bigint[];
  timestamp: bigint;
  submitter: bigint;
}

/**
 * Parse and range-check the screening data. Mirrors the circuits'
 * `validate_provider_slots`: signals in [0, 100], weights u32, at least one
 * active slot, and an inactive (zero-weight) slot carries no signal. With
 * `contiguous`, active slots must also form a prefix (the single-signed
 * circuits count them with `num_providers`).
 */
function parseSignalFields(raw: unknown, contiguous: boolean): SignalFields {
  if (raw === null || typeof raw !== "object") {
    throw new Error("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.providerSetHash !== "string") throw new Error("providerSetHash required (hex)");
  if (!Array.isArray(body.signals) || body.signals.length !== 8) {
    throw new Error("signals must be an array of length 8");
  }
  if (!Array.isArray(body.weights) || body.weights.length !== 8) {
    throw new Error("weights must be an array of length 8");
  }
  if (body.timestamp === undefined) throw new Error("timestamp required (string or number)");
  if (body.chainId === undefined) throw new Error("chainId required (string or number)");

  const signals = body.signals.map((s, i) => BigInt(asNumber(s, `signals[${String(i)}]`, 100)));
  const weights = body.weights.map((w, i) => BigInt(asNumber(w, `weights[${String(i)}]`, U32_MAX)));
  const active = weights.map((w) => w > 0n);
  if (!active.some(Boolean)) throw new Error("at least one weight must be positive");
  signals.forEach((s, i) => {
    if (!active[i] && s !== 0n) {
      throw new Error(`signals[${String(i)}] must be 0 when weights[${String(i)}] is 0`);
    }
  });
  if (contiguous && active.some((isActive, i) => isActive && i > 0 && !active[i - 1])) {
    throw new Error("active provider slots must be contiguous from index 0");
  }

  const submitter = BigInt(asAddress(body.submitter, "submitter"));
  if (submitter === 0n) throw new Error("submitter must be non-zero");

  return {
    chainId: asBigint(body.chainId, "chainId"),
    oracleAddress: BigInt(asAddress(body.oracleAddress, "oracleAddress")),
    providerSetHash: asBigint(body.providerSetHash, "providerSetHash"),
    signals,
    weights,
    timestamp: asBigint(body.timestamp, "timestamp"),
    submitter,
  };
}

function enforceDeployment(policy: SigningPolicy, chainId: bigint, oracleAddress: bigint): void {
  if (chainId !== policy.chainId) {
    throw new RequestRejected(
      403,
      "CHAIN_MISMATCH",
      `chainId ${chainId.toString()} is not the pinned chain ${policy.chainId.toString()}`,
    );
  }
  if (oracleAddress !== policy.oracleAddress) {
    throw new RequestRejected(403, "ORACLE_MISMATCH", "oracleAddress is not the pinned Oracle");
  }
}

function enforceSignalPolicy(policy: SigningPolicy, req: SignalFields): void {
  enforceDeployment(policy, req.chainId, req.oracleAddress);
  const now = BigInt(policy.now());
  const oldest = now - BigInt(policy.maxTimestampAgeSeconds);
  const newest = now + BigInt(policy.maxTimestampSkewSeconds);
  if (req.timestamp < oldest || req.timestamp > newest) {
    throw new RequestRejected(
      403,
      "TIMESTAMP_OUT_OF_WINDOW",
      `timestamp ${req.timestamp.toString()} outside [${oldest.toString()}, ${newest.toString()}]`,
    );
  }
}

function failure(status: number, code: string, error: string): HandlerResult<never> {
  return { ok: false, error: { status, body: { error, code } } };
}

function rejection(err: unknown): HandlerResult<never> {
  if (err instanceof RequestRejected) return failure(err.status, err.code, err.message);
  return failure(400, "BAD_REQUEST", (err as Error).message);
}

/**
 * Write the audit record, then release `result`. If the record cannot be
 * written the caller gets 500 AUDIT_FAILED instead: no signature leaves the
 * daemon without a log line.
 */
async function audited<T>(
  ctx: HandlerContext,
  event: Omit<AuditEvent, "ts">,
  result: HandlerResult<T>,
): Promise<HandlerResult<T>> {
  try {
    await ctx.audit.record({ ts: Date.now(), ...event });
  } catch (err) {
    return failure(500, "AUDIT_FAILED", `audit log write failed: ${(err as Error).message}`);
  }
  return result;
}

async function handleSignalRoute<R extends SignalFields>(
  ctx: HandlerContext,
  policy: SigningPolicy,
  route: AuditRoute,
  body: unknown,
  source: string,
  parse: (raw: unknown) => R,
  sign: (req: R) => Promise<LedgeredSignResult>,
): Promise<HandlerResult<SignResponseBody>> {
  let req: R;
  try {
    req = parse(body);
    enforceSignalPolicy(policy, req);
  } catch (err) {
    const raw = (body as Record<string, unknown> | null)?.submitter;
    return audited(
      ctx,
      {
        route,
        outcome: "rejected",
        source,
        submitter:
          typeof raw === "string" && ADDRESS_RE.test(raw)
            ? (raw.toLowerCase() as `0x${string}`)
            : undefined,
        reason: (err as Error).message,
      },
      rejection(err),
    );
  }

  const submitter: `0x${string}` = `0x${req.submitter.toString(16).padStart(40, "0")}`;
  let result: LedgeredSignResult;
  try {
    result = await sign(req);
  } catch (err) {
    return audited(
      ctx,
      { route, outcome: "rejected", source, submitter, reason: (err as Error).message },
      failure(500, "SIGN_FAILED", (err as Error).message),
    );
  }

  const response: SignResponseBody = {
    signature: bytesToHex(result.signature),
    pubkeyX: bytesToHex(result.pubkeyX),
    pubkeyY: bytesToHex(result.pubkeyY),
    signerPubkeyHash: bytesToHex(result.signerPubkeyHash),
    payloadHash: bytesToHex(result.payloadHash),
  };
  return audited(
    ctx,
    {
      route,
      outcome: result.replayed ? "replayed" : "signed",
      source,
      payloadHash: response.payloadHash,
      submitter,
      signerPubkeyHash: response.signerPubkeyHash,
    },
    { ok: true, status: 200, body: response },
  );
}

/**
 * POST /sign. An identical retry returns the identical signature (the signing
 * ledger serves it; signing is deterministic), audited as `replayed`.
 */
export function handleSign(
  ctx: HandlerContext,
  policy: SigningPolicy,
  body: unknown,
  source: string,
): Promise<HandlerResult<SignResponseBody>> {
  const parse = (raw: unknown): SignSignalsRequest => parseSignalFields(raw, true);
  return handleSignalRoute(ctx, policy, "/sign", body, source, parse, (req) =>
    signSignalsWithReplayProtection(ctx.api, ctx.signerKey, ctx.replayDb, req),
  );
}

export async function handlePubkeyHash(
  ctx: HandlerContext,
): Promise<
  HandlerResult<{ signerPubkeyHash: `0x${string}`; pubkeyX: `0x${string}`; pubkeyY: `0x${string}` }>
> {
  const hash = await computeSignerPubkeyHash(
    ctx.api,
    ctx.signerKey.publicKeyX,
    ctx.signerKey.publicKeyY,
  );
  return {
    ok: true,
    status: 200,
    body: {
      signerPubkeyHash: bytesToHex(hash),
      pubkeyX: bytesToHex(ctx.signerKey.publicKeyX),
      pubkeyY: bytesToHex(ctx.signerKey.publicKeyY),
    },
  };
}

export function handleHealthz(): HandlerResult<{ status: "ok" }> {
  return { ok: true, status: 200, body: { status: "ok" } };
}

// ---------------------------------------------------------------------------
// Multi-signed slot signing (COMPLIANCE_MULTI_SIGNED / proof type 0x09)
// ---------------------------------------------------------------------------

export interface SignMultiRequestBody extends SignRequestBody {
  /** Slot position in the proof's signer array. MUST be in [0, MAX_PROVIDERS_MULTI). */
  slotIndex: string | number;
  /** Jurisdiction ID (0=EU, 1=US, 2=UK, 3=SG, 4=UAE). */
  jurisdictionId: string | number;
  /** Hex Field for the config Pedersen commitment. */
  configHash: string;
}

export type SignMultiResponseBody = SignResponseBody;

function parseSignMultiBody(raw: unknown): SignSlotRequest {
  const fields = parseSignalFields(raw, false);
  const body = raw as Record<string, unknown>;
  if (body.slotIndex === undefined) throw new Error("slotIndex required");
  if (body.jurisdictionId === undefined) throw new Error("jurisdictionId required");
  if (typeof body.configHash !== "string") throw new Error("configHash required (hex)");
  return {
    ...fields,
    slotIndex: asNumber(body.slotIndex, "slotIndex", MAX_PROVIDERS_MULTI - 1),
    jurisdictionId: asNumber(body.jurisdictionId, "jurisdictionId", 255),
    configHash: asBigint(body.configHash, "configHash"),
  };
}

/**
 * POST /sign-multi -- sign a single slot of a COMPLIANCE_MULTI_SIGNED bundle.
 *
 * The daemon signs ONE slot per call. Orchestration across M daemons is the
 * caller's responsibility: a 2-of-3 proof means three daemon calls with
 * `slotIndex` 0/1/2 (or any chosen positions), then assemble the bundle on
 * the prover side. Slot indices are bound into the signed digest -- a
 * signature minted for slot i will NOT verify if placed in slot j.
 *
 * The signing ledger keys on `(submitter, slot_payload_hash)`; two daemons
 * signing different slots for the same subject produce distinct digests
 * (different `slot_index`), so their records never collide.
 */
export function handleSignMulti(
  ctx: HandlerContext,
  policy: SigningPolicy,
  body: unknown,
  source: string,
): Promise<HandlerResult<SignMultiResponseBody>> {
  return handleSignalRoute(ctx, policy, "/sign-multi", body, source, parseSignMultiBody, (req) =>
    signSlotPayloadWithReplayProtection(ctx.api, ctx.signerKey, ctx.replayDb, req),
  );
}

// ---------------------------------------------------------------------------
// Credential-root signing
// ---------------------------------------------------------------------------

export interface SignCredentialRootBody {
  /** EVM chain ID where the Oracle lives. Must equal SIGNER_CHAIN_ID. */
  chainId: string | number;
  /** ERC8262Oracle deployment address (0x-prefixed hex). Must equal SIGNER_ORACLE_ADDRESS. */
  oracleAddress: string;
  /** Provider this credential tree belongs to. Must equal SIGNER_PROVIDER_ID when set. */
  providerId: string | number;
  /** New credential merkle root (0x-prefixed hex, 32 bytes). */
  root: string;
  /** IPFS / Arweave CID for the tree contents. */
  cid: string;
  /** Unix timestamp (seconds, uint64); signature invalid before this. */
  notBefore: string | number;
  /** Unix timestamp (seconds, uint64); signature invalid after this. */
  notAfter: string | number;
}

export interface SignCredentialRootResponseBody {
  signature: `0x${string}`;
  digest: `0x${string}`;
  signer: `0x${string}`;
}

function parseSignCredentialRootBody(raw: unknown): SignCredentialRootRequest {
  if (raw === null || typeof raw !== "object") throw new Error("body must be a JSON object");
  const body = raw as Record<string, unknown>;
  if (body.chainId === undefined) throw new Error("chainId required (string or number)");
  if (body.providerId === undefined) throw new Error("providerId required (string or number)");
  if (typeof body.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.root)) {
    throw new Error("root required (0x-prefixed 32-byte hex)");
  }
  if (typeof body.cid !== "string" || body.cid === "") throw new Error("cid required (string)");
  if (body.notBefore === undefined) throw new Error("notBefore required (string or number)");
  if (body.notAfter === undefined) throw new Error("notAfter required (string or number)");
  const notBefore = asBigint(body.notBefore, "notBefore");
  const notAfter = asBigint(body.notAfter, "notAfter");
  if (notBefore > U64_MAX || notAfter > U64_MAX) {
    throw new Error("notBefore and notAfter must fit in uint64");
  }
  return {
    chainId: asBigint(body.chainId, "chainId"),
    oracleAddress: asAddress(body.oracleAddress, "oracleAddress"),
    providerId: asBigint(body.providerId, "providerId"),
    root: body.root as `0x${string}`,
    cid: body.cid,
    notBefore,
    notAfter,
  };
}

function enforceCredentialRootPolicy(policy: SigningPolicy, req: SignCredentialRootRequest): void {
  enforceDeployment(policy, req.chainId, BigInt(req.oracleAddress));
  if (policy.providerId !== undefined && req.providerId !== policy.providerId) {
    throw new RequestRejected(
      403,
      "PROVIDER_MISMATCH",
      `providerId ${req.providerId.toString()} is not the pinned provider ${policy.providerId.toString()}`,
    );
  }
  if (req.notAfter < req.notBefore) {
    throw new RequestRejected(400, "BAD_RANGE", "notAfter must be >= notBefore");
  }
  const now = BigInt(policy.now());
  if (req.notAfter <= now) {
    throw new RequestRejected(403, "WINDOW_EXPIRED", "notAfter is not in the future");
  }
  const latest = now + BigInt(policy.credentialRootMaxValiditySeconds);
  if (req.notAfter > latest) {
    throw new RequestRejected(
      403,
      "VALIDITY_TOO_LONG",
      `notAfter may be at most ${String(policy.credentialRootMaxValiditySeconds)}s from now`,
    );
  }
}

export async function handleSignCredentialRoot(
  ctx: HandlerContext,
  policy: SigningPolicy,
  body: unknown,
  source: string,
): Promise<HandlerResult<SignCredentialRootResponseBody>> {
  const route = "/sign-credential-root";
  let req: SignCredentialRootRequest;
  try {
    req = parseSignCredentialRootBody(body);
  } catch (err) {
    return audited(
      ctx,
      { route, outcome: "rejected", source, reason: (err as Error).message },
      rejection(err),
    );
  }
  const credentialRoot = {
    chainId: req.chainId.toString(),
    oracleAddress: req.oracleAddress,
    providerId: req.providerId.toString(),
    root: req.root,
    cid: req.cid,
    notBefore: req.notBefore.toString(),
    notAfter: req.notAfter.toString(),
  };
  try {
    enforceCredentialRootPolicy(policy, req);
  } catch (err) {
    return audited(
      ctx,
      { route, outcome: "rejected", source, credentialRoot, reason: (err as Error).message },
      rejection(err),
    );
  }

  const result = signCredentialRoot(ctx.signerKey, req);
  const response: SignCredentialRootResponseBody = {
    signature: bytesToHex(result.signature),
    digest: bytesToHex(result.digest),
    signer: result.signer,
  };
  return audited(
    ctx,
    {
      route,
      outcome: "signed",
      source,
      payloadHash: response.digest,
      signer: result.signer,
      credentialRoot,
    },
    { ok: true, status: 200, body: response },
  );
}
