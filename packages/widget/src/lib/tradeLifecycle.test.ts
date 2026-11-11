import { describe, expect, it } from "vitest";
import type { Model, MsgBody } from "@xochi/client";
import { TRADE_REF_PATTERN } from "@xochi/widget-lib";
import { tradeEvents } from "./tradeLifecycle.js";

// tradeEvents reads only `sign` and `intent.{status,intentId,error,notSent}`.
const model = (
  status: string,
  opts: {
    intentId?: string | null;
    signing?: boolean;
    executeStage?: boolean;
    error?: unknown;
    notSent?: boolean;
  } = {},
): Model =>
  ({
    sign: opts.signing
      ? opts.executeStage
        ? {
            id: "flow1",
            stage: "execute",
            execute: {
              request: { intentId: opts.intentId ?? "xi_1" },
              resendAt: null,
            },
          }
        : { id: "flow1" }
      : null,
    intent: {
      status,
      intentId: opts.intentId === undefined ? "xi_1" : opts.intentId,
      error: opts.error ?? null,
      notSent: opts.notSent ?? false,
    },
  }) as unknown as Model;

const executed = {
  type: "ExecuteReplied",
  flow: "flow1",
  result: { ok: true, response: { intentId: "xi_1" } },
} as unknown as MsgBody;
const executedOtherIntent = {
  type: "ExecuteReplied",
  flow: "flow1",
  result: { ok: true, response: { intentId: "xi_2" } },
} as unknown as MsgBody;
const executeInDoubt = {
  type: "ExecuteReplied",
  flow: "flow1",
  result: { ok: false, error: {} },
} as unknown as MsgBody;
const polled = { type: "StatusReplied" } as unknown as MsgBody;
const signRequested = { type: "SignRequested" } as unknown as MsgBody;
const resumed = (status: string, intentId = "xi_1") =>
  ({
    type: "ResumeRequested",
    intentId,
    status,
    owner: "0xabc",
    depositDeadline: null,
  }) as unknown as MsgBody;

/** A trade ref for each intent id in tests that start mid-trade. */
const REF: Record<string, string> = { xi_1: `tr_${"1".repeat(32)}`, xi_2: `tr_${"2".repeat(32)}` };
const known = (...ids: string[]): Map<string, string> => new Map(ids.map((id) => [id, REF[id]]));
/** Any ref this frame minted. */
const MINTED = expect.stringMatching(TRADE_REF_PATTERN);

describe("tradeEvents", () => {
  it("reports submitted when execute answers, then completed on settlement", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(model("quoted"), model("quoted", { signing: true }), polled, attempted),
    ).toEqual([]);
    expect(
      tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("executing"),
        executed,
        attempted,
      ),
    ).toEqual([{ name: "trade:submitted", tradeRef: MINTED }]);
    expect(tradeEvents(model("executing"), model("completed"), polled, attempted)).toEqual([
      { name: "trade:completed", tradeRef: MINTED },
    ]);
    // Reported once.
    expect(tradeEvents(model("completed"), model("completed"), polled, attempted)).toEqual([]);
  });

  it("names every event of one trade by the same minted ref, never the intent id", () => {
    const attempted = new Map<string, string>();
    tradeEvents(model("quoted"), model("quoted", { signing: true }), polled, attempted);
    const ref = attempted.get("xi_1");
    expect(ref).toMatch(TRADE_REF_PATTERN);
    const events = [
      ...tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("executing"),
        executed,
        attempted,
      ),
      ...tradeEvents(model("executing"), model("completed"), polled, attempted),
    ];
    expect(events).toEqual([
      { name: "trade:submitted", tradeRef: ref },
      { name: "trade:completed", tradeRef: ref },
    ]);
    expect(JSON.stringify(events)).not.toContain("xi_1");
    // The ref is forgotten with the trade.
    expect(attempted.size).toBe(0);
  });

  it("reports an inline fill as submitted and completed in one step", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("completed"),
        executed,
        attempted,
      ),
    ).toEqual([
      { name: "trade:submitted", tradeRef: REF.xi_1 },
      { name: "trade:completed", tradeRef: REF.xi_1 },
    ]);
  });

  it("does not report an in-doubt execute as submitted", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("quoted"),
        executeInDoubt,
        attempted,
      ),
    ).toEqual([]);
  });

  // The Worker's finish-fault answer (`200 { success: false, status: "quoted",
  // reconciling: true }`): it ended its own claim, so the API did not accept the
  // order and the machine shows it not sent. Not "submitted" to the host.
  it("does not report an execute reply that leaves the order not sent", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("executing", { signing: true, executeStage: true }),
        model("executing", { notSent: true }),
        executed,
        attempted,
      ),
    ).toEqual([]);
  });

  it("ignores a stale execute reply after a new quote replaces the intent", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("quoted", { intentId: "xi_2" }),
        model("quoted", { intentId: "xi_2" }),
        executed,
        attempted,
      ),
    ).toEqual([]);
  });

  it("ignores an execute response naming another intent", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("executing"),
        executedOtherIntent,
        attempted,
      ),
    ).toEqual([]);
  });

  it("reports a failure of an attempted trade with its error", () => {
    const attempted = known("xi_1");
    expect(
      tradeEvents(
        model("quoted", { signing: true, executeStage: true }),
        model("failed", { error: "Signing failed" }),
        executed,
        attempted,
      ),
    ).toEqual([{ name: "trade:failed", tradeRef: REF.xi_1, error: "Signing failed" }]);

    const refunded = known("xi_2");
    expect(
      tradeEvents(
        model("settling", { intentId: "xi_2" }),
        model("refunded", { intentId: "xi_2", error: { message: "Refunded on origin" } }),
        polled,
        refunded,
      ),
    ).toEqual([{ name: "trade:failed", tradeRef: REF.xi_2, error: "Refunded on origin" }]);
  });

  it("reports a confirmed deposit completing without reporting it submitted", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(model("quoted"), model("awaiting_deposit"), signRequested, attempted),
    ).toEqual([]);
    expect([...attempted.keys()]).toEqual(["xi_1"]);
    expect(tradeEvents(model("awaiting_deposit"), model("executing"), polled, attempted)).toEqual(
      [],
    );
    expect(tradeEvents(model("executing"), model("completed"), polled, attempted)).toEqual([
      { name: "trade:completed", tradeRef: MINTED },
    ]);
  });

  it("reports a confirmed deposit failing without reporting it submitted", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(model("quoted"), model("awaiting_deposit"), signRequested, attempted),
    ).toEqual([]);
    expect(
      tradeEvents(
        model("awaiting_deposit"),
        model("failed", { error: "Deposit expired" }),
        polled,
        attempted,
      ),
    ).toEqual([{ name: "trade:failed", tradeRef: MINTED, error: "Deposit expired" }]);
  });

  it("reports a resumed executing intent completing without reporting it submitted", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(
        model("idle", { intentId: null }),
        model("executing"),
        resumed("executing"),
        attempted,
      ),
    ).toEqual([]);
    expect([...attempted.keys()]).toEqual(["xi_1"]);
    expect(tradeEvents(model("executing"), model("completed"), polled, attempted)).toEqual([
      { name: "trade:completed", tradeRef: MINTED },
    ]);
  });

  it("reports a resumed settling intent failing without reporting it submitted", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(
        model("idle", { intentId: null }),
        model("settling"),
        resumed("settling"),
        attempted,
      ),
    ).toEqual([]);
    expect(
      tradeEvents(
        model("settling"),
        model("failed", { error: "Settlement reverted" }),
        polled,
        attempted,
      ),
    ).toEqual([{ name: "trade:failed", tradeRef: MINTED, error: "Settlement reverted" }]);
  });

  it("does not attempt quote-only, refused, or stale deposit and resume transitions", () => {
    const attempted = new Map<string, string>();
    expect(
      tradeEvents(model("idle", { intentId: null }), model("quoted"), resumed("quoted"), attempted),
    ).toEqual([]);
    expect(tradeEvents(model("quoted"), model("failed"), polled, attempted)).toEqual([]);

    const current = model("executing", { intentId: "xi_2" });
    expect(tradeEvents(current, current, resumed("executing", "xi_2"), attempted)).toEqual([]);
    expect(
      tradeEvents(current, model("completed", { intentId: "xi_2" }), polled, attempted),
    ).toEqual([]);

    expect(
      tradeEvents(
        model("quoted", { intentId: "xi_1" }),
        model("awaiting_deposit", { intentId: "xi_2" }),
        signRequested,
        attempted,
      ),
    ).toEqual([]);
    expect(attempted.size).toBe(0);
  });

  it("stays silent for a quote that fails or expires without a trade being attempted", () => {
    const attempted = new Map<string, string>();
    expect(tradeEvents(model("quoted"), model("expired"), polled, attempted)).toEqual([]);
    expect(
      tradeEvents(model("quoting"), model("failed", { error: "HTTP 500" }), polled, attempted),
    ).toEqual([]);
  });
});
