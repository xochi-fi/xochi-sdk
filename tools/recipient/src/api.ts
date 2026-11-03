// The Xochi enrollment API, the only Xochi service the tool calls. The bearer is the SOURCE
// wallet's SIWE Member session (`XOCHI_JWT`), not the tool's: the binding is the source wallet's
// consent. The token is never printed or stored by the tool.

import { z } from "zod4";

import type { EnrollmentChallenge, EnrollmentRequest } from "./enrollment.js";

const ChallengeSchema = z
  .object({
    challenge_id: z.string().min(1).max(128),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expires_at: z.number().int().positive(),
  })
  .strict();

const ProjectionSchema = z
  .object({
    binding_id: z.string().min(1).max(128),
    descriptor_digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    state: z.enum(["pending", "ready", "revoked"]),
    policy_revision: z.number().int(),
  })
  .strict();
export type BindingProjection = z.infer<typeof ProjectionSchema>;

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

export class HttpEnrollmentApi implements EnrollmentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly jwt: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error(`enrollment API must be https (got ${url.protocol}//${url.hostname})`);
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
}

/** Records the calls and their bodies' shape; answers as a fresh enrollment would. */
export class DryRunEnrollmentApi implements EnrollmentApi {
  readonly calls: string[] = [];
  constructor(private readonly now: number) {}

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
      descriptor_digest: `0x${"00".repeat(32)}`,
      state: "pending",
      policy_revision: 1,
    };
  }
}
