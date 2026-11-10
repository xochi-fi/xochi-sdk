// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { z } from "zod";

export const StealthClaimPendingBodySchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    error_category: z.literal("claim_pending"),
    opHash: z
      .string()
      .describe("ERC-4337 op hash the bundler accepted. Informational: resubmit by `userOpHash`."),
    retryAfter: z
      .number()
      .int()
      .positive()
      .describe(
        "Seconds to wait before resubmitting the SAME userOpHash + signature to poll the op. Same value as the Retry-After header. Do not prepare or sign again while it is pending: the first pending answer keeps the claim pollable for 5 minutes from that answer.",
      ),
  })
  .strict();
export type StealthClaimPendingBody = z.infer<typeof StealthClaimPendingBodySchema>;
