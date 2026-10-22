/**
 * The lifecycle on the machine alone: preview, connect, quote, 1- and
 * 2-signature signing, execute and status, driven message by message with a
 * test-owned clock. No React, no wallet, no network: every effect the machine
 * asks for is answered here, so each test reads as the protocol it pins.
 */

import { describe, it, expect } from "vitest";
import { STATUS_POLL_MS } from "./decisions.js";
import {
  RECONCILE_AFTER_ATTEMPTS,
  SIGN_PROMPT_TIMEOUT_MS,
  type Effect,
  type MsgBody,
} from "./machine.js";
import { settlementDisclosure } from "./receipt.js";
import { decodeWireStatus } from "./wire.js";
import {
  AMOUNT,
  ATTACKER,
  Session,
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
    // The poll arms with the phase: an immediate read plus the interval.
    expect(apiCalls(fx, "status")).toHaveLength(1);
    expect(timers(fx)).toContain("set:poll");

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

    it("cannot be handed a host-built verdict: the unreleased { decision } shape is in doubt", () => {
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
        { ok: true, response: { success: true, intentId: "xi_1", status: "done" } },
        { ok: false },
      ]) {
        const { s, flow } = executing();
        expect(() => s.send(foreign(flow, result))).not.toThrow();
        expect(s.intent.status).toBe("executing");
        expect(s.intent.reconciling).toBe(true);
      }
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

  it("never signs a pull that pays an unpinned address, and says so", () => {
    const s = new Session();
    s.quoteWith(quote({ pullAuthorization: erc3009Pull(ATTACKER) }));
    const fx = answerApproval(s, true);
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
  const resumed = (status: "executing" | "settling" = "executing") => {
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

  it("tracks each poll's withheld-legs verdict: set by an anonymous read, cleared by an owner read", () => {
    const { s, poll } = resumed("settling");
    expect(s.intent.legsWithheld).toBe(false);
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
});
