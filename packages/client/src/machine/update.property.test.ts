/**
 * Property tests for `update`: invariants that must hold after ANY sequence of
 * messages, not the wording of any one screen.
 *
 * Each generated run is a script of actions: user intents (type an amount,
 * confirm, tap "Sign 2 of 2", reset, resume, switch wallet or chain, background
 * the tab), timer firings, and answers to whichever effect is outstanding --
 * each answered with an arbitrary outcome (success, refusal, rejection, a
 * thrown error, a hostile or malformed payload, an unmapped status). The host
 * is the same scripted one the example tests use; nothing is mocked.
 *
 * Seed fixed for reproducible CI.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { MAX_EXECUTE_RESENDS, type IntentStatus } from "../shared/index.js";
import { POLL_INFLIGHT_STATES, QUOTE_BUSY_STATES } from "./decisions.js";
import {
  holdsCurrentQuote,
  init,
  update,
  type Context,
  type Effect,
  type ErrorReport,
  type Model,
  type Msg,
  type MsgBody,
  type TimerName,
} from "./machine.js";
import { view } from "./view.js";
import {
  AMOUNT,
  ATTACKER,
  CONFIG,
  SOLVER,
  T0,
  WALLET,
  ctx,
  erc3009Pull,
  intentTypedData,
  quote,
  statusData,
} from "./test/session.js";

const SEED = 0x577;
const FC_SETTINGS = { seed: SEED, numRuns: 250 } as const;

const STATUSES: IntentStatus[] = [
  "quoted",
  "executing",
  "bridging",
  "settling",
  "awaiting_deposit",
  "completed",
  "refunded",
  "failed",
  "expired",
];
const TIMERS: TimerName[] = ["debounce", "refresh", "expiry", "poll", "signPrompt", "execute"];
const WBTC = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

/** One scripted action. `pick` selects an outstanding effect; `variant` its outcome. */
type Action =
  | { kind: "user"; which: number; arg: number }
  | { kind: "timer"; timer: TimerName }
  | { kind: "answer"; pick: number; variant: number }
  | { kind: "wait"; ms: number }
  | { kind: "hide"; hidden: boolean };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("user" as const), which: fc.nat(9), arg: fc.nat(7) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("timer" as const),
      timer: fc.constantFrom(...TIMERS),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("answer" as const),
      pick: fc.nat(),
      variant: fc.nat(10),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("wait" as const),
      ms: fc.integer({ min: 0, max: 70_000 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("hide" as const), hidden: fc.boolean() }) },
);

const thrown = (rejected: boolean): ErrorReport => ({
  rejected,
  value: rejected ? "User rejected the request" : null,
  detail: "boom",
});

function userMsg(which: number, arg: number): MsgBody {
  switch (which) {
    case 0:
      return { type: "QuoteRequested", amount: [AMOUNT, "", "0", "2500000"][arg % 4] };
    case 1:
      return { type: "SignRequested" };
    case 2:
      return { type: "PullSignRequested" };
    case 3:
      return { type: "ResetRequested" };
    case 4:
      return { type: "RefreshRequested" };
    case 5:
      return { type: "VisibilityChanged" };
    case 6:
      return {
        type: "ResumeRequested",
        intentId: `xi_r${arg}`,
        status: STATUSES[arg % STATUSES.length],
        owner: WALLET,
        depositDeadline: arg % 2 ? null : Math.floor(T0 / 1000) + 1800,
      };
    case 7:
      return {
        type: "StreamStatus",
        message: {
          type: "intent_status",
          intentId: "xi_1",
          status: STATUSES[arg % STATUSES.length],
          timestamp: "t",
        },
      };
    default:
      // Wallet churn: connect, disconnect, switch account, switch chain, deep-link wallet.
      return {
        type: "ContextChanged",
        ctx: [
          ctx(),
          ctx({}, { address: null, chainId: null }),
          ctx({}, { address: ATTACKER }),
          ctx({}, { chainId: 42161 }),
          ctx({}, { stepwise: true }),
          ctx({ paused: true }),
          ctx({ settlementPreference: "stealth" }),
          ctx({ recipientAddress: "TQ5NMqJjHEuBSyqAJqiZKYHRLmVYFvQvsP", toChainId: 728126428 }),
        ][arg],
      };
  }
}

/** Answer one outstanding effect. Returns null for effects that need no answer. */
function answer(effect: Effect, variant: number, now: number): MsgBody | null {
  if (effect.type === "Api") {
    const call = effect.call;
    if (call.op === "quote") {
      const served = [
        // The honest answer to whatever amount was asked.
        quote({ eip712Data: intentTypedData({ fromAmount: call.request.fromAmount }) }, now),
        quote({ pullAuthorization: erc3009Pull() }, now),
        quote({ pullAuthorization: erc3009Pull(ATTACKER) }, now),
        quote({ preview: true, eip712Data: undefined }, now),
        quote({ canSolve: false, error: "unprofitable" }, now),
        quote({ success: false, error: "validation_failed" }, now),
        quote({ eip712Data: intentTypedData({ recipient: ATTACKER }) }, now),
        quote({ depositAddress: "TCwnBmvhtqLpBiKrFEfMzXWCq1YB2sPX8N" }, now),
        quote({ costBps: undefined, toAmount: "123" }, now),
        // A "preview" that still carries an intent naming other terms.
        quote(
          {
            preview: true,
            eip712Data: intentTypedData({ fromToken: WBTC, toChainId: 10, deadline: 32503680000 }),
          },
          now,
        ),
      ];
      return variant === 10
        ? { type: "QuoteReplied", flight: call.flight, result: { ok: false, error: thrown(false) } }
        : {
            type: "QuoteReplied",
            flight: call.flight,
            result: { ok: true, quote: served[variant] },
          };
    }
    if (call.op === "execute") {
      if (variant === 10) {
        // The server refused before accepting anything (`ApiError.notAccepted`).
        return {
          type: "ExecuteReplied",
          flow: call.flow,
          result: {
            ok: false,
            error: {
              rejected: false,
              value: { message: "HTTP 503", code: 503, retryAfter: Math.floor(now / 1000) + 5 },
              detail: "busy",
              notAccepted: true,
            },
          },
        };
      }
      if (variant >= 7) {
        return {
          type: "ExecuteReplied",
          flow: call.flow,
          result: { ok: false, error: thrown(false) },
        };
      }
      const status = STATUSES[variant + 1];
      return {
        type: "ExecuteReplied",
        flow: call.flow,
        result: {
          ok: true,
          response: { success: status !== "failed", intentId: call.request.intentId, status },
        },
      };
    }
    const status =
      variant === 0
        ? { notFound: true as const }
        : variant === 1
          ? null
          : variant === 2
            ? statusData({
                intentId: call.intentId,
                status: "executing",
                unmapped: true,
                terminal: variant % 2 === 0,
              })
            : statusData({
                intentId: call.intentId,
                status: STATUSES[variant % STATUSES.length],
                terminal: ["completed", "refunded", "failed", "expired"].includes(
                  STATUSES[variant % STATUSES.length],
                ),
              });
    return variant === 9
      ? {
          type: "StatusReplied",
          gen: call.gen,
          attempt: call.attempt,
          result: { ok: false, error: thrown(false) },
        }
      : {
          type: "StatusReplied",
          gen: call.gen,
          attempt: call.attempt,
          result: { ok: true, status },
        };
  }
  if (effect.type === "Wallet") {
    const call = effect.call;
    if (call.op === "signTypedData") {
      return variant < 6
        ? {
            type: "SignReplied",
            flow: call.flow,
            purpose: call.purpose,
            result: { ok: true, signature: `0xsig${variant}` },
          }
        : {
            type: "SignReplied",
            flow: call.flow,
            purpose: call.purpose,
            result: { ok: false, error: thrown(variant < 8) },
          };
    }
    if (call.op === "ensureApproval") {
      return variant === 9
        ? {
            type: "ApprovalReplied",
            flow: call.flow,
            result: { ok: false, error: thrown(variant % 2 === 0) },
          }
        : {
            type: "ApprovalReplied",
            flow: call.flow,
            result: { ok: true, approved: variant !== 8 },
          };
    }
    if (call.op === "ensureSession") {
      return {
        type: "SessionReplied",
        flight: call.flight,
        result: (["ok", "refused", "skipped"] as const)[variant % 3],
      };
    }
    return null;
  }
  return null;
}

interface Transition {
  prev: Model;
  msg: Msg;
  next: Model;
  effects: Effect[];
}

/** Run a script, returning every transition it produced. */
function run(actions: Action[]): Transition[] {
  let model = init(CONFIG, ctx());
  let now = T0;
  let hidden = false;
  let pending: Effect[] = [];
  const out: Transition[] = [];
  const send = (body: MsgBody) => {
    const msg = { ...body, now, hidden } as Msg;
    const [next, effects] = update(model, msg);
    out.push({ prev: model, msg, next, effects });
    model = next;
    pending = [...pending, ...effects.filter((e) => e.type === "Api" || e.type === "Wallet")];
  };
  for (const a of actions) {
    if (a.kind === "wait") now += a.ms;
    else if (a.kind === "hide") hidden = a.hidden;
    else if (a.kind === "timer") send({ type: "TimerFired", timer: a.timer });
    else if (a.kind === "user") send(userMsg(a.which, a.arg));
    else if (pending.length > 0) {
      const [effect] = pending.splice(a.pick % pending.length, 1);
      const reply = answer(effect, a.variant, now);
      if (reply) send(reply);
    }
    now += 50;
  }
  return out;
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const scripts = fc.array(actionArb, { minLength: 1, maxLength: 60 });

/**
 * Scripts that open a sign ceremony first: quote (each signable variant,
 * including an unpinned pull, and a "preview" that still carries an intent),
 * Confirm, then arbitrary churn. Free-running `scripts` rarely get a quote
 * answered at all, so properties about what happens AFTER the wallet is
 * prompted need the ceremony handed to them.
 */
const ceremonies = fc
  .tuple(
    fc.constantFrom(0, 1, 2, 9),
    fc.array(actionArb, { minLength: 1, maxLength: 60, size: "max" }),
  )
  .map(([served, rest]): Action[] => [
    { kind: "user", which: 0, arg: 0 },
    { kind: "timer", timer: "debounce" },
    { kind: "answer", pick: 0, variant: served },
    { kind: "user", which: 1, arg: 0 },
    ...rest,
  ]);

/**
 * Scripts that execute and get the server's not-accepted refusal, then churn
 * with the resend timer and further refusals weighted in, so the bounded
 * resend path runs against arbitrary interleavings.
 */
const refusals = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: actionArb },
      { weight: 1, arbitrary: fc.constant<Action>({ kind: "timer", timer: "execute" }) },
      { weight: 1, arbitrary: fc.constant<Action>({ kind: "answer", pick: 0, variant: 10 }) },
    ),
    { minLength: 1, maxLength: 60, size: "max" },
  )
  .map((rest): Action[] => [
    { kind: "user", which: 0, arg: 0 },
    { kind: "timer", timer: "debounce" },
    { kind: "answer", pick: 0, variant: 0 },
    { kind: "user", which: 1, arg: 0 },
    { kind: "answer", pick: 0, variant: 0 },
    { kind: "answer", pick: 0, variant: 10 },
    ...rest,
  ]);

/**
 * Scripts that correct the trade while its quote is still in the air (another
 * amount, or a context change), then let that first quote answer honestly
 * before arbitrary churn.
 */
const corrections = fc
  .tuple(
    fc.oneof(
      fc.constant<Action>({ kind: "user", which: 0, arg: 3 }),
      fc.integer({ min: 1, max: 7 }).map((arg): Action => ({ kind: "user", which: 8, arg })),
    ),
    fc.constantFrom(0, 1),
    fc.array(actionArb, { maxLength: 40 }),
  )
  .map(([correction, served, rest]): Action[] => [
    { kind: "user", which: 0, arg: 0 },
    { kind: "timer", timer: "debounce" },
    correction,
    { kind: "answer", pick: 0, variant: served },
    ...rest,
  ]);

describe("update properties", () => {
  it("is pure, deterministic and JSON-clean at every step", () => {
    fc.assert(
      fc.property(fc.oneof(scripts, refusals), (actions) => {
        for (const t of run(actions)) {
          const before = JSON.stringify(t.prev);
          const [again, effectsAgain] = update(t.prev, t.msg);
          // Never mutates its input; same input, same output.
          expect(JSON.stringify(t.prev)).toBe(before);
          expect(again).toEqual(t.next);
          expect(effectsAgain).toEqual(t.effects);
          // Effects, model and receipt survive a JSON round trip, so a session
          // can be logged and replayed.
          expect(roundTrip(t.effects)).toEqual(t.effects);
          expect(roundTrip(view(t.next))).toEqual(view(t.next));
          expect(roundTrip(t.next)).toEqual(t.next);
        }
      }),
      FC_SETTINGS,
    );
  });

  it("never reads an unmapped status as completed", () => {
    fc.assert(
      fc.property(scripts, (actions) => {
        for (const t of run(actions)) {
          if (t.msg.type !== "StatusReplied" || !t.msg.result.ok) continue;
          const s = t.msg.result.status;
          if (!s || "notFound" in s || !s.unmapped) continue;
          if (t.prev.intent.status !== "completed") {
            expect(t.next.intent.status).not.toBe("completed");
            expect(view(t.next).phase).not.toBe("success");
          }
          if (
            POLL_INFLIGHT_STATES.includes(t.next.intent.status) &&
            t.prev.poll?.gen === t.msg.gen &&
            !t.prev.poll.stopped
          ) {
            expect(view(t.next).phase).toBe("pending");
          }
        }
      }),
      FC_SETTINGS,
    );
  });

  it("only promises the held quote's own payout, and never a floor", () => {
    fc.assert(
      fc.property(scripts, (actions) => {
        for (const t of run(actions)) {
          const { payout } = view(t.next);
          const held = t.next.intent.quote;
          if (payout.kind === "none") {
            expect(held?.canSolve ?? false).toBe(false);
          } else {
            expect(payout.amount).toBe(held?.toAmount);
            expect(Object.keys(payout).sort()).toEqual(
              payout.kind === "exact" ? ["amount", "kind", "otherwise"] : ["amount", "kind"],
            );
            expect(payout.kind === "preview").toBe(held?.preview === true);
          }
          // Shielded never claims to hide the amount.
          expect(view(t.next).settlement.amount).toBe("visible");
        }
      }),
      FC_SETTINGS,
    );
  });

  it("prompts the wallet and executes only on the paths that earned it", () => {
    fc.assert(
      fc.property(fc.oneof(scripts, ceremonies, refusals), (actions) => {
        for (const t of run(actions)) {
          for (const e of t.effects) {
            if (
              e.type === "Wallet" &&
              e.call.op === "signTypedData" &&
              e.call.purpose === "intent"
            ) {
              // Signature 1: only from Confirm, on a signable, executable quote.
              expect(t.msg.type).toBe("SignRequested");
              expect(t.prev.intent.status).toBe("quoted");
              expect(t.prev.intent.quote?.preview).not.toBe(true);
            }
            if (e.type === "Wallet" && e.call.op === "signTypedData" && e.call.purpose === "pull") {
              // Signature 2: only after an approval, and only a pull paying the pinned solver.
              expect(t.msg.type).toBe("ApprovalReplied");
              expect(String(e.call.typedData.message.to).toLowerCase()).toBe(SOLVER.toLowerCase());
            }
            if (e.type === "Api" && e.call.op === "execute") {
              // Never execute without the wallet's own signature in hand: from
              // the signature itself, or as the unchanged resend of a request
              // the server did not accept, never once its execute is in doubt.
              if (t.msg.type === "TimerFired" || t.msg.type === "VisibilityChanged") {
                const attempt = t.prev.sign?.execute;
                // The `execute` timer, or its backstop (a poll tick or a
                // returning tab) never before the resend time.
                if (!(t.msg.type === "TimerFired" && t.msg.timer === "execute")) {
                  expect(t.msg.type === "VisibilityChanged" || t.msg.timer === "poll").toBe(true);
                  expect(t.msg.now).toBeGreaterThanOrEqual(attempt?.resendAt ?? Infinity);
                }
                expect(typeof attempt?.resendAt).toBe("number");
                expect(attempt?.resends).toBeLessThan(MAX_EXECUTE_RESENDS);
                expect(e.call.request).toEqual(attempt?.request);
                expect(t.prev.intent.reconciling).toBe(false);
              } else {
                expect(t.msg.type).toBe("SignReplied");
                expect(t.msg.type === "SignReplied" && t.msg.result.ok).toBe(true);
              }
              expect(e.call.request.signature).toMatch(/^0xsig/);
            }
          }
        }
      }),
      FC_SETTINGS,
    );
  });

  it("polls only while an intent is in flight", () => {
    fc.assert(
      fc.property(scripts, (actions) => {
        for (const t of run(actions)) {
          const polled = t.effects.some((e) => e.type === "Api" && e.call.op === "status");
          if (polled) {
            expect(POLL_INFLIGHT_STATES).toContain(t.next.intent.status);
            expect(t.next.intent.intentId).not.toBeNull();
          }
          // canSign implies an executable quote on screen.
          const signing = view(t.next).signing;
          if (signing.kind === "ready") {
            expect(t.next.intent.status).toBe("quoted");
            expect(t.next.intent.quote?.preview).not.toBe(true);
          }
        }
      }),
      FC_SETTINGS,
    );
  });

  it("only a served quote reply puts a quote on screen", () => {
    // Nothing but the solver's own answer (the deposit proof runs inside it) can
    // replace the held quote; everything else keeps it or clears it.
    fc.assert(
      fc.property(scripts, (actions) => {
        for (const t of run(actions)) {
          const before = t.prev.intent.quote;
          const after = t.next.intent.quote;
          if (after && after !== before) {
            expect(t.msg.type).toBe("QuoteReplied");
          }
        }
      }),
      FC_SETTINGS,
    );
  });

  it("a quote lands only for the amount and trade still on the form", () => {
    // A reply to a request the user has since corrected (another amount, token,
    // chain, settlement or wallet) answers a question nobody is asking any more.
    fc.assert(
      fc.property(fc.oneof(scripts, corrections), (actions) => {
        for (const t of run(actions)) {
          const { msg } = t;
          const after = t.next.intent.quote;
          // A decline is held to show its reason, not as a quote for any amount.
          if (msg.type !== "QuoteReplied" || !after?.canSolve || after === t.prev.intent.quote) {
            continue;
          }
          const flight = t.prev.flights.find((f) => f.id === msg.flight);
          expect(t.next.intent.quotedFromAmount).toBe(t.next.amount);
          const trade = (c: Context) => [
            c.fromChainId,
            c.toChainId,
            c.fromToken,
            c.toToken,
            c.settlementPreference,
            c.recipientAddress,
            c.wallet.address,
            c.wallet.chainId,
          ];
          expect(flight && trade(flight.ctx)).toEqual(trade(t.next.ctx));
        }
      }),
      FC_SETTINGS,
    );
  });

  it("a refused sign ceremony keeps the quote on screen, says why, and prompts nothing", () => {
    fc.assert(
      fc.property(fc.oneof(scripts, ceremonies), (actions) => {
        for (const t of run(actions)) {
          if (t.prev.intent.refusal !== null || t.next.intent.refusal === null) continue;
          // Confirm (before any prompt) or the origin-pull leg (before signature 2).
          expect(["SignRequested", "ApprovalReplied"]).toContain(t.msg.type);
          expect(t.effects.filter((e) => e.type === "Wallet" || e.type === "Api")).toEqual([]);
          expect(t.next.intent.quote).toBe(t.prev.intent.quote);
          if (t.next.intent.status === "expired") {
            // Landed on a quote already past its expiry: the countdown expires it
            // in the same step, which outranks the refusal on screen.
            expect(new Date(t.next.intent.quote?.expiry ?? 0).getTime()).toBeLessThanOrEqual(
              t.msg.now,
            );
          } else {
            expect(t.next.intent.status).toBe("quoted");
            expect(view(t.next).quote).toMatchObject({ kind: "ready" });
            // Unless the form was edited mid-ceremony: a quote for another
            // trade is shown, never offered, refusal or not.
            expect(view(t.next).signing).toEqual(
              holdsCurrentQuote(t.next)
                ? { kind: "refused", refusal: t.next.intent.refusal }
                : { kind: "unavailable" },
            );
          }
          // Nothing signed so far survives the refusal to be executed later.
          expect(t.next.sign).toBeNull();
          expect(t.next.pendingIntentSig).toBeNull();
          expect(t.next.awaitingPull).toBe(false);
        }
      }),
      FC_SETTINGS,
    );
  });

  it("executes only out of a live signing ceremony, never behind a refusal", () => {
    fc.assert(
      fc.property(fc.oneof(scripts, ceremonies, refusals), (actions) => {
        let landedQuoted = false;
        for (const t of run(actions)) {
          const executes = t.effects.some((e) => e.type === "Api" && e.call.op === "execute");
          if (executes && (t.msg.type === "TimerFired" || t.msg.type === "VisibilityChanged")) {
            // A resend keeps the ceremony it was dispatched from.
            expect(t.prev.intent.status).toBe("executing");
            expect(t.prev.sign?.stage).toBe("execute");
            expect(t.next.intent.status).toBe("executing");
          } else if (executes) {
            expect(t.prev.intent.status).toBe("signing");
            expect(t.prev.sign?.stage).toBe(t.msg.type === "SignReplied" ? t.msg.purpose : null);
            expect(t.next.intent.status).toBe("executing");
            // A ceremony that fell back to the quote may not be revived by a late reply.
            expect(landedQuoted).toBe(false);
          }
          // Reset per ceremony: a fresh Confirm into `signing` starts a new one.
          if (t.next.intent.status === "signing" && t.prev.intent.status !== "signing") {
            landedQuoted = false;
          }
          if (t.prev.intent.status === "signing" && t.next.intent.status === "quoted") {
            landedQuoted = true;
          }
        }
      }),
      FC_SETTINGS,
    );
  });

  it("leaves no signing residue outside a ceremony, and no stale quote moves a swap", () => {
    fc.assert(
      fc.property(fc.oneof(scripts, ceremonies, refusals), (actions) => {
        for (const t of run(actions)) {
          const status = t.next.intent.status;
          if (status !== "signing" && status !== "executing") {
            expect(t.next.sign).toBeNull();
            expect(t.next.pendingIntentSig).toBeNull();
            expect(t.next.awaitingPull).toBe(false);
            expect(t.next.isSigningPull).toBe(false);
          }
          // Once executing, only the machine's own execute step is live: a
          // status update that skipped `signing -> executing` ends the ceremony.
          if (status === "executing") {
            expect(t.next.sign?.stage ?? "execute").toBe("execute");
            expect(t.next.awaitingPull).toBe(false);
          }
          // The pull leg (approval, signature 2) runs only inside `signing`.
          for (const e of t.effects) {
            const pullLeg =
              e.type === "Wallet" &&
              (e.call.op === "ensureApproval" ||
                (e.call.op === "signTypedData" && e.call.purpose === "pull"));
            if (pullLeg) expect(t.prev.intent.status).toBe("signing");
          }
          // A trade past quoting has no quote in the air, and a reply to one
          // asked before it got there never touches it (executing -> failed).
          if (QUOTE_BUSY_STATES.includes(status)) expect(t.next.flights).toEqual([]);
          if (t.msg.type === "QuoteReplied" && QUOTE_BUSY_STATES.includes(t.prev.intent.status)) {
            expect(t.next.intent).toBe(t.prev.intent);
          }
        }
      }),
      FC_SETTINGS,
    );
  });
});
