import { describe, it, expect } from "vitest";
import {
  buildQuoteRequest,
  computeRefreshDelayMs,
  decideSignPreflight,
  decideExecuteResult,
  executeDeadline,
  decideExecuteResend,
  EXECUTE_RESEND_MARGIN_SECS,
  MAX_EXECUTE_RESENDS,
  mapStatusUpdate,
  mapStatusFrame,
  mergeSameStatusReceipt,
  notFoundDriftWarning,
  POLL_INFLIGHT_STATES,
  WALLET_INTERRUPTIBLE_STATES,
  canAdoptResumedIntent,
  buildResumedState,
  shouldRefreshQuote,
  shouldRefreshOnReturn,
  pollCeilingAttempts,
  DEPOSIT_POLL_GRACE_MS,
  POLL_CEILING_MAX_MS,
  STATUS_POLL_MS,
  STATUS_POLL_FLAT_CEILING_MS,
  STATUS_POLL_FLAT_CEILING_ATTEMPTS,
} from "./decisions.js";
import { INITIAL_INTENT_STATE, type IntentState } from "./state.js";
import {
  buildIntentStatusFrame,
  getRefundReasonLabel,
  type IntentStatus,
} from "../shared/index.js";
import type { ExecuteResponse, IntentWebSocketMessage } from "./wire.js";
import { T0, erc3009Pull, intentTypedData, quote } from "./test/session.js";

describe("buildQuoteRequest", () => {
  const base = {
    wallet: "0xabc",
    fromChainId: 8453 as const,
    toChainId: 42161 as const,
    fromToken: "0xfrom",
    toToken: "0xto",
    fromAmount: "1000000",
    deadline: 1234,
    slippageBps: 50,
    trustScore: 0,
  };
  const meta = { spendingPubKey: "0x02", viewingPubKey: "0x03", chainId: 1 as const };

  it("includes the stealth meta-address only on a stealth settlement", () => {
    const stealth = buildQuoteRequest({
      ...base,
      settlementPreference: "stealth",
      stealthMetaAddress: meta,
    });
    expect(stealth.stealthMetaAddress).toEqual(meta);

    const publicReq = buildQuoteRequest({
      ...base,
      settlementPreference: "public",
      stealthMetaAddress: meta,
    });
    expect(publicReq.stealthMetaAddress).toBeUndefined();
  });

  it("normalizes an empty recipientAddress to undefined", () => {
    const req = buildQuoteRequest({
      ...base,
      settlementPreference: "public",
      recipientAddress: "",
    });
    expect(req.recipientAddress).toBeUndefined();
    const withRecipient = buildQuoteRequest({
      ...base,
      settlementPreference: "public",
      recipientAddress: "0xdead",
    });
    expect(withRecipient.recipientAddress).toBe("0xdead");
  });

  // The deposit attestation rebuilds both of these from the same panel state
  // and compares bytes with the solver. Sending an untrimmed value while
  // rebuilding a trimmed one is a message that cannot recover, surfaced to the
  // user as the route being unavailable. One deal, one encoding.
  it("trims recipientAddress and refundAddress, so sent matches rebuilt", () => {
    const req = buildQuoteRequest({
      ...base,
      settlementPreference: "public",
      recipientAddress: "  TJYeasTPa6gpEEfYGfp5LQjWXmdZQBpLzX  ",
      refundAddress: "\tTWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb\n",
    });
    expect(req.recipientAddress).toBe("TJYeasTPa6gpEEfYGfp5LQjWXmdZQBpLzX");
    expect(req.refundAddress).toBe("TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb");
  });

  it("normalizes a whitespace-only address to undefined, not to a blank string", () => {
    const req = buildQuoteRequest({
      ...base,
      settlementPreference: "public",
      recipientAddress: "   ",
      refundAddress: "   ",
    });
    expect(req.recipientAddress).toBeUndefined();
    expect(req.refundAddress).toBeUndefined();
  });
});

describe("computeRefreshDelayMs", () => {
  it("is positive when expiry is beyond the buffer, non-positive inside it", () => {
    const now = 1_000_000;
    // expiry 30s out, 5s buffer -> refresh in 25s.
    expect(computeRefreshDelayMs(new Date(now + 30_000).toISOString(), now, 5_000)).toBe(25_000);
    // expiry only 3s out with a 5s buffer -> already inside the window (negative).
    expect(
      computeRefreshDelayMs(new Date(now + 3_000).toISOString(), now, 5_000),
    ).toBeLessThanOrEqual(0);
  });
});

describe("decideSignPreflight (fail-closed precedence)", () => {
  const ok = {
    hasDepositAddress: false,
    hasEip712: true,
    address: "0xAAA",
    quotedAddress: "0xaaa",
    quotedChainId: 8453,
    chainId: 8453,
    originChainId: 8453 as const,
    expiryMs: 0,
    now: 1000,
  };

  it("reveals the deposit address first (deposit route, no signature)", () => {
    expect(decideSignPreflight({ ...ok, hasDepositAddress: true }).kind).toBe("awaitingDeposit");
  });

  it("reports noQuote when there is no EIP-712 payload", () => {
    expect(decideSignPreflight({ ...ok, hasEip712: false }).kind).toBe("noQuote");
  });

  it("rejects to quoted when the account changed", () => {
    const d = decideSignPreflight({ ...ok, address: "0xBBB" });
    expect(d).toEqual({
      kind: "reject",
      to: "quoted",
      refusal: { kind: "wallet_changed" },
      error: "The wallet or network changed. Get a fresh quote.",
    });
  });

  it("rejects to quoted when the chain changed since the quote", () => {
    // Quoted on Ethereum, wallet since moved onto the Base origin: the held
    // quote was bound to the old context, so it must be re-quoted, not signed.
    const d = decideSignPreflight({ ...ok, quotedChainId: 1 });
    expect(d).toEqual({
      kind: "reject",
      to: "quoted",
      refusal: { kind: "wallet_changed" },
      error: "The wallet or network changed. Get a fresh quote.",
    });
  });

  it("refuses to sign off the origin chain, configured or not", () => {
    // 31337: Metatarz's Canton facade, a chain the app has no wagmi config for.
    // Quoted there too, so only the origin check can catch it.
    for (const chainId of [1, 31337, undefined]) {
      const d = decideSignPreflight({ ...ok, chainId, quotedChainId: chainId ?? null });
      expect(d).toEqual({
        kind: "reject",
        to: "quoted",
        refusal: { kind: "wrong_chain", chainId: 8453 },
        error: "Switch the wallet to Base to sign.",
      });
    }
  });

  it("rejects a disconnected wallet (address undefined)", () => {
    expect(decideSignPreflight({ ...ok, address: undefined }).kind).toBe("reject");
  });

  it("rejects to expired when the quote is past its expiry", () => {
    const d = decideSignPreflight({ ...ok, expiryMs: 500, now: 1000 });
    expect(d).toEqual({ kind: "reject", to: "expired", error: "Quote expired" });
  });

  it("proceeds when the wallet matches and the quote is fresh", () => {
    expect(decideSignPreflight(ok).kind).toBe("proceed");
    // case-insensitive account match.
    expect(decideSignPreflight({ ...ok, address: "0xAAA", quotedAddress: "0xAAA" }).kind).toBe(
      "proceed",
    );
  });
});

describe("decideExecuteResult (in-doubt vs failure)", () => {
  const res = (over: Partial<ExecuteResponse>): ExecuteResponse => ({
    success: true,
    intentId: "xi_1",
    status: "completed",
    ...over,
  });

  it("treats success:false + status 'failed' + reconciling:false as a real, terminal failure", () => {
    const d = decideExecuteResult(
      res({ success: false, status: "failed", reconciling: false, error: "bad sig" }),
    );
    expect(d).toEqual({ kind: "failed", error: "bad sig" });
  });

  it("reads an absent reconciling flag on a failed reply as on (reconciling ?? !success)", () => {
    const d = decideExecuteResult(res({ success: false, status: "failed", error: "bad sig" }));
    expect(d.kind).toBe("transition");
    if (d.kind === "transition") {
      expect(d.status).toBe("executing");
      expect(d.updates.reconciling).toBe(true);
    }
  });

  it("does NOT fail a success:false downgrade (funds moved, in-doubt) -- advances + reconciles", () => {
    // The load-bearing double-execution guard: a non-'failed' success:false must
    // advance and force reconciling, never terminalize (which would offer Retry).
    const d = decideExecuteResult(res({ success: false, status: "settling" }));
    expect(d.kind).toBe("transition");
    if (d.kind === "transition") {
      expect(d.status).toBe("settling");
      expect(d.updates.reconciling).toBe(true);
    }
  });

  it("completes on success + status 'completed' with reconciling off", () => {
    const d = decideExecuteResult(res({ status: "completed", txHash: "0xtx" }));
    expect(d.kind).toBe("transition");
    if (d.kind === "transition") {
      expect(d.status).toBe("completed");
      expect(d.updates.reconciling).toBe(false);
      expect(d.updates.txHash).toBe("0xtx");
    }
  });
});

describe("decideExecuteResend (a not-accepted execute)", () => {
  const now = 1_000_000_000_000;
  const nowSec = now / 1000;
  const ok = { resends: 0, retryAfter: nowSec + 5, deadline: nowSec + 60, now };

  it("resends at retryAfter while resends and the deadline leave room", () => {
    expect(decideExecuteResend(ok)).toEqual({ kind: "resend", delayMs: 5000 });
    expect(decideExecuteResend({ ...ok, resends: MAX_EXECUTE_RESENDS - 1 }).kind).toBe("resend");
    // At the margin exactly: still in time.
    const edge = nowSec + 60 - EXECUTE_RESEND_MARGIN_SECS;
    expect(decideExecuteResend({ ...ok, retryAfter: edge }).kind).toBe("resend");
  });

  it("waits at least a second for a retryAfter already past", () => {
    expect(decideExecuteResend({ ...ok, retryAfter: nowSec - 30 })).toEqual({
      kind: "resend",
      delayMs: 1000,
    });
  });

  it("gives up when exhausted, unhinted, or past the deadline", () => {
    expect(decideExecuteResend({ ...ok, resends: MAX_EXECUTE_RESENDS })).toEqual({
      kind: "give_up",
      reason: "exhausted",
    });
    for (const retryAfter of [undefined, NaN, Infinity]) {
      expect(decideExecuteResend({ ...ok, retryAfter })).toEqual({
        kind: "give_up",
        reason: "no_retry_after",
      });
    }
    const late = nowSec + 60 - EXECUTE_RESEND_MARGIN_SECS + 1;
    expect(decideExecuteResend({ ...ok, retryAfter: late })).toEqual({
      kind: "give_up",
      reason: "deadline",
    });
    expect(decideExecuteResend({ ...ok, deadline: null }).kind).toBe("give_up");
  });
});

describe("executeDeadline (the earliest deadline a resent execute carries)", () => {
  const expirySec = Math.floor(T0 / 1000) + 60;
  const held = quote({ eip712Data: intentTypedData({ deadline: expirySec + 600 }) });

  it("is the quote expiry when every signed deadline is later", () => {
    expect(executeDeadline(held)).toBe(expirySec);
  });

  it("is the signed intent's deadline when earlier, decimal string or number", () => {
    for (const deadline of [expirySec - 20, String(expirySec - 20)]) {
      expect(executeDeadline({ ...held, eip712Data: intentTypedData({ deadline }) })).toBe(
        expirySec - 20,
      );
    }
    // Neither a number nor a decimal string: not a deadline.
    expect(executeDeadline({ ...held, eip712Data: intentTypedData({ deadline: "soon" }) })).toBe(
      expirySec,
    );
  });

  it("is the origin pull's validBefore (ERC-3009) or deadline (Permit2) when earlier", () => {
    const pull = erc3009Pull();
    const erc3009 = { ...pull, message: { ...pull.message, validBefore: expirySec - 30 } };
    expect(executeDeadline({ ...held, pullAuthorization: erc3009 })).toBe(expirySec - 30);
    const permit2 = { ...pull, message: { deadline: String(expirySec - 40) } };
    expect(executeDeadline({ ...held, pullAuthorization: permit2 })).toBe(expirySec - 40);
  });

  it("is null without a quote or a readable expiry, which never resends", () => {
    expect(executeDeadline(null)).toBeNull();
    expect(executeDeadline({ ...held, expiry: "not a date" })).toBeNull();
  });
});

describe("mapStatusFrame", () => {
  // The worker's own builder, round-tripped through JSON exactly as the relay
  // delivers it: the parser must accept what the server actually publishes, or
  // the frames are silently dropped when the two shapes drift.
  const wire = (
    over: { toStatus?: IntentStatus; revision?: number | null } = {},
  ): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(
        buildIntentStatusFrame({
          intentId: "xi_1",
          fromStatus: "executing",
          toStatus: "bridging",
          protocol: "legacy",
          settlementType: "public",
          revision: 7,
          txHash: "0xabc",
          ts: Date.parse("2026-07-25T00:00:00Z"),
          ...over,
        }),
      ),
    );

  it("maps a published in-flight frame to the status message the poll path applies", () => {
    expect(mapStatusFrame(wire(), null)).toEqual({
      revision: 7,
      message: {
        type: "intent_status",
        intentId: "xi_1",
        status: "bridging",
        txHash: "0xabc",
        timestamp: "2026-07-25T00:00:00.000Z",
      },
    });
  });

  it("drops a replayed or out-of-order frame at or below the last revision", () => {
    expect(mapStatusFrame(wire({ revision: 7 }), 7)).toBeNull();
    expect(mapStatusFrame(wire({ revision: 6 }), 7)).toBeNull();
    expect(mapStatusFrame(wire({ revision: 8 }), 7)?.message?.status).toBe("bridging");
  });

  it("advances the revision but leaves terminals to the poll, which carries their receipts", () => {
    const terminals: IntentStatus[] = ["completed", "failed", "refunded", "expired"];
    for (const toStatus of terminals) {
      expect(mapStatusFrame(wire({ toStatus, revision: 9 }), 7)).toEqual({
        revision: 9,
        message: null,
      });
    }
  });

  it("rejects values that are not status frames", () => {
    expect(mapStatusFrame({ type: "race_won", intentId: "xi_1" }, null)).toBeNull();
    expect(mapStatusFrame({ ...wire(), status: "teleported" }, null)).toBeNull();
    expect(mapStatusFrame(null, null)).toBeNull();
  });
});

describe("mapStatusUpdate", () => {
  const msg = (over: Partial<IntentWebSocketMessage>): IntentWebSocketMessage => ({
    type: "intent_status",
    intentId: "xi_1",
    status: "bridging",
    timestamp: "2026-07-25T00:00:00Z",
    ...over,
  });

  it("completes with reconciling off and the fill receipt", () => {
    const { status, updates } = mapStatusUpdate(
      msg({ status: "completed", settlementTxHash: "0xfill", settlementChainId: 1 }),
    );
    expect(status).toBe("completed");
    expect(updates.reconciling).toBe(false);
    expect(updates.settlementTxHash).toBe("0xfill");
  });

  it("routes a refund reason to refundReason, never error", () => {
    const { status, updates } = mapStatusUpdate(
      msg({ status: "refunded", refundReason: "quote_expired" }),
    );
    expect(status).toBe("refunded");
    expect(updates.error).toBeNull();
    expect(updates.reconciling).toBe(false);
    expect(updates.refundReason).toBe(getRefundReasonLabel("quote_expired"));
  });

  it("maps a failure with its error", () => {
    const { status, updates } = mapStatusUpdate(msg({ status: "failed", error: "reverted" }));
    expect(status).toBe("failed");
    expect(updates.error).toBe("reverted");
  });

  it("advances an in-flight status carrying reconciling", () => {
    const { status, updates } = mapStatusUpdate(msg({ status: "settling", reconciling: true }));
    expect(status).toBe("settling");
    expect(updates.reconciling).toBe(true);
  });
});

describe("lifecycle state sets", () => {
  it("wallet-context reset only interrupts pre-execution states", () => {
    expect(WALLET_INTERRUPTIBLE_STATES).toEqual(["quoted", "signing", "expired", "failed"]);
    // An in-flight settlement is never yanked out from under the user.
    for (const s of ["executing", "bridging", "settling", "awaiting_deposit"]) {
      expect(WALLET_INTERRUPTIBLE_STATES).not.toContain(s);
    }
  });
});

describe("mergeSameStatusReceipt", () => {
  const prev = {
    receivingTxHash: null,
    settlementTxHash: null,
    settlementChainId: null,
    substatus: null,
  };
  const msg = (over: Partial<IntentWebSocketMessage> = {}): IntentWebSocketMessage => ({
    type: "intent_status",
    intentId: "xi_1",
    status: "settling",
    timestamp: "2026-08-16T00:00:00Z",
    ...over,
  });

  it("applies a fill receipt that arrives while the status stays settling", () => {
    // The whole point: a stealth intent never leaves `settling`, so this is the
    // only path by which its settlement hash can ever reach the UI.
    expect(
      mergeSameStatusReceipt(prev, msg({ settlementTxHash: "0x187a50fc", settlementChainId: 1 })),
    ).toEqual({ settlementTxHash: "0x187a50fc", settlementChainId: 1 });
  });

  it("returns null when the poll carries nothing new", () => {
    expect(mergeSameStatusReceipt(prev, msg())).toBeNull();
    expect(
      mergeSameStatusReceipt(
        { ...prev, settlementTxHash: "0xabc" },
        msg({ settlementTxHash: "0xabc" }),
      ),
    ).toBeNull();
  });

  it("never blanks a hash it already holds when a later poll omits it", () => {
    expect(mergeSameStatusReceipt({ ...prev, settlementTxHash: "0xabc" }, msg())).toBeNull();
  });

  it("never carries reconciling, which the poll owns on its own timer", () => {
    const merged = mergeSameStatusReceipt(prev, msg({ settlementTxHash: "0xabc" }));
    expect(merged).not.toHaveProperty("reconciling");
  });

  it("applies a fill substatus arriving while the status stays settling", () => {
    // Riddler can hold top-level `settling` with substatus `filled` for hours.
    // Without this the only signal that the money landed is dropped on the floor.
    expect(mergeSameStatusReceipt(prev, msg({ substatus: "filled" }))).toEqual({
      substatus: "filled",
    });
  });

  it("does not re-apply an unchanged substatus", () => {
    expect(
      mergeSameStatusReceipt({ ...prev, substatus: "filled" }, msg({ substatus: "filled" })),
    ).toBeNull();
  });

  it("tracks a substatus that advances (filling -> filled)", () => {
    expect(
      mergeSameStatusReceipt({ ...prev, substatus: "filling" }, msg({ substatus: "filled" })),
    ).toEqual({ substatus: "filled" });
  });
});

// `resume` restores a swap a mobile tab lost to eviction. It must never
// overwrite a live intent: that would point the status poll, the modal, and the
// user's read of "what am I waiting on" at the wrong swap while a real one is
// mid-flight.
describe("canAdoptResumedIntent", () => {
  it("adopts into a clean slate", () => {
    expect(canAdoptResumedIntent({ status: "idle", intentId: null })).toBe(true);
  });

  it("refuses when an intent is already being tracked", () => {
    for (const status of [
      "quoting",
      "quoted",
      "signing",
      "executing",
      "bridging",
      "settling",
      "completed",
      "failed",
    ] as const) {
      expect(canAdoptResumedIntent({ status, intentId: "xi_live" })).toBe(false);
    }
  });

  // An id with an idle status is not a clean slate either: a reset that left the
  // id behind, or a resume already applied. Fail closed rather than re-adopting.
  it("refuses an idle state that still carries an intent id", () => {
    expect(canAdoptResumedIntent({ status: "idle", intentId: "xi_already" })).toBe(false);
  });

  it("refuses a non-idle status even with no id", () => {
    expect(canAdoptResumedIntent({ status: "quoted", intentId: null })).toBe(false);
  });
});

// A resumed intent is the only one whose owner does not come from a quote it
// made this session -- it comes from the record's storage key. If it is adopted
// without one, it becomes the only intentId-bearing state with quotedAddress
// null, and the panel's ownership fallback (`intent.quotedAddress ?? address`)
// silently becomes the LIVE wallet. These assert the state `resume` produces,
// not the predicate or the INITIAL constant, which hold whether or not resume
// carries the owner.
describe("buildResumedState", () => {
  const OWNER = "0xAbCdEf0000000000000000000000000000000001";

  it("carries the record's owner as the adopted intent's quotedAddress", () => {
    const next = buildResumedState(INITIAL_INTENT_STATE, "xi_resumed", "settling", OWNER);
    expect(next.quotedAddress).toBe(OWNER);
    expect(next.intentId).toBe("xi_resumed");
    expect(next.status).toBe("settling");
  });

  it("adopts every status the resume path can restore", () => {
    for (const status of POLL_INFLIGHT_STATES) {
      const next = buildResumedState(INITIAL_INTENT_STATE, "xi_a", status, OWNER);
      expect(next.status).toBe(status);
      expect(next.quotedAddress).toBe(OWNER);
    }
  });

  // An ownerless adopt is the defect itself, so it is refused outright rather
  // than adopted with a null owner for the panel to guess at.
  it("refuses an adopt with no owner", () => {
    expect(buildResumedState(INITIAL_INTENT_STATE, "xi_a", "settling", "")).toBe(
      INITIAL_INTENT_STATE,
    );
  });

  it("refuses an adopt with no intent id", () => {
    expect(buildResumedState(INITIAL_INTENT_STATE, "", "settling", OWNER)).toBe(
      INITIAL_INTENT_STATE,
    );
  });

  // The clean-slate rule, asserted on the state rather than on the predicate: a
  // live trade must come back untouched, same object identity, no re-render.
  it("refuses to clobber an intent already in flight", () => {
    const live: IntentState = {
      ...INITIAL_INTENT_STATE,
      status: "executing",
      intentId: "xi_live",
      quotedAddress: "0xBbBbBb0000000000000000000000000000000002",
    };
    expect(buildResumedState(live, "xi_stale", "settling", OWNER)).toBe(live);
  });

  // Built from INITIAL_INTENT_STATE, never a spread of `prev`: a stale quote,
  // error or receipt hash carried into a resumed swap would describe a trade the
  // restored record is not.
  it("carries nothing over from the previous state", () => {
    const dirty: IntentState = {
      ...INITIAL_INTENT_STATE,
      error: "Quote expired",
      refundReason: "solver could not fill",
      txHash: "0xdeadbeef",
      receivingTxHash: "0xfeedface",
      reconciling: true,
      quotedChainId: 8453,
    };
    const next = buildResumedState(dirty, "xi_resumed", "bridging", OWNER);
    expect(next.error).toBeNull();
    expect(next.refundReason).toBeNull();
    expect(next.txHash).toBeNull();
    expect(next.receivingTxHash).toBeNull();
    expect(next.reconciling).toBe(false);
    expect(next.quotedChainId).toBeNull();
    expect(next.quote).toBeNull();
  });

  /**
   * The deposit deadline is the one served fact that must survive the adopt.
   *
   * A resumed intent has no quote, by design, so the deadline must ride on the
   * state itself: read off `state.quote`, a resumed deposit swap falls back to
   * the flat 10-minute ceiling against a window the solver set to 1800s, and the
   * poll stops at minute ten announcing "we have stopped checking" beside a
   * restored countdown still reading twenty minutes. Carrying the deadline is
   * not an exception to the no-synthesized-quote rule -- a price goes stale, a
   * deadline expires, and this is what lets the poll say so.
   */
  it("carries the deposit deadline across the adopt", () => {
    const next = buildResumedState(
      INITIAL_INTENT_STATE,
      "xi_resumed",
      "awaiting_deposit",
      OWNER,
      1_800_001_800,
    );
    expect(next.depositDeadline).toBe(1_800_001_800);
  });

  it("defaults to null on a pull route, where there is no deposit window", () => {
    expect(
      buildResumedState(INITIAL_INTENT_STATE, "xi_resumed", "settling", OWNER).depositDeadline,
    ).toBeNull();
  });

  // The refusal paths must not leak the deadline into a state they declined to
  // build: `prev` is returned untouched.
  it("does not apply the deadline when the adopt is refused", () => {
    const live: IntentState = { ...INITIAL_INTENT_STATE, status: "settling", intentId: "xi_live" };
    expect(buildResumedState(live, "xi_stale", "awaiting_deposit", OWNER, 1_800_001_800)).toBe(
      live,
    );
  });
});

// The poll's answer to a definitive 404 on a dispatched id is to hold, which is
// correct and invisible: the modal spins and the poll ticks ~150 times looking
// exactly like a healthy run. These pin the signal that makes a persistent hold
// distinguishable from a healthy poll, and pin that it stays one line per swap.
describe("notFoundDriftWarning", () => {
  // Mirrors the poll's own bookkeeping (one "last reported id" carried across
  // ticks), so these drive real tick sequences through the real decision.
  const drivePolls = (ids: string[]): string[] => {
    let reported: string | null = null;
    const emitted: string[] = [];
    for (const id of ids) {
      const warning = notFoundDriftWarning(id, reported);
      if (warning === null) continue;
      reported = id;
      emitted.push(warning);
    }
    return emitted;
  };

  it("stays silent for the rest of a stuck swap's poll run", () => {
    // 150 ticks: a full 10 minutes at the 4s cadence, i.e. every poll the hard
    // cap allows. An unthrottled warn would put all 150 in the console.
    const emitted = drivePolls(Array.from({ length: 150 }, () => "xi_stuck"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("xi_stuck");
  });

  it("reports again for a second swap that hits the same condition", () => {
    const emitted = drivePolls(["xi_a", "xi_a", "xi_a", "xi_b", "xi_b"]);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toContain("xi_a");
    expect(emitted[1]).toContain("xi_b");
  });

  it("has nothing to report without an intent id", () => {
    expect(notFoundDriftWarning("", null)).toBeNull();
  });
});

/**
 * Indicative refreshes are allocation-free, while a response carrying a deposit
 * address is immutable until its deposit deadline.
 */
describe("shouldRefreshQuote", () => {
  const base = {
    status: "quoted" as IntentStatus,
    hidden: false,
    hasAllocatedDeposit: false,
  };

  it("keeps allocation-free indicative quotes refreshing", () => {
    expect(shouldRefreshQuote(base)).toBe(true);
  });

  it("never refreshes a backgrounded tab", () => {
    expect(shouldRefreshQuote({ ...base, hidden: true })).toBe(false);
  });

  it("only refreshes a still-quoted intent", () => {
    for (const status of ["idle", "signing", "awaiting_deposit", "completed"] as IntentStatus[]) {
      expect(shouldRefreshQuote({ ...base, status })).toBe(false);
    }
  });

  it("never replaces an allocated deposit route", () => {
    expect(shouldRefreshQuote({ ...base, hasAllocatedDeposit: true })).toBe(false);
  });
});

/**
 * Returning to a foregrounded tab must refresh stale indicative pricing without
 * ever replacing an allocated deposit route.
 */
describe("shouldRefreshOnReturn", () => {
  const base = {
    status: "quoted" as IntentStatus,
    paused: false,
    hasAllocatedDeposit: false,
  };

  it("refreshes an EVM panel on return, expired included", () => {
    expect(shouldRefreshOnReturn(base)).toBe(true);
    expect(shouldRefreshOnReturn({ ...base, status: "expired" })).toBe(true);
  });

  it("never refreshes a status that is mid-flight or done", () => {
    for (const status of [
      "signing",
      "executing",
      "awaiting_deposit",
      "completed",
    ] as IntentStatus[]) {
      expect(shouldRefreshOnReturn({ ...base, status })).toBe(false);
    }
  });

  // The confirm modal runs its own live refresh; returning must not stack a
  // second one on top of it.
  it("defers to the confirm modal's own refresh", () => {
    expect(shouldRefreshOnReturn({ ...base, paused: true })).toBe(false);
  });

  it("never replaces an allocated deposit route on return", () => {
    const deposit = { ...base, hasAllocatedDeposit: true };
    expect(shouldRefreshOnReturn(deposit)).toBe(false);
    expect(shouldRefreshOnReturn({ ...deposit, status: "expired" })).toBe(false);
  });
});

describe("pollCeilingAttempts (deposit window vs the flat ceiling)", () => {
  // The real cadence + flat ceiling, never a literal copy of them.
  const POLL_MS = STATUS_POLL_MS;
  const FLAT_MS = STATUS_POLL_FLAT_CEILING_MS;
  const FLAT_ATTEMPTS = STATUS_POLL_FLAT_CEILING_ATTEMPTS;
  const NOW = 1_700_000_000_000;
  const ceiling = (status: IntentStatus, deadlineSecs?: number) =>
    pollCeilingAttempts(status, deadlineSecs, NOW, POLL_MS, FLAT_MS);

  it("leaves every non-deposit phase on the flat ceiling", () => {
    for (const status of ["executing", "bridging", "settling"] as IntentStatus[]) {
      expect(ceiling(status, NOW / 1000 + 1800)).toBe(FLAT_ATTEMPTS);
    }
  });

  /**
   * Riddler's deposit window defaults to 1800s while the flat ceiling stops at
   * 600s, so a deposit landing after minute ten would never advance the modal:
   * a settled swap sits on a spinner and the user is told to start again. Any
   * ceiling that does not outlast the window reopens that.
   */
  it("covers a full 1800s Riddler deposit window plus the grace", () => {
    const attempts = ceiling("awaiting_deposit", NOW / 1000 + 1800);
    expect(attempts * POLL_MS).toBeGreaterThanOrEqual(1_800_000 + DEPOSIT_POLL_GRACE_MS);
    expect(attempts).toBeGreaterThan(FLAT_ATTEMPTS);
  });

  it("keeps polling past the deadline, because a late deposit still resolves", () => {
    // Deadline already gone: the refund is the status change still owed.
    expect(ceiling("awaiting_deposit", NOW / 1000 - 60)).toBe(FLAT_ATTEMPTS);
  });

  it("never polls less than the flat ceiling on a short window", () => {
    expect(ceiling("awaiting_deposit", NOW / 1000 + 90)).toBeGreaterThanOrEqual(FLAT_ATTEMPTS);
  });

  it("bounds a hostile far-future deadline", () => {
    const attempts = ceiling("awaiting_deposit", NOW / 1000 + 86_400 * 365);
    expect(attempts).toBe(Math.ceil(POLL_CEILING_MAX_MS / POLL_MS));
  });

  it("falls back to the flat ceiling when the solver stated no deadline", () => {
    expect(ceiling("awaiting_deposit", undefined)).toBe(FLAT_ATTEMPTS);
    expect(ceiling("awaiting_deposit", NaN)).toBe(FLAT_ATTEMPTS);
  });
});
