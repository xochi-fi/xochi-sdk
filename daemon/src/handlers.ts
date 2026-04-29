/**
 * Request handlers for the signing daemon.
 *
 * Two endpoints:
 *   POST /sign          -- compute a signed-signals bundle for a request body
 *   GET  /pubkey-hash   -- return the daemon's signer_pubkey_hash for registration
 *   GET  /healthz       -- liveness check
 */

import type { Barretenberg } from "@aztec/bb.js";
import type { ReplayDb, SignerKey, SignSignalsRequest } from "../../src/provider/index.js";
import {
  bytesToHex,
  ReplayDetected,
  signSignalsWithReplayProtection,
  computeSignerPubkeyHash,
} from "../../src/provider/index.js";
import {
  signCredentialRoot,
  type SignCredentialRootRequest,
} from "../../src/provider/credential-root-signer.js";
import type { AuditSink } from "./audit.js";

export interface HandlerContext {
  api: Barretenberg;
  signerKey: SignerKey;
  replayDb: ReplayDb;
  audit: AuditSink;
}

export interface SignRequestBody {
  /** Hex Field for the (provider_ids, weights) Pedersen commitment. */
  providerSetHash: string;
  /** 8 numeric strings or numbers (zero-padded). */
  signals: Array<string | number>;
  /** 8 numeric strings or numbers. */
  weights: Array<string | number>;
  /** Numeric string or number; seconds since epoch. */
  timestamp: string | number;
  /** Hex address (uint160 Field) of the proof submitter. */
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

function asBigint(value: string | number, label: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be non-negative integer; got ${String(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be string or number`);
  }
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be decimal or 0x-hex; got ${value}`);
  }
  return BigInt(value);
}

function parseSignBody(raw: unknown): SignSignalsRequest {
  if (raw === null || typeof raw !== "object") {
    throw new Error("body must be a JSON object");
  }
  const body = raw as Partial<SignRequestBody>;

  if (typeof body.providerSetHash !== "string") throw new Error("providerSetHash required (hex)");
  if (!Array.isArray(body.signals) || body.signals.length !== 8) {
    throw new Error("signals must be an array of length 8");
  }
  if (!Array.isArray(body.weights) || body.weights.length !== 8) {
    throw new Error("weights must be an array of length 8");
  }
  if (typeof body.timestamp !== "string" && typeof body.timestamp !== "number") {
    throw new Error("timestamp required (string or number)");
  }
  if (typeof body.submitter !== "string") throw new Error("submitter required (hex)");

  return {
    providerSetHash: asBigint(body.providerSetHash, "providerSetHash"),
    signals: body.signals.map((s, i) => asBigint(s, `signals[${String(i)}]`)),
    weights: body.weights.map((w, i) => asBigint(w, `weights[${String(i)}]`)),
    timestamp: asBigint(body.timestamp, "timestamp"),
    submitter: asBigint(body.submitter, "submitter"),
  };
}

export async function handleSign(
  ctx: HandlerContext,
  body: unknown,
  source: string,
): Promise<HandlerResult<SignResponseBody>> {
  let req: SignSignalsRequest;
  try {
    req = parseSignBody(body);
  } catch (err) {
    return {
      ok: false,
      error: { status: 400, body: { error: (err as Error).message, code: "BAD_REQUEST" } },
    };
  }

  try {
    const result = await signSignalsWithReplayProtection(ctx.api, ctx.signerKey, ctx.replayDb, req);
    const response: SignResponseBody = {
      signature: bytesToHex(result.signature),
      pubkeyX: bytesToHex(result.pubkeyX),
      pubkeyY: bytesToHex(result.pubkeyY),
      signerPubkeyHash: bytesToHex(result.signerPubkeyHash),
      payloadHash: bytesToHex(result.payloadHash),
    };

    ctx.audit.record({
      ts: Date.now(),
      payloadHash: response.payloadHash,
      submitter: ("0x" + req.submitter.toString(16).padStart(64, "0")) as `0x${string}`,
      signerPubkeyHash: response.signerPubkeyHash,
      outcome: "signed",
      source,
    });
    return { ok: true, status: 200, body: response };
  } catch (err) {
    const submitterHex = ("0x" + req.submitter.toString(16).padStart(64, "0")) as `0x${string}`;
    if (err instanceof ReplayDetected) {
      ctx.audit.record({
        ts: Date.now(),
        payloadHash: err.payloadHashHex as `0x${string}`,
        submitter: submitterHex,
        signerPubkeyHash: "0x" + "0".repeat(64),
        outcome: "replayed",
        source,
      } as never);
      return {
        ok: false,
        error: { status: 409, body: { error: "duplicate signing request", code: "REPLAY" } },
      };
    }
    ctx.audit.record({
      ts: Date.now(),
      payloadHash: "0x" + "0".repeat(64),
      submitter: submitterHex,
      signerPubkeyHash: "0x" + "0".repeat(64),
      outcome: "rejected",
      source,
      reason: (err as Error).message,
    } as never);
    return {
      ok: false,
      error: { status: 500, body: { error: (err as Error).message, code: "SIGN_FAILED" } },
    };
  }
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
// Credential-root signing
// ---------------------------------------------------------------------------

export interface SignCredentialRootBody {
  /** EVM chain ID where the Oracle lives. */
  chainId: string | number;
  /** XochiZKPOracle deployment address (0x-prefixed hex). */
  oracleAddress: string;
  /** Provider this credential tree belongs to. */
  providerId: string | number;
  /** New credential merkle root (0x-prefixed hex, 32 bytes). */
  root: string;
  /** IPFS / Arweave CID for the tree contents. */
  cid: string;
  /** Unix timestamp (seconds); signature invalid before this. */
  notBefore: string | number;
  /** Unix timestamp (seconds); signature invalid after this. */
  notAfter: string | number;
}

export interface SignCredentialRootResponseBody {
  signature: `0x${string}`;
  digest: `0x${string}`;
  signer: `0x${string}`;
}

function parseSignCredentialRootBody(raw: unknown): SignCredentialRootRequest {
  if (raw === null || typeof raw !== "object") throw new Error("body must be a JSON object");
  const body = raw as Partial<SignCredentialRootBody>;
  if (typeof body.chainId !== "string" && typeof body.chainId !== "number") {
    throw new Error("chainId required (string or number)");
  }
  if (typeof body.oracleAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.oracleAddress)) {
    throw new Error("oracleAddress required (0x-prefixed 20-byte hex)");
  }
  if (typeof body.providerId !== "string" && typeof body.providerId !== "number") {
    throw new Error("providerId required (string or number)");
  }
  if (typeof body.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.root)) {
    throw new Error("root required (0x-prefixed 32-byte hex)");
  }
  if (typeof body.cid !== "string") throw new Error("cid required (string)");
  if (typeof body.notBefore !== "string" && typeof body.notBefore !== "number") {
    throw new Error("notBefore required (string or number)");
  }
  if (typeof body.notAfter !== "string" && typeof body.notAfter !== "number") {
    throw new Error("notAfter required (string or number)");
  }
  return {
    chainId: BigInt(body.chainId),
    oracleAddress: body.oracleAddress as `0x${string}`,
    providerId: BigInt(body.providerId),
    root: body.root as `0x${string}`,
    cid: body.cid,
    notBefore: BigInt(body.notBefore),
    notAfter: BigInt(body.notAfter),
  };
}

export function handleSignCredentialRoot(
  ctx: HandlerContext,
  body: unknown,
  source: string,
): HandlerResult<SignCredentialRootResponseBody> {
  let req: SignCredentialRootRequest;
  try {
    req = parseSignCredentialRootBody(body);
  } catch (err) {
    return {
      ok: false,
      error: { status: 400, body: { error: (err as Error).message, code: "BAD_REQUEST" } },
    };
  }

  if (req.notAfter < req.notBefore) {
    return {
      ok: false,
      error: { status: 400, body: { error: "notAfter must be >= notBefore", code: "BAD_RANGE" } },
    };
  }

  const result = signCredentialRoot(ctx.signerKey, req);
  const response: SignCredentialRootResponseBody = {
    signature: bytesToHex(result.signature),
    digest: bytesToHex(result.digest),
    signer: result.signer,
  };

  ctx.audit.record({
    ts: Date.now(),
    payloadHash: response.digest,
    submitter: ("0x" + req.providerId.toString(16).padStart(64, "0")) as `0x${string}`,
    signerPubkeyHash: ("0x" + result.signer.slice(2).padStart(64, "0")) as `0x${string}`,
    outcome: "signed",
    source,
  });
  return { ok: true, status: 200, body: response };
}
