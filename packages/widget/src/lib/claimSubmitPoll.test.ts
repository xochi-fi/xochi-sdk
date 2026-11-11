import { describe, it, expect } from "vitest";
import { err, ok, type Result } from "../types/result.js";
import {
  CLAIM_PENDING_WINDOW_MS,
  CLAIM_PREPARE_WINDOW_MS,
  CLAIM_SUBMIT_ENDPOINT,
  MAX_UNKNOWN_OUTCOME_RETRIES,
  MIN_CLAIM_POLL_INTERVAL_MS,
  submitClaimUntilSettled,
  type ClaimSubmitBody,
  type ClaimSubmitted,
} from "./claimSubmitPoll.js";

const BODY: ClaimSubmitBody = {
  userOpHash: "0x" + "c".repeat(64),
  signature: "0x" + "a".repeat(130),
};
const OP_HASH = "0x" + "d".repeat(64);
const LANDED: ClaimSubmitted = { txHash: "0x" + "e".repeat(64), opHash: OP_HASH };

/** The worker's 503 claim_pending, as `apiFetch` surfaces it. */
const pending = (retryAfter: number): Result<ClaimSubmitted> =>
  err("Your claim was sent and is waiting to be confirmed on-chain.", {
    status: 503,
    errorCategory: "claim_pending",
    body: {
      success: false,
      error: "Your claim was sent and is waiting to be confirmed on-chain.",
      error_category: "claim_pending",
      opHash: OP_HASH,
      retryAfter,
    },
  });

/** The worker's generic 503: Riddler unreachable, errored, or timed out. */
const unavailable = (): Result<ClaimSubmitted> =>
  err("Claims are temporarily unavailable. Please try again shortly.", {
    status: 503,
    errorCategory: "claim_service_unavailable",
  });

/** The worker's own 410, or Riddler's `claim_expired` relayed as one. */
const expired = (): Result<ClaimSubmitted> =>
  err("The claim took too long to finish. Please start it again.", {
    status: 410,
    errorCategory: "claim_expired",
  });

/**
 * A scripted server on a fake clock: each post returns the next answer and
 * costs `requestMs` of wall time (Riddler's bounded receipt wait); `sleep`
 * advances the clock and returns at once. Nothing touches the network.
 * `prepareWindowLeftMs` is how much of the prepare window remains when the
 * first submit is sent -- short when the user took a long time to sign.
 */
function harness(
  answers: Array<Result<ClaimSubmitted>>,
  requestMs = 0,
  prepareWindowLeftMs = CLAIM_PREPARE_WINDOW_MS,
) {
  let clock = 1_000_000;
  const posts: Array<{ endpoint: string; body: ClaimSubmitBody }> = [];
  const sleeps: number[] = [];
  const pendings: string[] = [];
  const deps = {
    post: async (endpoint: string, body: ClaimSubmitBody) => {
      posts.push({ endpoint, body });
      clock += requestMs;
      const next = answers.shift();
      if (!next) throw new Error("submitted past the scripted answers");
      return next;
    },
    deadline: clock + prepareWindowLeftMs,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    onPending: (opHash: string) => pendings.push(opHash),
  };
  return { deps, posts, sleeps, pendings };
}

describe("submitClaimUntilSettled", () => {
  it("resubmits the same signed op while pending and stops on success", async () => {
    const h = harness([pending(8), pending(8), ok(LANDED)]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "submitted", data: LANDED });
    // Every attempt is the original body: the op is polled, never re-signed.
    expect(h.posts).toEqual([
      { endpoint: CLAIM_SUBMIT_ENDPOINT, body: BODY },
      { endpoint: CLAIM_SUBMIT_ENDPOINT, body: BODY },
      { endpoint: CLAIM_SUBMIT_ENDPOINT, body: BODY },
    ]);
    // Waits honour the server's retryAfter.
    expect(h.sleeps).toEqual([8_000, 8_000]);
    expect(h.pendings).toEqual([OP_HASH, OP_HASH]);
  });

  it("reports a 410 after a pending answer as unconfirmed, not failed", async () => {
    // The op is in the mempool whichever window closed; "failed" would invite a
    // new claim competing with it for the account nonce.
    const h = harness([pending(5), expired()]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "unconfirmed", opHash: OP_HASH });
    expect(h.posts).toHaveLength(2);
  });

  it("fails a 410 that arrives before anything pended, without another submit", async () => {
    const h = harness([expired()]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({
      kind: "failed",
      error: "The claim took too long to finish. Please start it again.",
      errorCategory: "claim_expired",
      status: 410,
    });
    expect(h.posts).toHaveLength(1);
  });

  it("stops as unconfirmed, not failed, when the pending window elapses", async () => {
    // Each request spends Riddler's full 10s receipt wait, so the window runs
    // out after a bounded number of polls however long the op stays unmined.
    const always = Array.from({ length: 100 }, () => pending(5));
    const h = harness(always, 10_000);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "unconfirmed", opHash: OP_HASH });
    // 10s request + 6s floored wait per round: 18 rounds fit in 300s, and the
    // 19th answer comes back with no room left to wait and poll again.
    expect(h.posts).toHaveLength(19);
    expect(h.posts.every((p) => p.body === BODY)).toBe(true);
    expect(h.deps.now()).toBeLessThanOrEqual(h.deps.deadline);
  });

  it("floors a short retryAfter so polling stays under the submit rate limit", async () => {
    const h = harness([pending(1), ok(LANDED)]);

    await submitClaimUntilSettled(BODY, h.deps);

    expect(h.sleeps).toEqual([MIN_CLAIM_POLL_INTERVAL_MS]);
  });

  it("measures the pending window from the first pending answer, not the prepare", async () => {
    // The user spent 250s signing, so 50s of the prepare window remain. The op
    // was broadcast inside the first submit, and Riddler can poll it for 300s
    // from there, so the client keeps polling for that long.
    const always = Array.from({ length: 100 }, () => pending(5));
    const h = harness(always, 10_000, 50_000);
    const firstSubmitAt = h.deps.now();

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "unconfirmed", opHash: OP_HASH });
    // The same 19 rounds as a full window, where the prepare window alone
    // would have allowed four.
    expect(h.posts).toHaveLength(19);
    expect(h.deps.now()).toBeGreaterThan(firstSubmitAt + 50_000);
    expect(h.deps.now()).toBeLessThanOrEqual(firstSubmitAt + CLAIM_PENDING_WINDOW_MS);
  });

  it("resubmits after an unknown outcome and finds the op the first submit broadcast", async () => {
    // The worker gave up on Riddler at 15s after the bundler had accepted the
    // op; the resubmit finds the broadcast mark and answers pending, then 200.
    const h = harness([unavailable(), pending(5), ok(LANDED)]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "submitted", data: LANDED });
    expect(h.posts.map((p) => p.body)).toEqual([BODY, BODY, BODY]);
    expect(h.sleeps).toEqual([MIN_CLAIM_POLL_INTERVAL_MS, MIN_CLAIM_POLL_INTERVAL_MS]);
  });

  it("treats a transport error or timeout (no status) as an unknown outcome too", async () => {
    const h = harness([err("Request timed out"), ok(LANDED)]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "submitted", data: LANDED });
    expect(h.posts).toHaveLength(2);
  });

  it("gives up on an outage after a bounded number of resubmits", async () => {
    const h = harness(Array.from({ length: 10 }, unavailable));

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toMatchObject({ kind: "failed", errorCategory: "claim_service_unavailable" });
    expect(h.posts).toHaveLength(1 + MAX_UNKNOWN_OUTCOME_RETRIES);
  });

  it("fails a 429 before anything pended at once", async () => {
    const h = harness([
      err("Too many claim attempts. Please wait and try again.", {
        status: 429,
        errorCategory: "claim_rate_limited",
      }),
    ]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toMatchObject({ kind: "failed", status: 429 });
    expect(h.posts).toHaveLength(1);
  });

  it("keeps polling an in-flight op through server errors, past the pre-pending retry cap", async () => {
    const blips = Array.from({ length: MAX_UNKNOWN_OUTCOME_RETRIES + 2 }, unavailable);
    const h = harness([pending(5), ...blips, ok(LANDED)]);

    const outcome = await submitClaimUntilSettled(BODY, h.deps);

    expect(outcome).toEqual({ kind: "submitted", data: LANDED });
    expect(h.posts).toHaveLength(blips.length + 2);
  });
});
