/**
 * The lifecycle on the machine alone: preview, connect, quote, 1- and
 * 2-signature signing, execute and status, driven message by message with a
 * test-owned clock. No React, no wallet, no network: every effect the machine
 * asks for is answered here, so each test reads as the protocol it pins.
 */

import { describe, it, expect } from "vitest";
import { STATUS_POLL_FLAT_CEILING_MS, STATUS_POLL_MS, unexecutedFinishAt } from "./decisions.js";
import {
  RECONCILE_AFTER_ATTEMPTS,
  SIGN_PROMPT_TIMEOUT_MS,
  type Effect,
  type MsgBody,
} from "./machine.js";
import { settlementDisclosure } from "./receipt.js";
import { decodeWireStatus, type IntentStatusData } from "./wire.js";
import {
  AMOUNT,
  ATTACKER,
  Session,
  T0,
  TO_AMOUNT,
  USDC_BASE,
  WALLET,
  apiCalls,
  ctx,
  erc3009Pull,
  intentTypedData,
  logs,
  only,
  quote,
  statusData,
  walletCalls,
} from "./test/session.js";

const signIntent = (s: Session) =>
  only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData"));

const timers = (fx: Effect[]) =>
  fx.flatMap((e) => (e.type === "Timer" ? [`${e.call.op}:${e.call.timer}`] : []));

/**
 * Run up to `ticks` poll intervals, each answered with `data`; returns how
 * many ran before the poll stopped asking.
 */
const pollReads = (s: Session, data: IntentStatusData, ticks: number): number => {
  for (let i = 0; i < ticks; i++) {
    const asked = apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status");
    if (asked.length === 0) return i;
    const { gen, attempt } = only(asked);
    s.send({ type: "StatusReplied", gen, attempt, result: { ok: true, status: data } });
  }
  return ticks;
};

/** Unix ms of the Worker's finish of the fixture quote's unclaimed intent. */
const workerFinishMs = (s: Session): number => {
  const finish = unexecutedFinishAt(s.intent.quote);
  if (finish === null) throw new Error("no finish time");
  return finish * 1000;
};

describe("preview and connect", () => {
  it("quotes a walletless visitor as an unsignable preview", () => {
    const s = new Session(ctx({}, { address: null, chainId: null }));
    const call = s.requestQuote();
    expect(call.request.preview).toBe(true);
    expect(call.request.wallet).toBeUndefined();

    s.send({
      type: "QuoteReplied",
      flight: call.flight,
      result: { ok: true, quote: quote({ preview: true, eip712Data: undefined }) },
    });
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.quotedAddress).toBeNull();
    expect(s.receipt.payout).toEqual({ kind: "preview", amount: TO_AMOUNT });
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });
  });

  it("upgrades the preview in place once a wallet connects: silent, forced, wallet-bound", () => {
    const s = new Session(ctx({}, { address: null, chainId: null }));
    const call = s.requestQuote();
    s.send({
      type: "QuoteReplied",
      flight: call.flight,
      result: { ok: true, quote: quote({ preview: true, eip712Data: undefined }) },
    });

    const fx = s.send({ type: "ContextChanged", ctx: ctx() });
    const upgrade = only(apiCalls(fx, "quote"));
    expect(upgrade.forceRefresh).toBe(true);
    expect(upgrade.request).toMatchObject({ preview: false, wallet: WALLET });
    // Silent: the price on screen never flashes back to "quoting".
    expect(s.intent.status).toBe("quoted");

    s.send({
      type: "QuoteReplied",
      flight: upgrade.flight,
      result: { ok: true, quote: quote({ quoteId: "xq_bound" }) },
    });
    expect(s.intent.quoteId).toBe("xq_bound");
    expect(s.intent.quotedAddress).toBe(WALLET);
    expect(s.receipt.payout).toEqual({
      kind: "exact",
      amount: TO_AMOUNT,
      otherwise: "full_refund",
    });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });
  });

  it("holds a walletless stealth request instead of asking the solver", () => {
    const s = new Session(ctx({ settlementPreference: "stealth" }, { address: null }));
    s.send({ type: "QuoteRequested", amount: AMOUNT });
    const fx = s.send({ type: "TimerFired", timer: "debounce" }, 500);
    expect(apiCalls(fx, "quote")).toHaveLength(0);
    expect(s.intent.error).toBe("Connect a wallet to quote this route");
  });
});

describe("quote", () => {
  it("debounces, quotes, and arms the countdown and the pre-expiry refresh", () => {
    const s = new Session();
    expect(timers(s.send({ type: "QuoteRequested", amount: AMOUNT }))).toEqual([
      "clear:debounce",
      "clear:refresh",
      "set:debounce",
    ]);
    const call = only(apiCalls(s.send({ type: "TimerFired", timer: "debounce" }, 500), "quote"));
    expect(s.intent.status).toBe("quoting");
    expect(s.receipt.quote).toEqual({ kind: "loading" });

    const fx = s.send({
      type: "QuoteReplied",
      flight: call.flight,
      result: { ok: true, quote: quote() },
    });
    expect(s.intent.status).toBe("quoted");
    expect(timers(fx)).toEqual(["set:refresh", "set:expiry"]);
    expect(s.receipt.quote).toMatchObject({ kind: "ready", executable: true, refreshing: false });
    expect(s.receipt.cost).toEqual({ kind: "served", bps: 22, totalUsd: null });
    expect(s.model.quoteExpiresIn).toBe(59);
  });

  it("states an absent cost as unavailable, never zero", () => {
    const s = new Session();
    s.quoteWith(quote({ costBps: undefined }));
    expect(s.receipt.cost).toEqual({ kind: "unavailable" });
  });

  it("keeps the solver's decline reason and never shows a payout for it", () => {
    const s = new Session();
    s.quoteWith(quote({ canSolve: false, error: "unprofitable" }));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.error).toBe("unprofitable");
    expect(s.receipt.payout).toEqual({ kind: "none" });
    expect(s.receipt.quote).toEqual({ kind: "declined", reason: "unprofitable" });
  });

  it("refuses a quote whose payout recipient is the destination token", () => {
    const s = new Session(ctx({ toToken: WALLET }));
    const fx = s.quoteWith(quote());
    expect(s.intent.status).toBe("failed");
    expect(s.intent.quote).toBeNull();
    expect(logs(fx, "error").join(" ")).toMatch(/destination token/);
  });

  it("keeps the reviewed quote when a silent refresh fails, and says so", () => {
    const s = new Session(ctx({ paused: true }));
    s.quoteWith(quote());
    const refresh = only(
      apiCalls(s.send({ type: "TimerFired", timer: "refresh" }, 55_000), "quote"),
    );
    expect(refresh.forceRefresh).toBe(true);
    const fx = s.send({
      type: "QuoteReplied",
      flight: refresh.flight,
      result: { ok: true, quote: quote({ canSolve: false, error: "unprofitable" }) },
    });
    expect(logs(fx, "warn")).toContain("[useIntent] Quote not solvable:");
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.quoteId).toBe("xq_1");
    expect(s.intent.error).toBeNull();
  });

  it("expires a quote the user left on screen past its expiry", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "TimerFired", timer: "expiry" }, 61_000);
    expect(s.intent.status).toBe("expired");
    expect(s.intent.error).toBe("Quote expired");
    expect(s.model.quoteExpiresIn).toBeNull();
  });
});

describe("one signature (no origin pull)", () => {
  it("signs, executes, polls, and completes", () => {
    const s = new Session();
    s.quoteWith(quote());
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    const prompt = signIntent(s);
    expect(prompt).toMatchObject({ purpose: "intent", chainId: 8453 });
    expect(s.intent.status).toBe("signing");
    expect(s.receipt.phase).toBe("awaiting-wallet");
    expect(s.receipt.signing).toEqual({ kind: "in_wallet", step: 1, of: 1 });

    const fx = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xsig" },
    });
    const exec = only(apiCalls(fx, "execute"));
    expect(exec.request).toMatchObject({ intentId: "xi_1", quoteId: "xq_1", signature: "0xsig" });
    expect(exec.request.pullSignature).toBeUndefined();
    expect(s.intent.status).toBe("executing");
    expect(s.receipt.signing).toEqual({ kind: "submitted" });
    // Status waits for /execute: a pre-acceptance `quoted` read is stale.
    expect(apiCalls(fx, "status")).toEqual([]);
    expect(timers(fx)).not.toContain("set:poll");
    expect(timers(fx)).toContain("clear:signPrompt");

    const settled = s.send(
      {
        type: "ExecuteReplied",
        flow: exec.flow,
        result: { ok: true, response: { success: true, intentId: "xi_1", status: "settling" } },
      },
      1200,
    );
    expect(s.intent.status).toBe("settling");
    const poll = only(apiCalls(settled, "status"));

    const done = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({ status: "completed", terminal: true, txHash: "0xabc" }),
      },
    });
    expect(s.intent.status).toBe("completed");
    expect(s.intent.txHash).toBe("0xabc");
    expect(s.receipt.phase).toBe("success");
    expect(timers(done)).toContain("clear:poll");
  });

  it("cancels an unanswered wallet prompt and ignores its late signature", () => {
    const s = new Session();
    s.quoteWith(quote());
    const started = s.send({ type: "SignRequested" });
    const prompt = only(walletCalls(started, "signTypedData"));
    expect(timers(started)).toContain("set:signPrompt");

    const cancelled = s.send({ type: "CancelSignRequested" });
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.error).toBe("Signature cancelled");
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });
    expect(timers(cancelled)).toContain("clear:signPrompt");

    const late = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xlate" },
    });
    expect(apiCalls(late, "execute")).toHaveLength(0);
  });

  it("times out signature 1 without leaving a live ceremony", () => {
    const s = new Session();
    s.quoteWith(quote());
    const started = s.send({ type: "SignRequested" });
    const prompt = only(walletCalls(started, "signTypedData"));

    s.send({ type: "TimerFired", timer: "signPrompt" }, SIGN_PROMPT_TIMEOUT_MS);
    expect(s.intent.status).toBe("expired");
    expect(s.intent.error).toBe("Quote expired");
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });

    const late = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xlate" },
    });
    expect(apiCalls(late, "execute")).toHaveLength(0);
  });

  it("measures the fill on an inline completion only", () => {
    const s = new Session();
    s.quoteWith(quote());
    const prompt = signIntent(s);
    const exec = only(
      apiCalls(
        s.send(
          {
            type: "SignReplied",
            flow: prompt.flow,
            purpose: "intent",
            result: { ok: true, signature: "0xsig" },
          },
          4000,
        ),
        "execute",
      ),
    );
    s.send(
      {
        type: "ExecuteReplied",
        flow: exec.flow,
        result: { ok: true, response: { success: true, intentId: "xi_1", status: "completed" } },
      },
      1500,
    );
    expect(s.model.clientFillMs).toBe(1500);
  });

  it("returns a rejected signature to the confirm surface", () => {
    const s = new Session();
    s.quoteWith(quote());
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: false, error: { rejected: true, value: "User rejected", detail: "x" } },
    });
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.error).toBe("Signature rejected");
    expect(s.receipt.phase).toBe("confirm");
  });

  it("refuses a payload that pays less than shown, visibly, with the quote kept", () => {
    // The served intent pays less than the quote displays. The signer's request
    // check does not bind `toAmount` on an exact-input swap (it is the quoted
    // output), so the payout pin at Confirm is the gate that catches this one.
    // A payload naming another recipient never gets this far: the signer
    // refuses it at ingest (fundSafety.test.ts).
    const s = new Session();
    s.quoteWith(quote({ eip712Data: intentTypedData({ toAmount: "1" }) }));
    const fx = s.send({ type: "SignRequested" });
    expect(walletCalls(fx, "signTypedData")).toHaveLength(0);
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.quoteId).toBe("xq_1");
    expect(s.receipt.quote).toMatchObject({ kind: "ready" });
    expect(s.receipt.signing).toEqual({ kind: "refused", refusal: { kind: "payout_mismatch" } });
    expect(logs(fx, "error")).toContain("[useIntent] Refusing to sign intent:");
    expect(logs(fx, "warn")).toEqual([]);
  });

  it("refuses off the origin chain, visibly, with the quote kept", () => {
    // Quoted while the wallet sat on Arbitrum, so the wallet watcher has
    // nothing to reset: only the preflight can stop the signature.
    const s = new Session(ctx({}, { chainId: 42161 }));
    s.quoteWith(quote());
    const fx = s.send({ type: "SignRequested" });
    expect(walletCalls(fx, "signTypedData")).toHaveLength(0);
    expect(s.intent.status).toBe("quoted");
    expect(s.receipt.quote).toMatchObject({ kind: "ready" });
    expect(s.receipt.signing).toEqual({
      kind: "refused",
      refusal: { kind: "wrong_chain", chainId: 8453 },
    });

    // Back on the origin chain the wallet watcher drops the stale quote and the
    // refusal with it; a fresh quote signs normally.
    s.send({ type: "ContextChanged", ctx: ctx() });
    expect(s.intent.refusal).toBeNull();
    s.quoteWith(quote());
    expect(only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).purpose).toBe(
      "intent",
    );
  });

  it("clears a refusal when a fresh quote lands", () => {
    const s = new Session();
    s.quoteWith(quote({ eip712Data: intentTypedData({ recipient: ATTACKER }) }));
    s.send({ type: "SignRequested" });
    const call = only(apiCalls(s.send({ type: "RefreshRequested" }), "quote"));
    s.send({ type: "QuoteReplied", flight: call.flight, result: { ok: true, quote: quote() } });
    expect(s.intent.refusal).toBeNull();
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });
  });

  // A second Confirm while the wallet is open must not drop the intent back to
  // `quoted` with the prompt still live: the late signature would then execute
  // from `quoted`.
  it("ignores a second Confirm while the wallet is open", () => {
    const s = new Session();
    s.quoteWith(quote());
    const prompt = signIntent(s);
    s.send({ type: "ContextChanged", ctx: ctx({ fromChainId: 42161 }) });
    expect(s.send({ type: "SignRequested" })).toEqual([]);
    expect(s.intent.status).toBe("signing");
    expect(s.intent.error).toBeNull();
    expect(s.intent.refusal).toBeNull();
    expect(s.receipt.signing).toEqual({ kind: "in_wallet", step: 1, of: 1 });

    // The one prompt that was raised is the one that executes, once.
    const fx = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xsig" },
    });
    expect(apiCalls(fx, "execute")).toHaveLength(1);
    expect(s.intent.status).toBe("executing");
  });

  it("never executes a signature that lands after the prompt was abandoned", () => {
    const s = new Session();
    s.quoteWith(quote());
    const prompt = signIntent(s);
    // A refresh asked over the open prompt is not a way out of it: ignored.
    expect(apiCalls(s.send({ type: "RefreshRequested" }), "quote")).toEqual([]);
    expect(s.intent.status).toBe("signing");
    // Starting over is.
    s.send({ type: "ResetRequested" });
    s.quoteWith(quote());
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    const fx = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xsig" },
    });
    expect(apiCalls(fx, "execute")).toHaveLength(0);
    expect(s.intent.status).toBe("quoted");
  });

  it("treats an execute that never answered as in doubt, never failed", () => {
    const s = new Session();
    s.quoteWith(quote());
    const prompt = signIntent(s);
    const exec = only(
      apiCalls(
        s.send({
          type: "SignReplied",
          flow: prompt.flow,
          purpose: "intent",
          result: { ok: true, signature: "0xsig" },
        }),
        "execute",
      ),
    );
    s.send({
      type: "ExecuteReplied",
      flow: exec.flow,
      result: { ok: false, error: { rejected: false, value: "timeout", detail: "timeout" } },
    });
    expect(s.intent.status).toBe("executing");
    expect(s.intent.reconciling).toBe(true);
    expect(s.receipt.phase).toBe("pending");
  });

  describe("an execute reply is judged by the machine, not the host", () => {
    const READ_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";
    const executing = () => {
      const s = new Session();
      s.quoteWith(quote());
      const prompt = signIntent(s);
      const exec = only(
        apiCalls(
          s.send({
            type: "SignReplied",
            flow: prompt.flow,
            purpose: "intent",
            result: { ok: true, signature: "0xsig" },
          }),
          "execute",
        ),
      );
      return { s, flow: exec.flow };
    };
    // A reply shape the type no longer admits (a stale or hand-built host).
    const foreign = (flow: string, result: unknown) =>
      ({ type: "ExecuteReplied", flow, result }) as unknown as MsgBody;

    it("keeps a fail-closed downgrade in doubt (no Retry), whatever status it names", () => {
      for (const status of ["settling", "executing"] as const) {
        const { s, flow } = executing();
        s.send({
          type: "ExecuteReplied",
          flow,
          result: { ok: true, response: { success: false, intentId: "xi_1", status } },
        });
        expect(s.intent.status).toBe(status);
        expect(s.intent.reconciling).toBe(true);
        expect(s.receipt.phase).not.toBe("failed");
      }
    });

    it("keeps a self-contradicting 'failed' in doubt (no Retry)", () => {
      for (const response of [
        { success: true, intentId: "xi_1", status: "failed" },
        { success: false, intentId: "xi_1", status: "failed", reconciling: true },
      ] as const) {
        const { s, flow } = executing();
        s.send({ type: "ExecuteReplied", flow, result: { ok: true, response } });
        const label = JSON.stringify(response);
        expect(s.intent.status, label).toBe("executing");
        expect(s.intent.reconciling, label).toBe(true);
        expect(s.intent.error, label).toBeNull();
        expect(s.receipt.phase, label).toBe("pending");
      }
    });

    it("reads the Worker's `quoted` reply as not sent yet: no Retry, still polling", () => {
      // The Worker ended its own claim but could not finish the intent (its
      // finish-fault answer): the row is `quoted` and the signed request
      // executable again, so neither "Still confirming" nor Retry.
      const { s, flow } = executing();
      s.send({
        type: "ExecuteReplied",
        flow,
        result: {
          ok: true,
          response: { success: false, intentId: "xi_1", status: "quoted", reconciling: true },
        },
      });
      expect(s.intent.status).toBe("executing");
      expect(s.intent.notSent).toBe(true);
      expect(s.intent.reconciling).toBe(false);
      expect(s.receipt.phase).toBe("not-sent");
      expect(s.model.poll?.stopped).toBe(false);
      // The read or the sweep that ends it offers Retry.
      pollReads(s, statusData({ status: "quoted" }), 3);
      expect(s.receipt.phase).toBe("not-sent");
      pollReads(s, statusData({ status: "failed", terminal: true, substatus: "not_executed" }), 1);
      expect(s.receipt.phase).toBe("failed");

      // A live execute can answer accepted before the Worker's status read
      // returns to `quoted`. That is the same not-sent verdict as an execute
      // reply carrying `quoted`, not "Still confirming".
      const live = executing();
      live.s.send({
        type: "ExecuteReplied",
        flow: live.flow,
        result: {
          ok: true,
          response: { success: true, intentId: "xi_1", status: "executing" },
        },
      });
      pollReads(live.s, statusData({ status: "quoted" }), 1);
      expect(live.s.intent.notSent).toBe(true);
      expect(live.s.intent.reconciling).toBe(false);
      expect(live.s.receipt.phase).toBe("not-sent");
      expect(live.s.model.poll?.stopped).toBe(false);
    });

    it("waits for the execute reply before the first status read", () => {
      const { s, flow } = executing();
      expect(s.model.sign?.stage).toBe("execute");
      expect(s.model.poll).toBeNull();
      expect(
        apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      ).toEqual([]);

      const fx = s.send({
        type: "ExecuteReplied",
        flow,
        result: {
          ok: true,
          response: { success: true, intentId: "xi_1", status: "executing" },
        },
      });
      expect(apiCalls(fx, "status")).toHaveLength(1);
    });

    // The poll answers with what the transport decodes: a granular
    // `fill_failed` arrives as `failed`, a status the server calls terminal.
    const pollReply = (s: Session, status: IntentStatusData) => {
      const poll = s.model.poll;
      if (!poll) throw new Error("no poll armed");
      return s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.polls,
        result: { ok: true, status },
      });
    };
    const failedPoll = statusData({ status: "failed", terminal: true, error: "Fill failed" });
    const notExecutedPoll = statusData({
      status: "failed",
      terminal: true,
      substatus: "not_executed",
      error: "Solver busy",
    });
    // Every execute outcome that leaves the intent in flight, in doubt, polled.
    const thrown = (error: Record<string, unknown>) => ({ ok: false, error });
    const inFlight: Record<string, unknown> = {
      // Any thrown `ApiError` (a 502 with or without the read token, a 409, a
      // JSON 500): the poll decides it, whatever `ApiError.inDoubt` said.
      "a thrown 502": thrown({ rejected: false, value: "HTTP 502", detail: "502" }),
      // The 120 s timeout, an abort, a reset connection, a refused redirect.
      "timed out": thrown({ rejected: false, value: "aborted", detail: "AbortError" }),
      // A 2xx whose body failed validation: the server accepted something.
      "invalid 2xx": thrown({
        rejected: false,
        value: "Invalid response format",
        detail: "Invalid response format",
      }),
      "a reply the machine cannot read": {
        ok: true,
        response: { success: true, intentId: "xi_1", status: 7 },
      },
      "success withheld": {
        ok: true,
        response: { success: false, intentId: "xi_1", status: "failed" },
      },
      "failed but reconciling": {
        ok: true,
        response: { success: false, intentId: "xi_1", status: "failed", reconciling: true },
      },
      "self-contradicting": {
        ok: true,
        response: { success: true, intentId: "xi_1", status: "failed" },
      },
      "granular, reconciling": {
        ok: true,
        response: { success: false, intentId: "xi_1", status: "fill_failed" },
      },
      "withheld settling": {
        ok: true,
        response: { success: false, intentId: "xi_1", status: "settling" },
      },
      "an unmapped status": {
        ok: true,
        response: { success: true, intentId: "xi_1", status: "some_future_state" },
      },
      // Accepted: in flight, not in doubt.
      accepted: { ok: true, response: { success: true, intentId: "xi_1", status: "settling" } },
    };

    /** The terminal "may have moved" view: no Retry, no poll, no quote until Reset. */
    const expectMayHaveMoved = (s: Session, fx: Effect[], label: string, clearedPoll = true) => {
      expect(s.intent.status, label).toBe("failed");
      expect(s.intent.mayHaveMoved, label).toBe(true);
      expect(s.intent.reconciling, label).toBe(false);
      expect(s.receipt.phase, label).toBe("may-have-moved");
      if (clearedPoll) expect(timers(fx), label).toContain("clear:poll");
      expect(s.model.poll, label).toBeNull();
    };

    it("ends every failed after an execute as may have moved, unless it is marked not_executed", () => {
      for (const [label, result] of Object.entries(inFlight)) {
        const { s, flow } = executing();
        s.send(foreign(flow, result));
        expect(s.receipt.phase, label).not.toBe("failed");
        // A bare `failed`, a granular one (the transport buckets `fill_failed`
        // to `failed`), and one carrying a solver substatus: all at once.
        for (const [shape, poll] of Object.entries({
          bare: failedPoll,
          granular: statusData({ status: "failed", terminal: true, substatus: "fill_failed" }),
          "solver substatus": statusData({
            status: "failed",
            terminal: true,
            substatus: "pulling",
          }),
        })) {
          const again = executing();
          again.s.send(foreign(again.flow, result));
          expectMayHaveMoved(again.s, pollReply(again.s, poll), `${label}, ${shape}`);
        }
        // The Worker's own nothing-moved finish: Retry.
        const fx = pollReply(s, notExecutedPoll);
        expect(s.intent.status, label).toBe("failed");
        expect(s.intent.mayHaveMoved, label).toBe(false);
        expect(s.receipt.phase, label).toBe("failed");
        expect(timers(fx), label).toContain("clear:poll");
      }
    });

    it("ends a final failed execute reply at once: Retry only with the marker", () => {
      const reply = (response: Record<string, unknown>) => {
        const { s, flow } = executing();
        const fx = s.send(foreign(flow, { ok: true, response }));
        return { s, fx };
      };
      const final = { success: false, intentId: "xi_1", reconciling: false };
      for (const status of ["failed", "fill_failed", "refund_failed", "pull_failed"]) {
        const { s, fx } = reply({ ...final, status });
        expectMayHaveMoved(s, fx, status, false);
      }
      // A granular status names what the pull did, whatever substatus rides with it.
      const granular = reply({ ...final, status: "fill_failed", substatus: "not_executed" });
      expectMayHaveMoved(granular.s, granular.fx, "granular with the marker", false);
      const marked = reply({ ...final, status: "failed", substatus: "not_executed" });
      expect(marked.s.intent.status).toBe("failed");
      expect(marked.s.intent.mayHaveMoved).toBe(false);
      expect(marked.s.receipt.phase).toBe("failed");
    });

    it("applies the same rule to a failed stream frame", () => {
      for (const [label, result] of Object.entries(inFlight)) {
        for (const [shape, substatus, phase] of [
          ["bare", undefined, "may-have-moved"],
          ["granular", "fill_failed", "may-have-moved"],
          ["marked", "not_executed", "failed"],
        ] as const) {
          const { s, flow } = executing();
          s.send(foreign(flow, result));
          const fx = s.send({
            type: "StreamStatus",
            message: {
              type: "intent_status",
              intentId: "xi_1",
              status: "failed",
              ...(substatus ? { substatus } : {}),
              timestamp: "t",
            },
          });
          expect(s.intent.status, `${label}, ${shape}`).toBe("failed");
          expect(s.receipt.phase, `${label}, ${shape}`).toBe(phase);
          expect(timers(fx), `${label}, ${shape}`).toContain("clear:poll");
        }
      }
    });

    it("holds may have moved until Reset: no quote, no wallet reset, no Retry", () => {
      const { s, flow } = executing();
      s.send(foreign(flow, inFlight["timed out"]));
      pollReply(s, failedPoll);
      expect(s.receipt.phase).toBe("may-have-moved");
      for (const msg of [
        { type: "RefreshRequested" },
        // Clearing the amount is no way out either.
        { type: "QuoteRequested", amount: "" },
        { type: "QuoteRequested", amount: "2000000" },
        { type: "TimerFired", timer: "debounce" },
        { type: "VisibilityChanged" },
      ] as MsgBody[]) {
        expect(apiCalls(s.send(msg), "quote"), msg.type).toEqual([]);
        expect(s.receipt.phase, msg.type).toBe("may-have-moved");
      }
      s.send({
        type: "ContextChanged",
        ctx: {
          ...s.model.ctx,
          wallet: { ...s.model.ctx.wallet, address: "0x2222222222222222222222222222222222222222" },
        },
      });
      expect(s.receipt.phase).toBe("may-have-moved");
      s.send({ type: "ResetRequested" });
      expect(s.intent.status).toBe("idle");
      expect(s.intent.mayHaveMoved).toBe(false);
      s.send({ type: "QuoteRequested", amount: "1000000" });
      expect(apiCalls(s.send({ type: "TimerFired", timer: "debounce" }), "quote")).toHaveLength(1);
    });

    it("cannot be handed a host-built verdict in place of the response", () => {
      const { s, flow } = executing();
      // A host that decided "failed" itself would have offered Retry on a swap
      // whose origin pull may already have moved funds.
      const fx = s.send(
        foreign(flow, { ok: true, decision: { kind: "failed", error: "laundered" } }),
      );
      expect(s.intent.status).toBe("executing");
      expect(s.intent.reconciling).toBe(true);
      expect(s.intent.error).toBeNull();
      expect(s.model.sign).toBeNull();
      expect(logs(fx, "error").join()).toMatch(/not an execute response/);

      const completed = executing();
      completed.s.send(
        foreign(completed.flow, {
          ok: true,
          decision: { kind: "transition", status: "completed", updates: { reconciling: false } },
        }),
      );
      expect(completed.s.intent.status).toBe("executing");
      expect(completed.s.intent.reconciling).toBe(true);
    });

    it("handles a malformed reply without throwing", () => {
      for (const result of [
        undefined,
        null,
        { ok: true },
        { ok: true, response: { success: "yes", intentId: "xi_1", status: "completed" } },
        { ok: true, response: { success: true, intentId: "xi_1", status: 7 } },
        { ok: false },
      ]) {
        const { s, flow } = executing();
        expect(() => s.send(foreign(flow, result))).not.toThrow();
        expect(s.intent.status).toBe("executing");
        expect(s.intent.reconciling).toBe(true);
      }
    });

    it("buckets a served status it does not model, never reading it as a failure", () => {
      const cases = [
        // A new server status: its in-flight bucket, shown in doubt like an unmapped poll.
        { success: true, status: "some_future_state", to: "executing", reconciling: true },
        // A granular failure at execute is the poll's to resolve: no Retry.
        { success: false, status: "fill_failed", to: "executing", reconciling: true },
        // A granular in-flight status advances like its bucket.
        { success: true, status: "filling", to: "settling", reconciling: false },
      ];
      for (const { success, status, to, reconciling } of cases) {
        const { s, flow } = executing();
        s.send(foreign(flow, { ok: true, response: { success, intentId: "xi_1", status } }));
        expect(s.intent.status, status).toBe(to);
        expect(s.intent.reconciling, status).toBe(reconciling);
        expect(s.receipt.phase, status).not.toBe("failed");
      }
    });

    it("polls an execute that never reached the Worker until its finish, then offers Retry", () => {
      // A refused redirect or a timeout before any answer: the row stays
      // `quoted`, and the Worker's read past the signed deadline plus grace
      // finishes it `failed` with `not_executed`.
      for (const error of ["Refused a redirect (/api/intent/execute)", "AbortError"]) {
        const { s, flow } = executing();
        const report = { rejected: false, value: error, detail: error };
        s.send({ type: "ExecuteReplied", flow, result: { ok: false, error: report } });
        expect(s.receipt.phase, error).toBe("pending");
        // Every `quoted` read until the finish keeps polling, past the flat
        // ten-minute ceiling, and never offers Retry.
        const ticks = Math.ceil((workerFinishMs(s) - s.now) / STATUS_POLL_MS);
        expect(ticks, error).toBeGreaterThan(150);
        expect(pollReads(s, statusData({ status: "quoted" }), ticks), error).toBe(ticks);
        expect(s.now, error).toBeGreaterThanOrEqual(workerFinishMs(s));
        expect(s.intent.pollExhausted, error).toBe(false);
        expect(s.intent.status, error).toBe("executing");
        expect(s.receipt.phase, error).toBe("pending");
        pollReads(
          s,
          statusData({ status: "failed", terminal: true, substatus: "not_executed" }),
          1,
        );
        expect(s.intent.status, error).toBe("failed");
        expect(s.intent.mayHaveMoved, error).toBe(false);
        expect(s.receipt.phase, error).toBe("failed");
      }
      // `quoted` is no progress: past the finish the ceiling still stops the poll.
      const { s, flow } = executing();
      const report = { rejected: false, value: "x", detail: "x" };
      s.send({ type: "ExecuteReplied", flow, result: { ok: false, error: report } });
      const ran = pollReads(s, statusData({ status: "quoted" }), 5000);
      expect(ran).toBeLessThan(5000);
      expect(s.now).toBeGreaterThan(workerFinishMs(s));
      expect(s.intent.pollExhausted).toBe(true);

      const restarted = s.send({ type: "VisibilityChanged" });
      expect(apiCalls(restarted, "status")).toHaveLength(1);
      expect(s.model.poll?.stopped).toBe(false);
      expect(s.intent.pollExhausted).toBe(false);
    });

    it("bounds a live not-sent poll when quoted never becomes terminal", () => {
      const { s, flow } = executing();
      s.send({
        type: "ExecuteReplied",
        flow,
        result: {
          ok: true,
          response: { success: true, intentId: "xi_1", status: "executing" },
        },
      });
      pollReads(s, statusData({ status: "quoted" }), 1);
      expect(s.receipt.phase).toBe("not-sent");

      const ran = pollReads(s, statusData({ status: "quoted" }), 5000);
      expect(ran).toBeLessThan(5000);
      expect(s.intent.pollExhausted).toBe(true);
    });

    it("treats a reply for another intent as in doubt", () => {
      const { s, flow } = executing();
      s.send({
        type: "ExecuteReplied",
        flow,
        result: {
          ok: true,
          response: { success: true, intentId: "xi_other", status: "completed" },
        },
      });
      expect(s.intent.intentId).toBe("xi_1");
      expect(s.intent.status).toBe("executing");
      expect(s.intent.reconciling).toBe(true);
    });

    it("never stores or echoes a read token a host left on the reply", () => {
      const { s, flow } = executing();
      const fx = s.send(
        foreign(flow, {
          ok: true,
          response: { success: true, intentId: "xi_1", status: "settling", readToken: READ_TOKEN },
        }),
      );
      expect(s.intent.status).toBe("settling");
      expect(logs(fx, "warn").join()).toMatch(/readToken/);
      expect(JSON.stringify(fx)).not.toContain(READ_TOKEN);
      expect(JSON.stringify(s.model)).not.toContain(READ_TOKEN);
    });
  });

  // The Worker's explicit backpressure answer (`ApiError.notAccepted`): the
  // solver refused before accepting anything, so nothing is in doubt and the
  // SAME signed request goes again after Retry-After, a bounded number of times.
  describe("an execute the server did not accept", () => {
    const executing = (served = quote()) => {
      const s = new Session();
      s.quoteWith(served);
      const prompt = signIntent(s);
      const exec = only(
        apiCalls(
          s.send({
            type: "SignReplied",
            flow: prompt.flow,
            purpose: "intent",
            result: { ok: true, signature: "0xsig" },
          }),
          "execute",
        ),
      );
      return { s, exec };
    };
    const nowSec = (s: Session) => Math.floor(s.now / 1000);
    // What a host builds from the thrown `ApiError` (its code, retryAfter and flag).
    const busy = (flow: string, retryAfter: number | undefined, notAccepted: unknown = true) =>
      ({
        type: "ExecuteReplied",
        flow,
        result: {
          ok: false,
          error: {
            rejected: false,
            value: { message: "HTTP 503: Solver busy", code: 503, retryAfter },
            detail: "HTTP 503",
            notAccepted,
          },
        },
      }) as MsgBody;
    const timerSet = (fx: Effect[], timer: string) =>
      fx.flatMap((e) =>
        e.type === "Timer" && e.call.op === "set" && e.call.timer === timer ? [e.call.ms] : [],
      );
    // Every give-up of this client: "not sent yet", no Retry, still polling,
    // since the Worker un-claimed the intent and the signed request stays
    // executable until its deadline.
    const expectNotSent = (s: Session, label = "") => {
      expect(s.intent.status, label).toBe("executing");
      expect(s.intent.notSent, label).toBe(true);
      expect(s.intent.reconciling, label).toBe(false);
      expect(s.receipt.phase, label).toBe("not-sent");
      expect(s.model.sign, label).toBeNull();
      expect(s.model.poll?.stopped, label).toBe(false);
      expect(s.model.poll?.key, label).toBe("xi_1:executing");
    };

    it("waits for Retry-After, then resends the same signed request once", () => {
      const { s, exec } = executing();
      const retryAt = nowSec(s) + 5;
      const fx = s.send(busy(exec.flow, retryAt));
      // Not in doubt: no reconciling, no status read while nothing is accepted.
      expect(s.intent.status).toBe("executing");
      expect(s.intent.reconciling).toBe(false);
      expect(apiCalls(fx, "status")).toEqual([]);
      expect(timers(fx)).not.toContain("clear:poll");
      expect(s.receipt.phase).toBe("submitting");
      expect(s.receipt.signing).toEqual({ kind: "busy", retryAt, resend: 1, of: 3 });
      const delay = only(timerSet(fx, "execute"));
      expect(delay).toBe(retryAt * 1000 - s.now);

      // A stray reply for the attempt already answered changes nothing.
      expect(s.send(busy(exec.flow, retryAt))).toEqual([]);
      expect(apiCalls(s.send({ type: "TimerFired", timer: "poll" }), "status")).toEqual([]);

      const resent = s.send({ type: "TimerFired", timer: "execute" }, delay);
      const again = only(apiCalls(resent, "execute"));
      expect(again.request).toEqual(exec.request);
      expect(again.flow).not.toBe(exec.flow);
      expect(s.receipt.signing).toEqual({ kind: "submitted" });
      expect(apiCalls(resent, "status")).toEqual([]);

      s.send({
        type: "ExecuteReplied",
        flow: again.flow,
        result: { ok: true, response: { success: true, intentId: "xi_1", status: "completed" } },
      });
      expect(s.intent.status).toBe("completed");
      expect(s.receipt.phase).toBe("success");
      expect(s.model.sign).toBeNull();
    });

    it("stops after three resends: not sent yet, still polling, no Retry", () => {
      const { s, exec } = executing();
      let flow = exec.flow;
      for (let resend = 1; resend <= 3; resend++) {
        const fx = s.send(busy(flow, nowSec(s) + 5));
        expect(s.receipt.signing).toMatchObject({ kind: "busy", resend, of: 3 });
        const next = s.send(
          { type: "TimerFired", timer: "execute" },
          only(timerSet(fx, "execute")),
        );
        const call = only(apiCalls(next, "execute"));
        expect(call.request).toEqual(exec.request);
        flow = call.flow;
      }
      // A 4th refusal the client sees need not be the Worker's budget (its
      // wallet rate limit counts none), so the row may still be executable.
      const retryAfter = nowSec(s) + 5;
      const fx = s.send(busy(flow, retryAfter));
      expect(timerSet(fx, "execute")).toEqual([]);
      expectNotSent(s);
      expect(s.intent.error).toEqual({ message: "HTTP 503: Solver busy", code: 503, retryAfter });
      expect(apiCalls(s.send({ type: "TimerFired", timer: "execute" }, 5000), "execute")).toEqual(
        [],
      );
      expect(only(apiCalls(s.send({ type: "TimerFired", timer: "poll" }), "status")).intentId).toBe(
        "xi_1",
      );
    });

    it("reaches Retry through the Worker's budget 502 after three resends, not a countdown", () => {
      const { s, exec } = executing();
      let flow = exec.flow;
      for (let resend = 1; resend <= 3; resend++) {
        const fx = s.send(busy(flow, nowSec(s) + 5));
        const next = s.send(
          { type: "TimerFired", timer: "execute" },
          only(timerSet(fx, "execute")),
        );
        flow = only(apiCalls(next, "execute")).flow;
      }
      // The Worker's 4th refusal: its budget finish, a 502 `failed` marked
      // `not_executed`; thrown like any other, so the poll decides it.
      s.send({
        type: "ExecuteReplied",
        flow,
        result: { ok: false, error: { rejected: false, value: "HTTP 502", detail: "502" } },
      });
      expect(s.receipt.phase).toBe("pending");
      const poll = s.model.poll;
      if (!poll) throw new Error("no poll armed");
      s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.polls,
        result: {
          ok: true,
          status: statusData({ status: "failed", terminal: true, substatus: "not_executed" }),
        },
      });
      expect(s.intent.status).toBe("failed");
      expect(s.receipt.phase).toBe("failed");
    });

    it("never resends past the quote deadline: not sent yet instead", () => {
      // Retry-After lands after the quote expires (60 s after it was served).
      const late = executing();
      const retryAfter = nowSec(late.s) + 120;
      const fx = late.s.send(busy(late.exec.flow, retryAfter));
      expect(timerSet(fx, "execute")).toEqual([]);
      expectNotSent(late.s, "late");
      expect(late.s.intent.error).toMatchObject({ code: 503, retryAfter });

      // A wait that was in time, but whose timer fires past the deadline.
      const throttled = executing();
      throttled.s.send(busy(throttled.exec.flow, nowSec(throttled.s) + 5));
      const fired = throttled.s.send({ type: "TimerFired", timer: "execute" }, 70_000);
      expect(apiCalls(fired, "execute")).toEqual([]);
      // Off the resend wait: the real poll re-arms and reads at once.
      expect(only(apiCalls(fired, "status")).intentId).toBe("xi_1");
      expectNotSent(throttled.s, "throttled");
      expect(throttled.s.intent.error).toMatchObject({ code: 503 });

      // No Retry-After, or one older than a minute: nothing to wait for.
      for (const [label, retryAt] of [
        ["no retry_after", undefined],
        ["stale retry_after", T0 / 1000 - 3600],
      ] as const) {
        const unhinted = executing();
        unhinted.s.send(busy(unhinted.exec.flow, retryAt));
        expectNotSent(unhinted.s, label);
      }
    });

    it("resends from the poll timer when the host never fires the execute timer", () => {
      const { s, exec } = executing();
      const fx = s.send(busy(exec.flow, nowSec(s) + 5));
      expect(timerSet(fx, "poll")).toEqual([STATUS_POLL_MS]);
      const delay = only(timerSet(fx, "execute"));
      // The host drops `execute`. Its poll ticks read no status, and the first
      // one at or after the resend time does the timer's work, never earlier.
      const early = s.send({ type: "TimerFired", timer: "poll" }, delay - 1);
      expect(apiCalls(early, "execute")).toEqual([]);
      expect(apiCalls(early, "status")).toEqual([]);
      const late = s.send({ type: "TimerFired", timer: "poll" }, 1);
      expect(only(apiCalls(late, "execute")).request).toEqual(exec.request);
      expect(timers(late)).toContain("clear:execute");
      expect(s.receipt.signing).toEqual({ kind: "submitted" });
      // The dropped timer firing after all sends nothing more.
      expect(apiCalls(s.send({ type: "TimerFired", timer: "execute" }), "execute")).toEqual([]);

      // A tab returning past the deadline with no timer ever fired: not sent
      // yet, polling, rather than a wait forever.
      const away = executing();
      away.s.send(busy(away.exec.flow, nowSec(away.s) + 5));
      away.s.hidden = true;
      away.s.send({ type: "VisibilityChanged" });
      away.s.hidden = false;
      const back = away.s.send({ type: "VisibilityChanged" }, 70_000);
      expect(apiCalls(back, "execute")).toEqual([]);
      expectNotSent(away.s);
    });

    it("after a give-up, polls `quoted` until the Worker's finish: Retry only on not_executed", () => {
      const givenUp = () => {
        const { s, exec } = executing();
        s.send(busy(exec.flow, undefined));
        expectNotSent(s);
        // No Retry while the row reads `quoted`, for as long as the Worker
        // may still let the signed request execute (past the flat ceiling).
        const ticks = Math.ceil((workerFinishMs(s) - s.now) / STATUS_POLL_MS);
        expect(pollReads(s, statusData({ status: "quoted" }), ticks)).toBe(ticks);
        expect(s.intent.pollExhausted).toBe(false);
        expectNotSent(s);
        return s;
      };
      const finished = givenUp();
      pollReads(
        finished,
        statusData({ status: "failed", terminal: true, substatus: "not_executed" }),
        1,
      );
      expect(finished.intent.status).toBe("failed");
      expect(finished.intent.notSent).toBe(false);
      expect(finished.intent.mayHaveMoved).toBe(false);
      expect(finished.receipt.phase).toBe("failed");

      // A `failed` without the marker: something else executed it.
      const unmarked = givenUp();
      pollReads(unmarked, statusData({ status: "failed", terminal: true }), 1);
      expect(unmarked.intent.notSent).toBe(false);
      expect(unmarked.receipt.phase).toBe("may-have-moved");

      // Another execute claimed it (the host resent the signed request):
      // no longer "not sent", and in doubt.
      const claimed = givenUp();
      pollReads(claimed, statusData({ status: "executing" }), 1);
      expect(claimed.intent.notSent).toBe(false);
      expect(claimed.intent.reconciling).toBe(true);
      expect(claimed.receipt.phase).toBe("pending");
    });

    /** Answer the poll's next read with a 404, `advanceMs` after the previous one. */
    const notFoundRead = (s: Session, advanceMs: number) => {
      const asked = apiCalls(s.send({ type: "TimerFired", timer: "poll" }, advanceMs), "status");
      const { gen, attempt } = only(asked);
      return s.send({
        type: "StatusReplied",
        gen,
        attempt,
        result: { ok: true, status: { notFound: true } },
      });
    };

    it("offers Retry on a 404 after a give-up: the sweep deleted the untouched row", () => {
      // A frozen tab: the give-up came from refusals that claimed nothing (the
      // Worker's rate-limit 503), the tab reads nothing from the signed
      // deadline + 60 s to past the 30-minute sweep, then wakes to 404s.
      const { s, exec } = executing();
      s.send(busy(exec.flow, undefined));
      expectNotSent(s);
      pollReads(s, statusData({ status: "quoted" }), 3);
      const frozenMs = workerFinishMs(s) - s.now + 31 * 60_000;
      const fx = notFoundRead(s, frozenMs);
      expect(s.intent.status).toBe("failed");
      expect(s.intent.notSent).toBe(false);
      expect(s.intent.mayHaveMoved).toBe(false);
      expect(s.intent.error).toBe("This order expired without being sent. Nothing moved.");
      expect(s.receipt.phase).toBe("failed");
      expect(logs(fx, "warn").join(" ")).toMatch(/swept unexecuted/);
      // The poll is over.
      expect(pollReads(s, statusData({ status: "quoted" }), 1)).toBe(0);
    });

    it("holds a not-sent 404 until the Worker's finish has passed", () => {
      // A 404 that is not the sweep's (a router "Not found", a proxy, a
      // rollback) while the signed request can still be claimed: no Retry.
      const { s, exec } = executing();
      s.send(busy(exec.flow, undefined));
      pollReads(s, statusData({ status: "quoted" }), 1);
      const early = notFoundRead(s, STATUS_POLL_MS);
      expectNotSent(s, "early");
      expect(s.intent.mayHaveMoved).toBe(false);
      expect(logs(early, "warn").join(" ")).toMatch(/holding, not failing/);
      // Exactly at the finish, still claimable on the Worker's clock: held.
      notFoundRead(s, workerFinishMs(s) - s.now);
      expectNotSent(s, "at the finish");
      // One millisecond past it nothing can claim the row: Retry.
      notFoundRead(s, 1);
      expect(s.intent.status).toBe("failed");
      expect(s.intent.mayHaveMoved).toBe(false);
      expect(s.receipt.phase).toBe("failed");

      // The same for the Worker's `quoted` reply to the execute itself (its
      // row is touched, so the sweep never deletes it: an early 404 is never
      // the sweep's).
      const replied = executing();
      replied.s.send({
        type: "ExecuteReplied",
        flow: replied.exec.flow,
        result: {
          ok: true,
          response: { success: false, intentId: "xi_1", status: "quoted", reconciling: true },
        },
      });
      notFoundRead(replied.s, STATUS_POLL_MS);
      expect(replied.s.intent.notSent).toBe(true);
      expect(replied.s.receipt.phase).toBe("not-sent");
      notFoundRead(replied.s, workerFinishMs(replied.s) - replied.s.now + 1);
      expect(replied.s.receipt.phase).toBe("failed");
    });

    it("holds on a 404 outside not sent yet: an execute that may have been claimed", () => {
      // A thrown execute, in doubt.
      const thrown = executing();
      thrown.s.send({
        type: "ExecuteReplied",
        flow: thrown.exec.flow,
        result: { ok: false, error: { rejected: false, value: "HTTP 502", detail: "502" } },
      });
      // Not sent yet, then an `executing` read: another execute claimed it.
      const claimed = executing();
      claimed.s.send(busy(claimed.exec.flow, undefined));
      pollReads(claimed.s, statusData({ status: "executing" }), 1);
      for (const [label, s] of [
        ["thrown", thrown.s],
        ["claimed after a give-up", claimed.s],
      ] as const) {
        const fx = notFoundRead(s, STATUS_POLL_MS);
        expect(s.intent.status, label).toBe("executing");
        expect(s.intent.reconciling, label).toBe(true);
        expect(s.receipt.phase, label).toBe("pending");
        expect(logs(fx, "warn").join(" "), label).toMatch(/holding, not failing/);
      }
    });

    it("holds not sent yet when the amount is cleared, and on a stream `quoted` frame", () => {
      const { s, exec } = executing();
      s.send(busy(exec.flow, undefined));
      s.send({ type: "QuoteRequested", amount: "" });
      expectNotSent(s);
      s.send({
        type: "StreamStatus",
        message: { type: "intent_status", intentId: "xi_1", status: "quoted", timestamp: "t" },
      });
      expectNotSent(s);
    });

    it("stays in doubt unless the flag is exactly true", () => {
      for (const flag of ["true", 1, false, null]) {
        const { s, exec } = executing();
        const fx = s.send(busy(exec.flow, nowSec(s) + 5, flag));
        expect(timerSet(fx, "execute"), String(flag)).toEqual([]);
        expect(s.intent.status, String(flag)).toBe("executing");
        expect(s.intent.reconciling, String(flag)).toBe(true);
        expect(s.receipt.phase, String(flag)).toBe("pending");
      }
    });

    it("never resends after the execute answer put the intent in doubt", () => {
      const { s, exec } = executing(quote({ expiry: new Date(T0 + 600_000).toISOString() }));
      s.send({
        type: "ExecuteReplied",
        flow: exec.flow,
        result: {
          ok: false,
          error: { rejected: false, value: "timeout", detail: "timeout" },
        },
      });
      expect(s.intent.reconciling).toBe(true);

      const fx = s.send(busy(exec.flow, nowSec(s) + 5));
      expect(timerSet(fx, "execute")).toEqual([]);
      expect(apiCalls(fx, "execute")).toEqual([]);
      expect(s.intent.status).toBe("executing");
      expect(s.intent.reconciling).toBe(true);
      expect(s.receipt.phase).toBe("pending");
    });

    it("drops the pending resend when the intent moves on or the user resets", () => {
      const moved = executing();
      moved.s.send(busy(moved.exec.flow, nowSec(moved.s) + 5));
      const fx = moved.s.send({
        type: "StreamStatus",
        message: { type: "intent_status", intentId: "xi_1", status: "bridging", timestamp: "t" },
      });
      expect(timers(fx)).toContain("clear:execute");
      expect(moved.s.model.sign).toBeNull();
      expect(
        apiCalls(moved.s.send({ type: "TimerFired", timer: "execute" }, 5000), "execute"),
      ).toEqual([]);

      const reset = executing();
      reset.s.send(busy(reset.exec.flow, nowSec(reset.s) + 5));
      expect(timers(reset.s.send({ type: "ResetRequested" }))).toContain("clear:execute");
      expect(
        apiCalls(reset.s.send({ type: "TimerFired", timer: "execute" }, 5000), "execute"),
      ).toEqual([]);
    });
  });
});

describe("two signatures (origin pull)", () => {
  const pulled = () => quote({ pullAuthorization: erc3009Pull() });

  it("prompts the pull straight after the intent on an injected wallet", () => {
    const s = new Session();
    s.quoteWith(pulled());
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 2 });
    const prompt = signIntent(s);
    expect(s.receipt.signing).toEqual({ kind: "in_wallet", step: 1, of: 2 });

    const approval = only(
      walletCalls(
        s.send({
          type: "SignReplied",
          flow: prompt.flow,
          purpose: "intent",
          result: { ok: true, signature: "0xintent" },
        }),
        "ensureApproval",
      ),
    );
    expect(approval.amount).toBe(AMOUNT);

    const pullFx = s.send({
      type: "ApprovalReplied",
      flow: approval.flow,
      result: { ok: true, approved: true },
    });
    const pull = only(walletCalls(pullFx, "signTypedData"));
    expect(pull.purpose).toBe("pull");
    expect(timers(pullFx)).toContain("set:signPrompt");
    expect(s.receipt.signing).toEqual({ kind: "in_wallet", step: 2, of: 2 });

    const fx = s.send({
      type: "SignReplied",
      flow: pull.flow,
      purpose: "pull",
      result: { ok: true, signature: "0xpull" },
    });
    expect(timers(fx)).toContain("clear:signPrompt");
    expect(only(apiCalls(fx, "execute")).request).toMatchObject({
      signature: "0xintent",
      pullSignature: "0xpull",
    });
    expect(s.intent.status).toBe("executing");
  });

  /** Sign the intent on a pull quote and answer the approval; returns the reply's effects. */
  const answerApproval = (s: Session, approved: boolean) => {
    const prompt = signIntent(s);
    const approval = only(
      walletCalls(
        s.send({
          type: "SignReplied",
          flow: prompt.flow,
          purpose: "intent",
          result: { ok: true, signature: "0xintent" },
        }),
        "ensureApproval",
      ),
    );
    return s.send({ type: "ApprovalReplied", flow: approval.flow, result: { ok: true, approved } });
  };

  it("never approves or signs a pull that pays an unpinned address, and says so", () => {
    const s = new Session();
    s.quoteWith(quote({ pullAuthorization: erc3009Pull(ATTACKER) }));
    const prompt = signIntent(s);
    const fx = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    // Refused before the approval: an unlimited allowance is never requested
    // for a pull the client will not sign.
    expect(walletCalls(fx, "ensureApproval")).toHaveLength(0);
    expect(walletCalls(fx, "signTypedData")).toHaveLength(0);
    expect(apiCalls(fx, "execute")).toHaveLength(0);
    expect(s.intent.status).toBe("quoted");
    expect(s.receipt.quote).toMatchObject({ kind: "ready" });
    expect(s.receipt.signing).toEqual({ kind: "refused", refusal: { kind: "pull_unpinned" } });
    expect(logs(fx, "error")).toContain("[useIntent] Refusing to sign origin pull:");

    // The held intent signature went with it: a "Sign 2 of 2" tap cannot pair
    // it with a pull now.
    expect(s.model.pendingIntentSig).toBeNull();
    expect(s.send({ type: "PullSignRequested" })).toEqual([]);
  });

  it("says the token needs approval when the approval was not granted", () => {
    const s = new Session();
    s.quoteWith(pulled());
    const fx = answerApproval(s, false);
    expect(walletCalls(fx, "signTypedData")).toHaveLength(0);
    expect(s.intent.status).toBe("quoted");
    expect(s.receipt.signing).toEqual({ kind: "refused", refusal: { kind: "approval_required" } });
    expect(s.model.pendingIntentSig).toBeNull();
  });

  it("waits for a tap on a deep-link wallet, then signs 2 of 2", () => {
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(pulled());
    const prompt = signIntent(s);
    const held = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    expect(walletCalls(held, "ensureApproval")).toHaveLength(0);
    expect(s.model.awaitingPull).toBe(true);
    expect(s.receipt.signing).toEqual({ kind: "awaiting_second" });

    const approval = only(walletCalls(s.send({ type: "PullSignRequested" }), "ensureApproval"));
    expect(s.model.isSigningPull).toBe(true);
    // A second tap while the first is in flight starts nothing.
    expect(s.send({ type: "PullSignRequested" })).toEqual([]);

    const pull = only(
      walletCalls(
        s.send({
          type: "ApprovalReplied",
          flow: approval.flow,
          result: { ok: true, approved: true },
        }),
        "signTypedData",
      ),
    );
    const exec = only(
      apiCalls(
        s.send({
          type: "SignReplied",
          flow: pull.flow,
          purpose: "pull",
          result: { ok: true, signature: "0xpull" },
        }),
        "execute",
      ),
    );
    expect(exec.request).toMatchObject({ signature: "0xintent", pullSignature: "0xpull" });
    expect(s.model.awaitingPull).toBe(false);
    expect(s.model.isSigningPull).toBe(true);

    s.send({
      type: "ExecuteReplied",
      flow: exec.flow,
      result: { ok: true, response: { success: true, intentId: "xi_1", status: "settling" } },
    });
    expect(s.model.isSigningPull).toBe(false);
    expect(s.model.pendingIntentSig).toBeNull();
  });

  it("re-arms step 2 when the deep-link prompt never comes back", () => {
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(pulled());
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    const approval = only(walletCalls(s.send({ type: "PullSignRequested" }), "ensureApproval"));
    const pull = only(
      walletCalls(
        s.send({
          type: "ApprovalReplied",
          flow: approval.flow,
          result: { ok: true, approved: true },
        }),
        "signTypedData",
      ),
    );

    s.send({ type: "TimerFired", timer: "signPrompt" }, SIGN_PROMPT_TIMEOUT_MS);
    expect(s.intent.error).toBe(
      "Couldn't reach the wallet. Tap to try the second signature again.",
    );
    expect(s.model.awaitingPull).toBe(true);
    expect(s.model.isSigningPull).toBe(false);
    expect(s.model.pendingIntentSig).toBe("0xintent");

    // The dead prompt answering late changes nothing.
    const late = s.send({
      type: "SignReplied",
      flow: pull.flow,
      purpose: "pull",
      result: { ok: true, signature: "0xlate" },
    });
    expect(apiCalls(late, "execute")).toHaveLength(0);
  });

  it("expires the quote, never strands the ceremony, when step 2 is tapped too late", () => {
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(pulled());
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    const fx = s.send({ type: "PullSignRequested" }, 61_000);
    expect(walletCalls(fx, "ensureApproval")).toHaveLength(0);
    expect(s.intent.status).toBe("expired");
    expect(s.model.awaitingPull).toBe(false);
    expect(s.model.pendingIntentSig).toBeNull();
    expect(s.model.sign).toBeNull();
  });

  it("forgets a half-finished two-step signing when the amount is cleared", () => {
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(pulled());
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    s.send({ type: "QuoteRequested", amount: "" });
    expect(s.model.awaitingPull).toBe(false);
    expect(s.model.pendingIntentSig).toBeNull();

    // The next quote starts its own ceremony: nothing from the old one carries.
    s.quoteWith(pulled());
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 2 });
    expect(s.send({ type: "PullSignRequested" })).toEqual([]);
  });

  it("pins the pull to the quoted input, not an amount typed mid-ceremony", () => {
    // The intent was signed at AMOUNT; an edit behind the "Sign 2 of 2" step
    // does not make the matching pull an unpinned one.
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(pulled());
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    s.send({ type: "QuoteRequested", amount: "500000" });
    const approval = only(walletCalls(s.send({ type: "PullSignRequested" }), "ensureApproval"));
    expect(approval.amount).toBe(AMOUNT);
    const fx = s.send({
      type: "ApprovalReplied",
      flow: approval.flow,
      result: { ok: true, approved: true },
    });
    expect(only(walletCalls(fx, "signTypedData")).purpose).toBe("pull");
    expect(s.intent.refusal).toBeNull();
  });
});

describe("status", () => {
  const resumed = (
    status: "executing" | "settling" | "awaiting_deposit" | "bridging" = "executing",
  ) => {
    const s = new Session();
    const fx = s.send({
      type: "ResumeRequested",
      intentId: "xi_1",
      status,
      owner: WALLET,
      depositDeadline: null,
    });
    return { s, poll: only(apiCalls(fx, "status")) };
  };

  for (const terminal of ["completed", "failed"] as const) {
    it(`ignores a ${terminal} response for another intent and accepts the next valid poll`, () => {
      const { s, poll } = resumed("settling");
      const before = { intent: s.intent, poll: s.model.poll };
      const mismatched = s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.attempt,
        result: {
          ok: true,
          status: statusData({ intentId: "xi_other", status: terminal, terminal: true }),
        },
      });

      expect(s.intent).toEqual(before.intent);
      expect(s.model.poll).toEqual(before.poll);
      expect(s.model.poll?.answered).toBe(0);
      expect(timers(mismatched)).not.toContain("clear:poll");
      expect(logs(mismatched, "warn").join(" ")).toMatch(/another intent/);

      const next = only(
        apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      const valid = s.send({
        type: "StatusReplied",
        gen: next.gen,
        attempt: next.attempt,
        result: { ok: true, status: statusData({ status: terminal, terminal: true }) },
      });
      expect(s.intent.status).toBe(terminal);
      expect(timers(valid)).toContain("clear:poll");
    });
  }

  it("resumes a stored failed as Retry only with the not_executed marker", () => {
    const resume = (substatus?: string | null) => {
      const s = new Session();
      const fx = s.send({
        type: "ResumeRequested",
        intentId: "xi_1",
        status: "failed",
        owner: WALLET,
        depositDeadline: null,
        ...(substatus === undefined ? {} : { substatus }),
      });
      // Terminal either way: nothing to poll.
      expect(apiCalls(fx, "status"), String(substatus)).toEqual([]);
      return s;
    };
    for (const substatus of [undefined, null, "fill_failed", "pulling"]) {
      const s = resume(substatus);
      expect(s.intent.status, String(substatus)).toBe("failed");
      expect(s.receipt.phase, String(substatus)).toBe("may-have-moved");
    }
    expect(resume("not_executed").receipt.phase).toBe("failed");

    // Resumed in flight, the poll's `failed` follows the same rule.
    const reply = (s: Session, status: IntentStatusData) => {
      const poll = s.model.poll;
      if (!poll) throw new Error("no poll armed");
      s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.polls,
        result: { ok: true, status },
      });
    };
    const bare = resumed("executing").s;
    reply(bare, statusData({ status: "failed", terminal: true }));
    expect(bare.receipt.phase).toBe("may-have-moved");
    const marked = resumed("settling").s;
    reply(marked, statusData({ status: "failed", terminal: true, substatus: "not_executed" }));
    expect(marked.receipt.phase).toBe("failed");
  });

  describe("a resumed executing intent that reads quoted", () => {
    const answer = (s: Session, poll: { gen: number; attempt: number }, data: IntentStatusData) =>
      s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.attempt,
        result: { ok: true, status: data },
      });
    const notFound = (s: Session, advanceMs: number) => {
      const asked = only(
        apiCalls(s.send({ type: "TimerFired", timer: "poll" }, advanceMs), "status"),
      );
      return s.send({
        type: "StatusReplied",
        gen: asked.gen,
        attempt: asked.attempt,
        result: { ok: true, status: { notFound: true } },
      });
    };

    it("is rebuilt as not sent yet, and a 404 with no quote holds", () => {
      const { s, poll } = resumed("executing");
      const fx = answer(s, poll, statusData({ status: "quoted" }));
      expect(s.intent.status).toBe("executing");
      expect(s.intent.notSent).toBe(true);
      expect(s.intent.reconciling).toBe(false);
      expect(s.receipt.phase).toBe("not-sent");
      expect(logs(fx, "warn").join(" ")).toMatch(/reads quoted after execute: not sent yet/);
      // No quote to size the ceiling by: each `quoted` read refills it, past
      // the flat ceiling and the "Still confirming" escalation.
      const flat = Math.ceil(STATUS_POLL_FLAT_CEILING_MS / STATUS_POLL_MS);
      expect(pollReads(s, statusData({ status: "quoted" }), flat + 5)).toBe(flat + 5);
      expect(s.intent.pollExhausted).toBe(false);
      expect(s.intent.reconciling).toBe(false);
      expect(s.receipt.phase).toBe("not-sent");
      // The tab freezes past the sweep and wakes to a 404. With no quote the
      // Worker's finish is unknown, so it holds (Reset ends it).
      const held = notFound(s, 31 * 60_000);
      expect(s.intent.status).toBe("executing");
      expect(s.intent.notSent).toBe(true);
      expect(s.receipt.phase).toBe("not-sent");
      expect(s.model.poll?.stopped).toBe(false);
      expect(logs(held, "warn").join(" ")).toMatch(/holding, not failing/);
      // The Worker's own finish is Retry.
      pollReads(s, statusData({ status: "failed", terminal: true, substatus: "not_executed" }), 1);
      expect(s.intent.notSent).toBe(false);
      expect(s.receipt.phase).toBe("failed");
    });

    it("stays in doubt once escalated, and is never rebuilt from this tab's own execute", () => {
      const { s, poll } = resumed("executing");
      answer(s, poll, statusData({ status: "executing" }));
      pollReads(s, statusData({ status: "executing" }), RECONCILE_AFTER_ATTEMPTS);
      expect(s.intent.reconciling).toBe(true);
      pollReads(s, statusData({ status: "quoted" }), 1);
      expect(s.intent.notSent).toBe(false);
      expect(s.receipt.phase).toBe("pending");

      // A hand-built unmapped `quoted` is no answer about the row: in doubt.
      const odd = resumed("executing");
      answer(odd.s, odd.poll, statusData({ status: "quoted", unmapped: true }));
      expect(odd.s.intent.notSent).toBe(false);
      expect(odd.s.receipt.phase).toBe("pending");

      // This tab gets the same verdict after /execute answers. The poll was
      // not armed before then, so the read cannot predate acceptance.
      const own = new Session();
      own.quoteWith(quote());
      const prompt = signIntent(own);
      const exec = only(
        apiCalls(
          own.send({
            type: "SignReplied",
            flow: prompt.flow,
            purpose: "intent",
            result: { ok: true, signature: "0xsig" },
          }),
          "execute",
        ),
      );
      own.send({
        type: "ExecuteReplied",
        flow: exec.flow,
        result: { ok: true, response: { success: true, intentId: "xi_1", status: "executing" } },
      });
      expect(own.model.sign).toBeNull();
      expect(own.intent.reconciling).toBe(false);
      pollReads(own, statusData({ status: "quoted" }), 1);
      expect(own.intent.notSent).toBe(true);
      expect(own.receipt.phase).toBe("not-sent");
    });

    it("is not rebuilt by a late quoted reply after a newer executing or 404 reply", () => {
      const { s, poll } = resumed("executing");
      answer(s, poll, statusData({ status: "executing" }));
      // A timer read, then an off-interval read (the tab returning), both in
      // flight: the newer answers `executing`, the older `quoted` after it.
      const older = only(
        apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      const newer = only(apiCalls(s.send({ type: "VisibilityChanged" }, 100), "status"));
      expect(newer.attempt).toBeGreaterThan(older.attempt);
      answer(s, newer, statusData({ status: "executing" }));
      const late = answer(s, older, statusData({ status: "quoted" }));
      expect(s.intent.notSent).toBe(false);
      expect(s.receipt.phase).toBe("submitting");
      expect(logs(late, "warn").join(" ")).not.toMatch(/not sent yet/);
      // The next read in order still rebuilds it.
      pollReads(s, statusData({ status: "quoted" }), 1);
      expect(s.intent.notSent).toBe(true);
      expect(s.receipt.phase).toBe("not-sent");

      // The inverse ordering is equally monotonic: once the newer read proves
      // the intent is unclaimed, an older in-flight read cannot undo it.
      const inverse = resumed("executing");
      answer(inverse.s, inverse.poll, statusData({ status: "executing" }));
      const oldExecuting = only(
        apiCalls(inverse.s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      const newQuoted = only(
        apiCalls(inverse.s.send({ type: "VisibilityChanged" }, 100), "status"),
      );
      answer(inverse.s, newQuoted, statusData({ status: "quoted" }));
      expect(inverse.s.receipt.phase).toBe("not-sent");
      answer(inverse.s, oldExecuting, statusData({ status: "executing" }));
      expect(inverse.s.intent.notSent).toBe(true);
      expect(inverse.s.receipt.phase).toBe("not-sent");

      // A thrown newer read answers nothing: the older `quoted` still rebuilds.
      const thrown = resumed("executing");
      answer(thrown.s, thrown.poll, statusData({ status: "executing" }));
      const first = only(
        apiCalls(thrown.s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      const second = only(apiCalls(thrown.s.send({ type: "VisibilityChanged" }, 100), "status"));
      thrown.s.send({
        type: "StatusReplied",
        gen: second.gen,
        attempt: second.attempt,
        result: { ok: false, error: { rejected: false, value: "HTTP 502", detail: "502" } },
      });
      answer(thrown.s, first, statusData({ status: "quoted" }));
      expect(thrown.s.intent.notSent).toBe(true);
      expect(thrown.s.receipt.phase).toBe("not-sent");

      // A newer 404 is a reply too: the older `quoted` after it is no rebuild.
      const gone = resumed("executing");
      answer(gone.s, gone.poll, statusData({ status: "executing" }));
      const before = only(
        apiCalls(gone.s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      const after = only(apiCalls(gone.s.send({ type: "VisibilityChanged" }, 100), "status"));
      gone.s.send({
        type: "StatusReplied",
        gen: after.gen,
        attempt: after.attempt,
        result: { ok: true, status: { notFound: true } },
      });
      answer(gone.s, before, statusData({ status: "quoted" }));
      expect(gone.s.intent.notSent).toBe(false);
      expect(gone.s.receipt.phase).toBe("submitting");
    });

    it("is rebuilt only from executing: a resumed later phase reading quoted is not", () => {
      for (const status of ["settling", "awaiting_deposit", "bridging"] as const) {
        const { s, poll } = resumed(status);
        answer(s, poll, statusData({ status: "quoted" }));
        expect(s.intent.status).toBe(status);
        expect(s.intent.notSent).toBe(false);
        expect(s.receipt.phase).not.toBe("not-sent");
      }
    });
  });

  it("decodes an unmapped Riddler status to Still confirming, never completed", () => {
    const { s, poll } = resumed("executing");
    const decoded = decodeWireStatus("some_future_state");
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({ status: decoded.status, unmapped: decoded.kind === "unmapped" }),
      },
    });
    expect(s.intent.status).toBe("executing");
    expect(s.intent.reconciling).toBe(true);
    expect(s.receipt.phase).toBe("pending");
  });

  it("holds Still confirming even when the server calls the unmapped status terminal", () => {
    const { s, poll } = resumed("settling");
    const fx = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({ status: "executing", unmapped: true, terminal: true }),
      },
    });
    expect(s.intent.status).not.toBe("completed");
    expect(s.receipt.phase).toBe("pending");
    expect(timers(fx)).toContain("clear:poll");
  });

  it("shows a withheld but confirmed fill as delivered, without ending the poll", () => {
    const { s, poll } = resumed("settling");
    const fx = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({
          status: "settling",
          legsWithheld: true,
          settlementConfirmed: true,
        }),
      },
    });
    expect(s.intent.status).toBe("settling");
    expect(s.intent.substatus).toBe("filled");
    expect(s.intent.settlementTxHash).toBeNull();
    expect(timers(fx)).not.toContain("clear:poll");
  });

  it("never reads settlementConfirmed as delivered on an unmapped status", () => {
    const { s, poll } = resumed("executing");
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({
          status: "executing",
          unmapped: true,
          legsWithheld: true,
          settlementConfirmed: true,
        }),
      },
    });
    expect(s.intent.substatus).not.toBe("filled");
  });

  it("never reads settlementConfirmed as delivered off a read that withheld nothing", () => {
    const { s, poll } = resumed("settling");
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: { ok: true, status: statusData({ status: "settling", settlementConfirmed: true }) },
    });
    expect(s.intent.substatus).not.toBe("filled");
  });

  it("never shows a terminal failure as delivered, whatever settlementConfirmed says", () => {
    const s = new Session();
    const poll = only(
      apiCalls(
        s.send({
          type: "ResumeRequested",
          intentId: "xi_1",
          status: "awaiting_deposit",
          owner: WALLET,
          depositDeadline: Math.floor(s.now / 1000) + 3600,
        }),
        "status",
      ),
    );
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: {
        ok: true,
        status: statusData({
          status: "expired",
          terminal: true,
          legsWithheld: true,
          settlementConfirmed: true,
        }),
      },
    });
    expect(s.intent.status).toBe("expired");
    expect(s.intent.substatus).not.toBe("filled");
  });

  it("tracks each poll's withheld-legs verdict: set by an anonymous read, cleared by an owner read", () => {
    const { s, poll } = resumed("settling");
    expect(s.intent.legsWithheld).toBeNull();
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: { ok: true, status: statusData({ status: "settling", legsWithheld: true }) },
    });
    expect(s.intent.legsWithheld).toBe(true);
    const tick = only(
      apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
    );
    s.send({
      type: "StatusReplied",
      gen: tick.gen,
      attempt: tick.attempt,
      result: { ok: true, status: statusData({ status: "settling", settlementTxHash: "0xf" }) },
    });
    expect(s.intent.legsWithheld).toBe(false);
    expect(s.intent.settlementTxHash).toBe("0xf");
  });

  it("flips to the safe-to-close view after ~90s of polls without a change", () => {
    const { s } = resumed();
    let attempt = 1;
    let gen = s.model.poll!.gen;
    for (; attempt < RECONCILE_AFTER_ATTEMPTS; attempt++) {
      const tick = only(
        apiCalls(s.send({ type: "TimerFired", timer: "poll" }, STATUS_POLL_MS), "status"),
      );
      gen = tick.gen;
      s.send({
        type: "StatusReplied",
        gen,
        attempt: tick.attempt,
        result: { ok: true, status: statusData() },
      });
      if (tick.attempt < RECONCILE_AFTER_ATTEMPTS) expect(s.intent.reconciling).toBe(false);
    }
    expect(s.intent.reconciling).toBe(true);
    expect(s.receipt.phase).toBe("pending");
  });

  it("drops a reply from a poll that has since been re-armed", () => {
    const { s, poll } = resumed("executing");
    // A phase change re-arms: the old arming's late answer must not apply.
    const fx = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: { ok: true, status: statusData({ status: "bridging" }) },
    });
    const rearmed = only(apiCalls(fx, "status"));
    expect(rearmed.gen).not.toBe(poll.gen);
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: 2,
      result: { ok: true, status: statusData({ status: "completed", terminal: true }) },
    });
    expect(s.intent.status).toBe("bridging");
  });

  it("holds on a definitive 404 and reports it once", () => {
    const { s, poll } = resumed("settling");
    const first = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: 1,
      result: { ok: true, status: { notFound: true } },
    });
    const second = s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: 2,
      result: { ok: true, status: { notFound: true } },
    });
    expect(logs(first, "warn").join(" ")).toMatch(/holding, not failing/);
    expect(logs(second, "warn")).toEqual([]);
    expect(s.intent.status).toBe("settling");
    expect(s.intent.error).toBeNull();
  });
});

describe("resume", () => {
  const resume = (s: Session) =>
    s.send({
      type: "ResumeRequested",
      intentId: "xi_1",
      status: "settling",
      owner: WALLET,
      depositDeadline: null,
    });

  it("cancels the quote the form queued before the adopt", () => {
    // The panel restores the record's amount before it adopts, and that queues
    // a debounced quote. Left armed, it fires after the arming poll reports the
    // swap complete (not a busy state) and replaces the receipt with a signable
    // confirm for the same trade.
    const s = new Session();
    s.send({ type: "QuoteRequested", amount: AMOUNT });
    const fx = resume(s);
    expect(timers(fx)).toContain("clear:debounce");

    const poll = only(apiCalls(fx, "status"));
    s.send({
      type: "StatusReplied",
      gen: poll.gen,
      attempt: poll.attempt,
      result: { ok: true, status: statusData({ status: "completed", terminal: true }) },
    });
    expect(s.receipt.phase).toBe("success");
  });

  it("leaves a trade in progress, and the quote it queued, alone", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "QuoteRequested", amount: AMOUNT });
    expect(timers(resume(s))).toEqual([]);
    expect(s.intent.status).toBe("quoted");
  });
});

describe("a quote for a trade that has moved on", () => {
  const answer = (variant: "threw" | "declined" | "preview") =>
    variant === "threw"
      ? ({ ok: false, error: { rejected: false, value: null, detail: "boom" } } as const)
      : ({
          ok: true,
          quote:
            variant === "declined"
              ? quote({ canSolve: false, error: "unprofitable" })
              : quote({ preview: true, eip712Data: undefined }),
        } as const);

  for (const variant of ["threw", "declined", "preview"] as const) {
    it(`a refresh asked mid-ceremony never fails the swap (${variant})`, () => {
      const s = new Session();
      s.quoteWith(quote());
      const prompt = signIntent(s);
      const refresh = apiCalls(s.send({ type: "RefreshRequested" }), "quote");
      expect(refresh).toEqual([]);
      expect(s.model.flights).toEqual([]);

      const execute = only(
        apiCalls(
          s.send({
            type: "SignReplied",
            flow: prompt.flow,
            purpose: "intent",
            result: { ok: true, signature: "0xintent" },
          }),
          "execute",
        ),
      );
      s.send({ type: "QuoteReplied", flight: refresh[0]?.flight ?? "q1", result: answer(variant) });
      expect(s.intent.status).toBe("executing");
      s.send({
        type: "ExecuteReplied",
        flow: execute.flow,
        result: {
          ok: true,
          response: { success: true, intentId: "xi_1", status: "completed" },
        },
      });
      expect(s.intent.status).toBe("completed");
    });

    it(`a quote reply that finds the swap in flight is dropped (${variant})`, () => {
      // However the flight got there, its answer describes a trade that is gone.
      const other = new Session();
      const call = other.requestQuote();
      const s = new Session();
      s.quoteWith(quote());
      const prompt = signIntent(s);
      s.send({
        type: "SignReplied",
        flow: prompt.flow,
        purpose: "intent",
        result: { ok: true, signature: "0xintent" },
      });
      s.model = { ...s.model, flights: other.model.flights };
      const before = s.intent;
      const fx = s.send({ type: "QuoteReplied", flight: call.flight, result: answer(variant) });
      expect(s.intent).toBe(before);
      expect(s.model.flights).toEqual([]);
      expect(logs(fx, "warn")).toContain("[useIntent] Dropping a quote reply: intent is executing");
    });
  }

  it("stops offering the held quote once the amount changes", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "QuoteRequested", amount: "2500000" });
    expect(s.receipt.quote).toMatchObject({ kind: "ready" });
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toEqual([]);
    expect(s.intent.status).toBe("quoted");

    // Its replacement is signable again.
    const call = only(apiCalls(s.send({ type: "TimerFired", timer: "debounce" }, 500), "quote"));
    s.send({
      type: "QuoteReplied",
      flight: call.flight,
      result: {
        ok: true,
        quote: quote({ eip712Data: intentTypedData({ fromAmount: "2500000" }) }),
      },
    });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });
    expect(only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).purpose).toBe(
      "intent",
    );
  });

  it("stops offering the held quote once the trade on the form changes", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "ContextChanged", ctx: ctx({ slippageBps: 100 }) });
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toEqual([]);

    // Back to the quoted trade, its keys in another order: signable again.
    const reordered = Object.fromEntries(Object.entries(ctx()).reverse()) as typeof s.model.ctx;
    s.send({ type: "ContextChanged", ctx: reordered });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });
  });
});

describe("transitions", () => {
  it("logs a move the transition table refuses instead of applying it", () => {
    const s = new Session();
    s.quoteWith(quote());
    const fx = s.send({
      type: "StreamStatus",
      message: { type: "intent_status", intentId: "xi_1", status: "settling", timestamp: "t" },
    });
    expect(logs(fx, "warn")).toContain("[useIntent] Invalid transition: quoted -> settling");
    expect(s.intent.status).toBe("quoted");
  });

  it("resets a pre-execution quote when the wallet switches accounts", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "ContextChanged", ctx: ctx({}, { address: ATTACKER }) });
    expect(s.intent.status).toBe("idle");
    expect(s.intent.quote).toBeNull();
  });
});

describe("superseded and mismatched answers", () => {
  const FIVE = "5000000";
  const at = (amount: string, quoteId: string) =>
    quote({ quoteId, eip712Data: intentTypedData({ fromAmount: amount }) });

  it("never lands a quote for an amount the user has since corrected", () => {
    const s = new Session();
    const stale = s.requestQuote(FIVE);
    const fresh = s.requestQuote(AMOUNT);
    s.send({
      type: "QuoteReplied",
      flight: fresh.flight,
      result: { ok: true, quote: at(AMOUNT, "xq_Y") },
    });
    s.send({
      type: "QuoteReplied",
      flight: stale.flight,
      result: { ok: true, quote: at(FIVE, "xq_X") },
    });
    expect(s.intent.quoteId).toBe("xq_Y");
    expect(s.intent.quotedFromAmount).toBe(AMOUNT);
    expect(s.model.refresh?.amount).toBe(AMOUNT);
    expect(signIntent(s).typedData.message.fromAmount).toBe(AMOUNT);
  });

  it("drops a quote for a token switched away from, and asks again for the new one", () => {
    const s = new Session();
    const stale = s.requestQuote();
    const switched = ctx({ toToken: USDC_BASE });
    expect(timers(s.send({ type: "ContextChanged", ctx: switched }))).toContain("set:debounce");
    s.send({ type: "QuoteReplied", flight: stale.flight, result: { ok: true, quote: quote() } });
    expect(s.intent.quote).toBeNull();
    expect(s.intent.status).toBe("quoting");
    const again = only(apiCalls(s.send({ type: "TimerFired", timer: "debounce" }, 500), "quote"));
    expect(again.request.toToken).toBe(USDC_BASE);
  });

  it("refuses a wallet-bound request answered as a preview, and signs nothing", () => {
    const s = new Session();
    const fx = s.quoteWith(
      quote({
        preview: true,
        eip712Data: intentTypedData({ toChainId: 10, deadline: 32503680000 }),
      }),
    );
    expect(logs(fx, "error").join(" ")).toMatch(/wrong kind of request/);
    expect(s.intent.status).toBe("failed");
    expect(s.intent.quote).toBeNull();
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toHaveLength(0);
  });

  it("lets go of the public quote when stealth is held for its keys", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "ContextChanged", ctx: ctx({ settlementPreference: "stealth" }) });
    // Until the re-quote, the receipt names the settlement the held quote signs.
    expect(s.receipt.settlement).toEqual(settlementDisclosure("public"));

    const fx = s.send({ type: "RefreshRequested" });
    expect(apiCalls(fx, "quote")).toHaveLength(0);
    expect(s.intent.status).toBe("quoting");
    expect(s.intent.quote).toBeNull();
    expect(s.receipt.settlement).toEqual(settlementDisclosure("stealth"));
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toHaveLength(0);
  });

  it("ignores a status frame for an intent other than the held one", () => {
    const s = new Session();
    s.quoteWith(quote());
    const fx = s.send({
      type: "StreamStatus",
      message: { type: "intent_status", intentId: "xi_old", status: "executing", timestamp: "t" },
    });
    expect(logs(fx, "warn").join(" ")).toMatch(/another intent/);
    expect(s.intent.status).toBe("quoted");
  });
});

describe("a status update that skips the sign ceremony", () => {
  const executingFrame = {
    type: "StreamStatus",
    message: { type: "intent_status", intentId: "xi_1", status: "executing", timestamp: "t" },
  } as const;

  it("ends the ceremony, so the intent signature starts no pull leg", () => {
    const s = new Session();
    s.quoteWith(quote({ pullAuthorization: erc3009Pull() }));
    const prompt = signIntent(s);
    s.send(executingFrame);
    expect(s.intent.status).toBe("executing");
    expect(s.model.sign).toBeNull();

    const fx = s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    expect(walletCalls(fx, "ensureApproval")).toEqual([]);
    expect(walletCalls(fx, "signTypedData")).toEqual([]);
    expect(s.model.pendingIntentSig).toBeNull();
  });

  it("drops a held 'Sign 2 of 2' on a deep-link wallet", () => {
    const s = new Session(ctx({}, { stepwise: true }));
    s.quoteWith(quote({ pullAuthorization: erc3009Pull() }));
    const prompt = signIntent(s);
    s.send({
      type: "SignReplied",
      flow: prompt.flow,
      purpose: "intent",
      result: { ok: true, signature: "0xintent" },
    });
    expect(s.model.awaitingPull).toBe(true);

    s.send(executingFrame);
    expect(s.intent.status).toBe("executing");
    expect(s.model.awaitingPull).toBe(false);
    expect(s.model.pendingIntentSig).toBeNull();
    expect(s.receipt.signing).not.toEqual({ kind: "awaiting_second" });
    expect(s.send({ type: "PullSignRequested" })).toEqual([]);
  });
});

describe("the held quote's trade, as the request normalises it", () => {
  it("keeps the quote signable across edits that send the same request", () => {
    const s = new Session();
    s.quoteWith(quote());
    s.send({ type: "ContextChanged", ctx: ctx({ recipientAddress: "", refundAddress: "  " }) });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    // Stealth keys arriving under a public settlement are never sent.
    const stealthMetaAddress = {
      spendingPubKey: `0x02${"11".repeat(32)}`,
      viewingPubKey: `0x03${"22".repeat(32)}`,
      chainId: 8453,
    } as const;
    s.send({ type: "ContextChanged", ctx: ctx({ stealthMetaAddress }) });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    // A real change still lets go of it.
    s.send({ type: "ContextChanged", ctx: ctx({ recipientAddress: ATTACKER }) });
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });
  });

  it("sends the context's codes, normalised, and lets go of a quote when one changes", () => {
    const s = new Session(ctx({ ref: "partner", promo: " launch10 " }));
    const call = s.requestQuote();
    expect(call.request).toMatchObject({ ref: "PARTNER", promo: "LAUNCH10" });
    s.send({ type: "QuoteReplied", flight: call.flight, result: { ok: true, quote: quote() } });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    // The same codes in another spelling are the same request.
    s.send({ type: "ContextChanged", ctx: ctx({ ref: "PARTNER", promo: "LAUNCH10" }) });
    expect(s.receipt.signing).toEqual({ kind: "ready", signatures: 1 });

    // Another promo prices another deal.
    s.send({ type: "ContextChanged", ctx: ctx({ ref: "PARTNER", promo: "SPRING5" }) });
    expect(s.receipt.signing).toEqual({ kind: "unavailable" });
  });
});
