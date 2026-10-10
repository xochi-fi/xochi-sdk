/**
 * @xochi/client: a client for the Xochi trade API (`https://api.xochi.fi/api/*`).
 *
 * - The wire contract and shared vocabulary (chains, statuses, schemas).
 * - The trade lifecycle as a pure state machine: `update(model, msg)`.
 * - A transport over the Worker API: `createXochiClient`.
 * - Pre-sign fund-safety checks, from `@xochi/signer`, run by the machine at
 *   quote ingest and exported for hosts that drive their own flow.
 * - The layered fee reference (SPEC.md Section 4): the published schedule, the
 *   deterministic breakdown it implies, and the reconciliation check a served
 *   `fee_breakdown` must pass.
 */

export * from "./shared/index.js";
export * from "./machine/index.js";
export * from "./transport/client.js";
export * from "./claim.js";
export * from "./fee.js";
export type { MethodPin, PinnedPullRecipients, PreparedClaim } from "@xochi/signer";
