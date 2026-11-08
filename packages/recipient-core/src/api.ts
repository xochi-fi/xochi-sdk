// The Xochi API: enrollment and shielded payment receipts, the only Xochi service the tool calls.
// The bearer is the SOURCE wallet's SIWE Member session (`XOCHI_JWT`), not the tool's: the
// binding is the source wallet's consent, and the receipt routes serve that wallet's intents. The
// token is never printed or stored by the tool.

import { z } from "zod4";

import { anyCaseEvm, anyCaseHex32, decimal } from "./corridor.js";
import type { EnrollmentChallenge, EnrollmentRequest, SignedAck } from "./enrollment.js";
import type { HttpFetch } from "./ports.js";

const ChallengeSchema = z
  .object({
    challenge_id: z.string().min(1).max(128),
    nonce: anyCaseHex32,
    expires_at: z.number().int().positive(),
  })
  .strict();

const ProjectionSchema = z
  .object({
    binding_id: z.string().min(1).max(128),
    descriptor_digest: anyCaseHex32,
    state: z.enum(["pending", "ready", "revoked"]),
    policy_revision: z.number().int(),
  })
  .strict();
export type BindingProjection = z.infer<typeof ProjectionSchema>;

const NetworkIdentitySchema = z
  .object({
    aztecChainId: decimal,
    protocolVersion: decimal,
    rollupAddress: anyCaseEvm,
    l1ChainId: decimal,
    genesisOrNetworkDigest: anyCaseHex32,
  })
  .strict();

/**
 * The intent's ShieldedTermsV1 typed data, verbatim as Xochi stored it (`signed_eip712`
 * `.terms`). Only its envelope is checked here: `receipt.ts` refuses, by name, any types,
 * domain or message that are not ShieldedTermsV1's before hashing it against `terms_digest`.
 */
const ReceiptTermsSchema = z
  .object({
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }).strict())),
    primaryType: z.string(),
    domain: z.record(z.string(), z.unknown()),
    message: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ReceiptTerms = z.infer<typeof ReceiptTermsSchema>;

/** The settlement a receipt challenge names, as the Worker records it (wire contract). */
const ReceiptSubjectSchema = z
  .object({
    binding_id: z.string().min(1).max(128),
    binding_digest: anyCaseHex32,
    terms_digest: anyCaseHex32,
    operation_id: anyCaseHex32,
    network: NetworkIdentitySchema,
    aztec_token: anyCaseHex32,
    aztec_recipient: anyCaseHex32,
    /** The terms' exact destination amount in base units. */
    amount: decimal,
    terms: ReceiptTermsSchema,
  })
  .strict();
export type ReceiptSubject = z.infer<typeof ReceiptSubjectSchema>;

const ReceiptChallengeSchema = z
  .object({
    challenge_id: z.string().min(1).max(128),
    nonce: anyCaseHex32,
    expires_at: z.number().int().positive(),
    receipt: ReceiptSubjectSchema,
  })
  .strict();
/** `POST /api/shielded/operations/:intentId/receipt/challenge` 201 body. */
export type ReceiptChallenge = z.infer<typeof ReceiptChallengeSchema>;

const ReceiptResultSchema = z
  .object({
    intent_id: z.string().min(1).max(128),
    status: z.literal("completed"),
    receipt_digest: anyCaseHex32,
  })
  .strict();
/** `POST /api/shielded/operations/:intentId/receipt` 200 body. */
export type ReceiptResult = z.infer<typeof ReceiptResultSchema>;

/** `POST /api/shielded/operations/:intentId/receipt` request body. */
export interface ReceiptSubmission {
  challenge_id: string;
  acknowledgement: SignedAck;
}

/**
 * The core's intent ids (contract C): one route segment and one storage key segment. Covers the
 * Worker's route grammar `^[a-z0-9_]{1,64}$` (`xi_<32 hex>`); the claim URL's wider grammar
 * (contract E) is refused here, never mapped.
 */
export const INTENT_ID_GRAMMAR = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

/** An intent id safe as one route segment and one storage key segment. */
export function assertIntentId(intentId: string): string {
  if (!INTENT_ID_GRAMMAR.test(intentId)) {
    throw new Error(
      "intent id must be 1-64 characters of a-z, 0-9, '_' and '-', not starting with '-'",
    );
  }
  return intentId;
}

/**
 * The receipt refusals that reject the signed acknowledgement or its challenge outright, so a
 * fresh challenge may replace it (`error_category`, wire contract): never a 401/403/408/429/5xx,
 * nor `payout_not_final` or `receipt_tx_conflict`. `receipt_challenge_unknown` is a challenge the
 * Worker purged unconsumed (or never issued): nothing was accepted under it.
 */
const RECEIPT_REJECTIONS: Readonly<Record<string, number>> = {
  receipt_challenge_expired: 410,
  receipt_challenge_consumed: 409,
  receipt_ack_rejected: 409,
  receipt_challenge_unknown: 400,
};

/**
 * The enrollment refusals that reject the request outright, so a new request may replace the
 * kept one (`error_category`, wire contract `ENROLLMENT_ERROR_CATEGORIES`): never a
 * 401/403/408/429/5xx. The Worker categorizes only `passkey_recipient_mismatch` so far; its other
 * refusals name no category and keep the request (`rejectsExpiredEnrollment` covers them once its
 * challenge has expired).
 */
const ENROLLMENT_REJECTIONS: Readonly<Record<string, number>> = {
  passkey_recipient_mismatch: 409,
};

export class EnrollmentApiError extends Error {
  /** The Worker's `error_category`, or null when the body names none. */
  readonly category: string | null;

  constructor(
    readonly status: number,
    readonly body: string,
    route: string,
  ) {
    super(`${route} answered ${status}: ${body.slice(0, 300)}`);
    this.name = "EnrollmentApiError";
    this.category = errorCategory(body);
  }

  /** True only when Xochi rejected the receipt's acknowledgement or challenge outright. */
  get rejectsReceipt(): boolean {
    return this.rejectedBy(RECEIPT_REJECTIONS);
  }

  /** True only when Xochi rejected the enrollment request outright. */
  get rejectsEnrollment(): boolean {
    return this.rejectedBy(ENROLLMENT_REJECTIONS);
  }

  /**
   * For a request whose challenge has expired, also the Worker's uncategorized 400 (challenge
   * expired or unknown, request invalid) and 409 (challenge consumed by another binding): an
   * expired challenge enrolls nothing new, and the Worker answers the request a consumed one
   * enrolled with its binding, so neither answer leaves anything this request could still enroll.
   */
  get rejectsExpiredEnrollment(): boolean {
    return this.rejectsEnrollment || this.status === 400 || this.status === 409;
  }

  private rejectedBy(rejections: Readonly<Record<string, number>>): boolean {
    return this.category !== null && rejections[this.category] === this.status;
  }
}

function errorCategory(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A non-JSON body (a proxy's error page) names no category; the status still reports it.
    return null;
  }
  const result = z.object({ error_category: z.string() }).safeParse(parsed);
  return result.success ? result.data.error_category : null;
}

export interface EnrollmentApi {
  challenge(): Promise<EnrollmentChallenge>;
  enroll(request: EnrollmentRequest): Promise<BindingProjection>;
  projection(bindingId: string): Promise<BindingProjection>;
}

export interface ReceiptApi {
  requestReceiptChallenge(intentId: string): Promise<ReceiptChallenge>;
  submitReceipt(intentId: string, body: ReceiptSubmission): Promise<ReceiptResult>;
}

/** The only Xochi API origin the client sends the source-wallet bearer to; the default. */
export const XOCHI_API_URL = "https://api.xochi.fi";

export class HttpEnrollmentApi implements EnrollmentApi, ReceiptApi {
  /**
   * `jwt` is the source wallet's SIWE session, or a provider of it read per call (never stored
   * by the core). `fetchImpl` defaults to the global `fetch`, read at call time.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly jwt: string | (() => Promise<string>),
    private readonly fetchImpl?: HttpFetch,
  ) {
    const url = new URL(baseUrl);
    if (url.origin !== XOCHI_API_URL) {
      throw new Error(`enrollment API must be ${XOCHI_API_URL} (got ${url.origin})`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error("enrollment API URL must not contain a path, query or fragment");
    }
  }

  private async call<T>(
    method: string,
    route: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const bearer = typeof this.jwt === "string" ? this.jwt : await this.jwt();
    // Called unbound: a browser's `fetch` refuses any other `this` than the global.
    const send = this.fetchImpl ?? fetch;
    const response = await send(new URL(route, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new EnrollmentApiError(response.status, text, `${method} ${route}`);
    return schema.parse(JSON.parse(text));
  }

  challenge(): Promise<EnrollmentChallenge> {
    return this.call("POST", "/api/shielded/recipients/challenge", {}, ChallengeSchema);
  }

  enroll(request: EnrollmentRequest): Promise<BindingProjection> {
    return this.call("POST", "/api/shielded/recipients", request, ProjectionSchema);
  }

  projection(bindingId: string): Promise<BindingProjection> {
    return this.call(
      "GET",
      `/api/shielded/recipients/${encodeURIComponent(bindingId)}`,
      undefined,
      ProjectionSchema,
    );
  }

  async requestReceiptChallenge(intentId: string): Promise<ReceiptChallenge> {
    return this.call(
      "POST",
      `/api/shielded/operations/${assertIntentId(intentId)}/receipt/challenge`,
      {},
      ReceiptChallengeSchema,
    );
  }

  async submitReceipt(intentId: string, body: ReceiptSubmission): Promise<ReceiptResult> {
    return this.call(
      "POST",
      `/api/shielded/operations/${assertIntentId(intentId)}/receipt`,
      body,
      ReceiptResultSchema,
    );
  }
}

/**
 * Records the calls and their bodies' shape; answers as a fresh enrollment would. It issues no
 * receipt challenge: a challenge carries the intent's terms signed by the source wallet, which a
 * dry run cannot synthesize (the dry-run PXE discovers no payout, so `receipt` stops before it).
 */
export class DryRunEnrollmentApi implements EnrollmentApi, ReceiptApi {
  readonly calls: string[] = [];
  private descriptorDigest: string | null;
  constructor(
    private readonly now: number,
    descriptorDigest: string | null = null,
  ) {
    this.descriptorDigest = descriptorDigest;
  }

  async challenge(): Promise<EnrollmentChallenge> {
    this.calls.push("POST /api/shielded/recipients/challenge {} (synthetic challenge)");
    return {
      challenge_id: "dry-run-challenge",
      nonce: `0x${"0e".repeat(32)}`,
      expires_at: this.now + 300,
    };
  }

  async enroll(request: EnrollmentRequest): Promise<BindingProjection> {
    this.calls.push(
      `POST /api/shielded/recipients { challenge_id, binding, source_signature, descriptor, recipient_authorization, acknowledgements: [${request.acknowledgements.map((a) => a.primary_type).join(", ")}] } (synthetic: pending)`,
    );
    this.descriptorDigest = request.binding["descriptorDigest"]!;
    return {
      binding_id: "dry-run-binding",
      descriptor_digest: request.binding["descriptorDigest"]!,
      state: "pending",
      policy_revision: 1,
    };
  }

  async projection(bindingId: string): Promise<BindingProjection> {
    this.calls.push(`GET /api/shielded/recipients/${bindingId} (synthetic: pending)`);
    return {
      binding_id: bindingId,
      descriptor_digest:
        this.descriptorDigest ??
        (() => {
          throw new Error("dry-run projection requested before enrollment");
        })(),
      state: "pending",
      policy_revision: 1,
    };
  }

  async requestReceiptChallenge(intentId: string): Promise<ReceiptChallenge> {
    const route = `/api/shielded/operations/${assertIntentId(intentId)}/receipt/challenge`;
    this.calls.push(`POST ${route} {} (not synthesized)`);
    throw new Error("a dry run cannot synthesize a receipt challenge: its terms are signed");
  }

  async submitReceipt(intentId: string, _body: ReceiptSubmission): Promise<ReceiptResult> {
    this.calls.push(`POST /api/shielded/operations/${assertIntentId(intentId)}/receipt`);
    throw new Error("a dry run cannot submit a receipt: it has no receipt challenge");
  }
}
