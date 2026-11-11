/**
 * Submit a signed stealth claim, and keep resubmitting the SAME signed op while
 * its outcome is not known.
 *
 * Riddler bounds its wait for the claim's receipt (Riddler #1124). When the
 * bundler has accepted the op but it is not mined inside that wait, the worker
 * answers 503 `error_category: claim_pending` with `opHash` + `retryAfter`. The
 * op is in the mempool and will execute; resubmitting the same `userOpHash` +
 * signature POLLS it (it is never resent) and answers 200 once the receipt is
 * seen. Preparing or signing again instead would sponsor a second op for an
 * account whose first op is about to land.
 *
 * Two windows bound the poll, as they bound the server:
 *
 *   - Until the first pending answer, the prepare window (`deps.deadline`,
 *     measured from before the prepare request).
 *   - From the first pending answer, {@link CLAIM_PENDING_WINDOW_MS} from the
 *     START of the request that returned it. Riddler keeps a broadcast op
 *     pollable for 5 minutes from the broadcast, and the worker's session for 5
 *     minutes from its first pending answer. The broadcast happens inside that
 *     request, so its start is never later than either, and this deadline
 *     falls inside both.
 *
 * A 5xx other than `claim_pending`, or a transport error or timeout, says
 * nothing about the op: the worker abandons Riddler at 15s, and a slow bundler
 * send plus Riddler's 10s receipt wait can outrun that after the op was
 * broadcast. Resubmitting is safe either way -- a broadcast op is polled, an
 * unsent one is sent once -- so such an answer is retried, at most
 * {@link MAX_UNKNOWN_OUTCOME_RETRIES} times before anything pends (a real outage
 * should surface, not spin for five minutes) and for as long as the window lasts
 * once the op is known to be in flight.
 *
 * Once it is in flight, only a 200 settles it. Any other terminal answer -- a
 * 410 because a window closed, a 409 -- ends as `unconfirmed`, never `failed`:
 * the op may still land, and "failed" invites a new claim that competes with it
 * for the account's nonce.
 */

import { StealthClaimPendingBodySchema } from "@xochi/client";
import type { Result } from "../types/result.js";

export const CLAIM_SUBMIT_ENDPOINT = "/api/stealth/claim/submit";

/**
 * How long a prepared claim can be submitted before anything pends. Mirrors the
 * worker's `CLAIM_SESSION_TTL_SEC` and Riddler's prepared-op expiry, both
 * measured from the prepare.
 */
export const CLAIM_PREPARE_WINDOW_MS = 300_000;

/**
 * How long a pending op can be polled, from the start of the request that first
 * answered `claim_pending`. Mirrors Riddler's broadcast-time expiry and the
 * worker's `pending_at` window.
 */
export const CLAIM_PENDING_WINDOW_MS = 300_000;

/**
 * Resubmits after an unknown outcome (5xx, transport error, timeout) before the
 * op is known to be in flight. If the op WAS broadcast, the first resubmit
 * finds Riddler's broadcast mark and answers pending or 200; two leaves room
 * for one more slow answer without turning an outage into a five-minute spin.
 */
export const MAX_UNKNOWN_OUTCOME_RETRIES = 2;

/**
 * Floor on the gap between polls. Submit is metered at 12/min per wallet
 * (`WALLET_RATE_LIMITS.claim_submit`); honouring a 5s `retryAfter` against an
 * instant answer would be 12 in a minute plus the first submit, one over. 6s
 * keeps a full window of polling under the ceiling.
 */
export const MIN_CLAIM_POLL_INTERVAL_MS = 6_000;

/**
 * Per-request timeout for a submit. Above the worker's own 15s budget for the
 * Riddler call, so the answer that budget produces -- pending or unavailable --
 * reaches this client instead of racing its timeout.
 */
export const CLAIM_SUBMIT_TIMEOUT_MS = 20_000;

export interface ClaimSubmitBody {
  userOpHash: string;
  signature: string;
}

export interface ClaimSubmitted {
  txHash: string;
  opHash: string;
  blockNumber?: number;
}

export type ClaimSubmitOutcome =
  | { kind: "submitted"; data: ClaimSubmitted }
  | { kind: "failed"; error: string; errorCategory?: string; status?: number }
  /**
   * Accepted by the bundler and still unconfirmed when polling ended -- its
   * window ran out, or the server stopped answering for it. The op may yet
   * land, so this is not a failure either; a new claim is safe only because the
   * account nonce lets at most one op execute.
   */
  | { kind: "unconfirmed"; opHash: string };

export interface ClaimSubmitPollDeps {
  post: (
    endpoint: string,
    body: ClaimSubmitBody,
    options: { timeout: number },
  ) => Promise<Result<ClaimSubmitted>>;
  /**
   * Epoch ms after which no further resubmit is sent, until the first pending
   * answer replaces it with that answer's {@link CLAIM_PENDING_WINDOW_MS}.
   */
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called on every pending answer, before the wait. */
  onPending?: (opHash: string) => void;
}

export async function submitClaimUntilSettled(
  body: ClaimSubmitBody,
  deps: ClaimSubmitPollDeps,
): Promise<ClaimSubmitOutcome> {
  let deadline = deps.deadline;
  let inFlight: string | undefined;
  let unknownRetries = 0;

  for (;;) {
    const startedAt = deps.now();
    const result = await deps.post(CLAIM_SUBMIT_ENDPOINT, body, {
      timeout: CLAIM_SUBMIT_TIMEOUT_MS,
    });
    if (result.success) return { kind: "submitted", data: result.data };

    let waitMs: number;
    if (result.errorCategory === "claim_pending") {
      // The category is what makes it pending; the body only tunes the wait. A
      // body that does not parse keeps the floor and the hash we submitted.
      const parsed = StealthClaimPendingBodySchema.safeParse(result.body);
      if (inFlight === undefined) deadline = startedAt + CLAIM_PENDING_WINDOW_MS;
      inFlight = parsed.success ? parsed.data.opHash : body.userOpHash;
      waitMs = Math.max(
        parsed.success ? parsed.data.retryAfter * 1000 : 0,
        MIN_CLAIM_POLL_INTERVAL_MS,
      );
      deps.onPending?.(inFlight);
    } else if (inFlight !== undefined && (outcomeUnknown(result) || result.status === 429)) {
      // In flight: a blip, or the poll's own pacing, says nothing about the op.
      waitMs = MIN_CLAIM_POLL_INTERVAL_MS;
    } else if (
      inFlight === undefined &&
      outcomeUnknown(result) &&
      unknownRetries < MAX_UNKNOWN_OUTCOME_RETRIES
    ) {
      unknownRetries += 1;
      waitMs = MIN_CLAIM_POLL_INTERVAL_MS;
    } else if (inFlight !== undefined) {
      return { kind: "unconfirmed", opHash: inFlight };
    } else {
      return failed(result);
    }

    if (deps.now() + waitMs >= deadline) {
      return inFlight === undefined ? failed(result) : { kind: "unconfirmed", opHash: inFlight };
    }
    await deps.sleep(waitMs);
  }
}

/** A server error or no answer at all: nothing about the op follows from it. */
function outcomeUnknown(result: { status?: number }): boolean {
  return result.status === undefined || result.status >= 500;
}

function failed(result: {
  error: string;
  errorCategory?: string;
  status?: number;
}): ClaimSubmitOutcome {
  return {
    kind: "failed",
    error: result.error,
    errorCategory: result.errorCategory,
    status: result.status,
  };
}
