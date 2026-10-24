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
import { init, update, type Context, type Msg } from "./machine.js";
import { view } from "./view.js";
import { createXochiClient } from "../transport/client.js";
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

const READ_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";

/**
 * The Worker the host's transport talks to: an execute that serves a read
 * token, then status reads. Records every request it is sent.
 */
function worker() {
  const requests: { url: string; init: RequestInit }[] = [];
  const xochi = createXochiClient({
    baseUrl: "https://api.example.test",
    log: () => {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      const body = url.endsWith("/api/intent/execute")
        ? { success: true, intent_id: "xi_1", status: "settling", read_token: READ_TOKEN }
        : { intent_id: "xi_1", status: "settling", substatus: "filling", terminal: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { xochi, requests };
}

/** Preview -> connect -> quote -> refresh -> 2-signature sign -> execute -> status. */
async function recordSession(): Promise<{
  initial: Context;
  session: Session;
  readToken: string | undefined;
  requests: { url: string; init: RequestInit }[];
}> {
  const { xochi, requests } = worker();
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
  // The effect host performs the execute through the real transport, keeps
  // the bearer secret (README "Fund safety") and relays the rest.
  const { readToken, ...reply } = await xochi.execute(exec.request);
  const settling = only(
    apiCalls(
      s.send(
        {
          type: "ExecuteReplied",
          flow: exec.flow,
          result: { ok: true, response: reply },
        },
        1100,
      ),
      "status",
    ),
  );
  // ...and performs the status effect with the retained token.
  const polled = await xochi.getIntentStatus(settling.intentId, { readToken });
  if (!polled || "notFound" in polled) throw new Error("the status read must answer");
  s.send(
    {
      type: "StatusReplied",
      gen: settling.gen,
      attempt: settling.attempt,
      result: { ok: true, status: polled },
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
  return { initial, session: s, readToken, requests };
}

describe("replay", () => {
  it("records a full session that ends completed", async () => {
    const { session } = await recordSession();
    expect(session.intent.status).toBe("completed");
    expect(session.intent.quotedAddress).toBe(WALLET);
    expect(session.receipt.phase).toBe("success");
    expect(session.steps.length).toBeGreaterThan(15);
  });

  it("keeps the token the transport served out of every replayable step", async () => {
    const { readToken, requests, session } = await recordSession();
    // The token was really in play: served by the execute, sent on the status read.
    expect(readToken).toBe(READ_TOKEN);
    const statusRead = requests.find((r) => r.url.endsWith("/status"));
    expect(new Headers(statusRead?.init.headers).get("X-Xochi-Read-Token")).toBe(READ_TOKEN);
    expect(JSON.stringify(session.steps)).not.toContain(READ_TOKEN);
    expect(JSON.stringify(session.model)).not.toContain(READ_TOKEN);
  });

  it("replays the JSON log to identical effects and receipts at every step", async () => {
    const { initial, session } = await recordSession();
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

  it("replays twice to the same result (no hidden state between runs)", async () => {
    const { initial, session } = await recordSession();
    const log = session.steps.map((s) => s.msg);
    const run = () => log.reduce((m, msg) => update(m, msg)[0], init(CONFIG, initial));
    expect(view(run())).toEqual(view(run()));
    expect(run()).toEqual(run());
  });
});
