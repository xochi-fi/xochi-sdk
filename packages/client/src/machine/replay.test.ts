/**
 * A recorded session replays to identical receipts.
 *
 * The session below is recorded the way a host would log it: every message the
 * machine received (stamped with its clock and visibility), the effects it
 * asked for, and the Receipt it rendered after each one. The log is then pushed
 * through JSON -- what a bug report, a support ticket or an SDK trace would
 * carry -- and folded back through `update` from `init`. Each step must produce
 * the same effects and the same Receipt, and the run must end on the same
 * model: the machine reads no clock, no randomness and no ambient state.
 */

import { describe, it, expect } from "vitest";
import { init, update, type Msg } from "./machine.js";
import { view } from "./view.js";
import {
  CONFIG,
  Session,
  WALLET,
  apiCalls,
  ctx,
  erc3009Pull,
  only,
  quote,
  statusData,
  walletCalls,
  type Step,
} from "./test/session.js";

/** Preview -> connect -> quote -> refresh -> 2-signature sign -> execute -> status. */
function recordSession(): { initial: ReturnType<typeof ctx>; session: Session } {
  const initial = ctx({}, { address: null, chainId: null });
  const s = new Session(initial);

  const preview = s.requestQuote();
  s.send(
    {
      type: "QuoteReplied",
      flight: preview.flight,
      result: { ok: true, quote: quote({ preview: true, eip712Data: undefined }, s.now) },
    },
    180,
  );

  const upgrade = only(apiCalls(s.send({ type: "ContextChanged", ctx: ctx() }, 2000), "quote"));
  s.send(
    {
      type: "QuoteReplied",
      flight: upgrade.flight,
      result: { ok: true, quote: quote({ pullAuthorization: erc3009Pull() }, s.now) },
    },
    210,
  );

  // The countdown ticks and the confirm surface opens (silent refresh).
  s.send({ type: "TimerFired", timer: "expiry" }, 1000);
  s.send({ type: "ContextChanged", ctx: ctx({ paused: true }) }, 300);
  const refresh = only(apiCalls(s.send({ type: "TimerFired", timer: "refresh" }, 54_000), "quote"));
  s.send(
    {
      type: "QuoteReplied",
      flight: refresh.flight,
      result: {
        ok: true,
        quote: quote({ quoteId: "xq_2", pullAuthorization: erc3009Pull() }, s.now),
      },
    },
    150,
  );

  const intent = only(walletCalls(s.send({ type: "SignRequested" }, 3000), "signTypedData"));
  const approval = only(
    walletCalls(
      s.send(
        {
          type: "SignReplied",
          flow: intent.flow,
          purpose: "intent",
          result: { ok: true, signature: "0xintent" },
        },
        4200,
      ),
      "ensureApproval",
    ),
  );
  const pull = only(
    walletCalls(
      s.send(
        { type: "ApprovalReplied", flow: approval.flow, result: { ok: true, approved: true } },
        20,
      ),
      "signTypedData",
    ),
  );
  const exec = only(
    apiCalls(
      s.send(
        {
          type: "SignReplied",
          flow: pull.flow,
          purpose: "pull",
          result: { ok: true, signature: "0xpull" },
        },
        2600,
      ),
      "execute",
    ),
  );
  const settling = only(
    apiCalls(
      s.send(
        {
          type: "ExecuteReplied",
          flow: exec.flow,
          result: { ok: true, response: { success: true, intentId: "xi_1", status: "settling" } },
        },
        1100,
      ),
      "status",
    ),
  );
  s.send(
    {
      type: "StatusReplied",
      gen: settling.gen,
      attempt: settling.attempt,
      result: { ok: true, status: statusData({ status: "settling", substatus: "filling" }) },
    },
    300,
  );
  const tick = only(apiCalls(s.send({ type: "TimerFired", timer: "poll" }, 3700), "status"));
  s.send(
    {
      type: "StatusReplied",
      gen: tick.gen,
      attempt: tick.attempt,
      result: {
        ok: true,
        status: statusData({
          status: "completed",
          terminal: true,
          settlementTxHash: "0xfill",
          settlementChainId: 42161,
        }),
      },
    },
    250,
  );
  return { initial, session: s };
}

describe("replay", () => {
  it("records a full session that ends completed", () => {
    const { session } = recordSession();
    expect(session.intent.status).toBe("completed");
    expect(session.intent.quotedAddress).toBe(WALLET);
    expect(session.receipt.phase).toBe("success");
    expect(session.steps.length).toBeGreaterThan(15);
  });

  it("replays the JSON log to identical effects and receipts at every step", () => {
    const { initial, session } = recordSession();
    const log: Msg[] = JSON.parse(JSON.stringify(session.steps.map((s) => s.msg)));
    const recorded: Step[] = JSON.parse(JSON.stringify(session.steps));

    let model = init(CONFIG, initial);
    log.forEach((msg, i) => {
      const [next, effects] = update(model, msg);
      model = next;
      expect(JSON.parse(JSON.stringify(effects))).toEqual(recorded[i].effects);
      expect(JSON.parse(JSON.stringify(view(next)))).toEqual(recorded[i].receipt);
    });
    expect(JSON.parse(JSON.stringify(model))).toEqual(JSON.parse(JSON.stringify(session.model)));
  });

  it("replays twice to the same result (no hidden state between runs)", () => {
    const { initial, session } = recordSession();
    const log = session.steps.map((s) => s.msg);
    const run = () => log.reduce((m, msg) => update(m, msg)[0], init(CONFIG, initial));
    expect(view(run())).toEqual(view(run()));
    expect(run()).toEqual(run());
  });
});
