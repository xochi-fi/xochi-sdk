// The Xochi API: enrollment and shielded payment receipts, the only Xochi service the tool calls.
// The bearer is the SOURCE wallet's SIWE Member session (`XOCHI_JWT`), not the tool's: the
// binding is the source wallet's consent, and the receipt routes serve that wallet's intents. The
// token is never printed or stored by the tool.

import { z } from "zod4";

import { anyCaseEvm, anyCaseHex32, decimal } from "./corridor.js";
import type { EnrollmentChallenge, EnrollmentRequest, SignedAck } from "./enrollment.js";

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

/** The settlement a receipt challenge names, as the Worker records it (wire contract). */
const ReceiptSubjectSchema = z
  .object({
    binding_id: z.string().min(1).max(128),
    binding_digest: anyCaseHex32,
    terms_digest: anyCaseHex32,
    operation_id: anyCaseHex32,
    network: z
      .object({
        aztecChainId: decimal,
        protocolVersion: decimal,
        rollupAddress: anyCaseEvm,
        l1ChainId: decimal,
        genesisOrNetworkDigest: anyCaseHex32,
      })
      .strict(),
    aztec_token: anyCaseHex32,
    aztec_recipient: anyCaseHex32,
    /** The terms' exact destination amount in base units. */
    amount: decimal,
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

const INTENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** An intent id safe as one route segment and one file name. */
export function assertIntentId(intentId: string): string {
  if (!INTENT_ID.test(intentId)) {
    throw new Error("intent id must be 1-128 letters, digits, '-' or '_'");
  }
  return intentId;
}

export class EnrollmentApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    route: string,
  ) {
    super(`${route} answered ${status}: ${body.slice(0, 300)}`);
    this.name = "EnrollmentApiError";
  }
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

export class HttpEnrollmentApi implements EnrollmentApi, ReceiptApi {
  constructor(
    private readonly baseUrl: string,
    private readonly jwt: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.origin !== "https://api.xochi.fi") {
      throw new Error(`enrollment API must be https://api.xochi.fi (got ${url.origin})`);
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
    const response = await this.fetchImpl(new URL(route, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.jwt}`,
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

/** What a dry-run receipt challenge names: this data directory's own recipient and corridor. */
export type DryRunReceiptSubject = Pick<
  ReceiptSubject,
  "binding_id" | "aztec_recipient" | "aztec_token" | "network"
>;

/**
 * Records the calls and their bodies' shape; answers as a fresh enrollment would, and issues a
 * synthetic receipt challenge (for 1 base unit) for `receiptSubject`.
 */
export class DryRunEnrollmentApi implements EnrollmentApi, ReceiptApi {
  readonly calls: string[] = [];
  private descriptorDigest: string | null;
  constructor(
    private readonly now: number,
    descriptorDigest: string | null = null,
    private readonly receiptSubject: DryRunReceiptSubject | null = null,
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
    this.calls.push(`POST ${route} {} (synthetic challenge for 1 base unit)`);
    if (!this.receiptSubject) throw new Error("dry-run receipt challenge needs its subject");
    return {
      challenge_id: "dry-run-receipt-challenge",
      nonce: `0x${"0f".repeat(32)}`,
      expires_at: this.now + 300,
      receipt: {
        ...this.receiptSubject,
        binding_digest: `0x${"0b".repeat(32)}`,
        terms_digest: `0x${"07".repeat(32)}`,
        operation_id: `0x${"0d".repeat(32)}`,
        amount: "1",
      },
    };
  }

  async submitReceipt(intentId: string, body: ReceiptSubmission): Promise<ReceiptResult> {
    this.calls.push(
      `POST /api/shielded/operations/${assertIntentId(intentId)}/receipt { challenge_id, acknowledgement: ${body.acknowledgement.primary_type} } (synthetic: completed)`,
    );
    return { intent_id: intentId, status: "completed", receipt_digest: `0x${"00".repeat(32)}` };
  }
}
