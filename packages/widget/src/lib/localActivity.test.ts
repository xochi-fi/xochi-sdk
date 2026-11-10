import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  listLocalSwaps,
  upsertLocalSwap,
  subscribeLocalActivity,
  isSweepablePreDispatch,
  isSameWallet,
  isKnownSubstatus,
  refreshLocalSwaps,
  reconcileLocalSwap,
  toActivityStatus,
  isResumableIntentStatus,
  findResumableSwap,
  dismissResumableSwap,
  RESUME_MAX_AGE_MS,
} from "./localActivity.js";
import { isTerminalIntentStatus } from "@xochi/client";
import { POLL_INFLIGHT_STATES } from "@xochi/client";
import { canTransitionTo } from "../types/intent.js";
import type { PolledStatus } from "./localActivity.js";
import type { IntentStatusData } from "@xochi/client";
import type { SwapActivityItem } from "../types/activity.js";
import type { IntentStatus } from "../types/intent.js";
import { STORAGE_KEYS } from "../constants.js";

const WALLET = "0xAbCdEf0000000000000000000000000000000001";
const OTHER_WALLET = "0xAbCdEf0000000000000000000000000000000002";

// The suite runs in the node environment (no jsdom), so provide a minimal
// Map-backed localStorage on a global `window` for the module under test.
function installFakeStorage(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
    clear: (): void => store.clear(),
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    get length(): number {
      return store.size;
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage };
}

function makeSwap(
  id: string,
  timestamp: number,
  status: IntentStatus = "executing",
): SwapActivityItem {
  return {
    id,
    type: "swap",
    timestamp,
    status: toActivityStatus(status),
    intentStatus: status,
    data: {
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: "0xfrom",
      toToken: "0xto",
      fromAmount: "1000000",
      toAmount: null,
      tier: "Standard",
      feeRate: 0.22,
      txHash: null,
      isCrossChain: true,
    },
  };
}

/**
 * A whole `/status` response for `id`, overridden per test. Built in full rather
 * than as a partial literal on purpose: `PolledStatus` is the API client's own
 * result type, so when the wire response grows a required field this helper stops
 * compiling and every fixture is updated with it.
 */
function polled(id: string, over: Partial<IntentStatusData> = {}): IntentStatusData {
  const merged: IntentStatusData = {
    intentId: id,
    status: "completed",
    txHash: null,
    receivingTxHash: null,
    settlementTxHash: null,
    settlementChainId: null,
    error: null,
    refundReason: null,
    substatus: null,
    terminal: true,
    ...over,
  };
  return { ...merged, terminal: over.terminal ?? isTerminalIntentStatus(merged.status) };
}

describe("isSweepablePreDispatch (#271)", () => {
  it("is true only for pre-dispatch statuses the worker sweeps", () => {
    for (const s of ["idle", "pending", "quoting", "quoted", "signing"] as const) {
      expect(isSweepablePreDispatch(s)).toBe(true);
    }
  });

  it("is false for dispatched and terminal statuses (never false-fail these on a 404)", () => {
    for (const s of [
      "executing",
      "bridging",
      "settling",
      "awaiting_deposit",
      "completed",
      "refunded",
      "failed",
      "expired",
    ] as const) {
      expect(isSweepablePreDispatch(s)).toBe(false);
    }
  });

  // This is the ONE doctrine for what a definitive 404 means, and both consumers
  // have to answer the same way about the same swap: useLocalActivity leaves a
  // dispatched feed row alone, and useIntent's in-flight poll holds instead of
  // terminalizing. Pin the sets so that adding a sweepable status to
  // POLL_INFLIGHT_STATES has to be a deliberate act here, rather than silently
  // re-opening the modal-vs-feed contradiction.
  it("never covers a status the in-flight poll runs in", () => {
    for (const s of POLL_INFLIGHT_STATES) {
      expect(isSweepablePreDispatch(s)).toBe(false);
    }
  });
});

describe("localActivity", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("stores and lists a swap for a wallet", () => {
    upsertLocalSwap(WALLET, makeSwap("a", 100));
    const list = listLocalSwaps(WALLET);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
  });

  it("dedupes by intent id and preserves the original timestamp on update", () => {
    upsertLocalSwap(WALLET, makeSwap("a", 100, "executing"));
    upsertLocalSwap(WALLET, {
      ...makeSwap("a", 999, "completed"),
      data: { ...makeSwap("a", 999).data, txHash: "0xhash" },
    });
    const list = listLocalSwaps(WALLET);
    expect(list).toHaveLength(1);
    expect(list[0].intentStatus).toBe("completed");
    expect(list[0].status).toBe("completed");
    expect(list[0].data.txHash).toBe("0xhash");
    // Original creation time kept, not the update's timestamp.
    expect(list[0].timestamp).toBe(100);
  });

  it("returns records newest first", () => {
    upsertLocalSwap(WALLET, makeSwap("old", 100));
    upsertLocalSwap(WALLET, makeSwap("new", 300));
    upsertLocalSwap(WALLET, makeSwap("mid", 200));
    expect(listLocalSwaps(WALLET).map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps the log at 50 records", () => {
    for (let i = 0; i < 60; i++) upsertLocalSwap(WALLET, makeSwap(`id-${i}`, i));
    expect(listLocalSwaps(WALLET)).toHaveLength(50);
  });

  // A failed row's retry needs the Worker's not_executed marker, so a capture
  // write keeps it; the log still persists no substatus this build does not model.
  it("keeps the not_executed marker and drops an unmodeled substatus", () => {
    upsertLocalSwap(WALLET, {
      ...makeSwap("a", 100, "failed"),
      data: { ...makeSwap("a", 100).data, substatus: "not_executed" },
    });
    expect(listLocalSwaps(WALLET)[0].data.substatus).toBe("not_executed");

    upsertLocalSwap(WALLET, {
      ...makeSwap("b", 100, "failed"),
      data: { ...makeSwap("b", 100).data, substatus: "quantum_filled" },
    });
    expect(listLocalSwaps(WALLET).find((s) => s.id === "b")?.data.substatus).toBeUndefined();
  });

  // A shielded payout's row names its next step from the marker.
  it("keeps the awaiting_recipient marker on a capture write", () => {
    upsertLocalSwap(WALLET, {
      ...makeSwap("a", 100, "settling"),
      data: { ...makeSwap("a", 100).data, substatus: "awaiting_recipient" },
    });
    expect(listLocalSwaps(WALLET)[0].data.substatus).toBe("awaiting_recipient");
  });

  it("scopes records per wallet, case-insensitively", () => {
    upsertLocalSwap(WALLET, makeSwap("a", 100));
    expect(listLocalSwaps(WALLET.toLowerCase())).toHaveLength(1);
    expect(listLocalSwaps("0x0000000000000000000000000000000000000009")).toHaveLength(0);
  });

  it("returns empty for a missing wallet", () => {
    expect(listLocalSwaps(undefined)).toEqual([]);
  });

  it("notifies subscribers on write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalActivity(listener);
    upsertLocalSwap(WALLET, makeSwap("a", 100));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    upsertLocalSwap(WALLET, makeSwap("b", 200));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("status helpers", () => {
  it("collapses granular statuses to feed statuses", () => {
    expect(toActivityStatus("completed")).toBe("completed");
    expect(toActivityStatus("failed")).toBe("failed");
    expect(toActivityStatus("expired")).toBe("failed");
    expect(toActivityStatus("refunded")).toBe("failed");
    expect(toActivityStatus("executing")).toBe("pending");
    expect(toActivityStatus("awaiting_deposit")).toBe("pending");
  });
});

// A mobile wallet deep-link backgrounds the tab and the OS may evict it, so the
// in-memory intent is gone on return and the flow modal never comes back. The
// dispatched record is already persisted here, so the view is rebuilt from it.
// See xochi#339.
describe("findResumableSwap (#339)", () => {
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    installFakeStorage();
  });

  // Resuming into a status useIntent does not poll would reopen a modal that
  // then never advances -- worse than not reopening, because it looks alive.
  // Pin the two sets together rather than trusting a comment to keep them equal.
  it("matches useIntent's POLL_INFLIGHT_STATES exactly", () => {
    for (const s of POLL_INFLIGHT_STATES) {
      expect(isResumableIntentStatus(s)).toBe(true);
    }
    for (const s of [
      "idle",
      "pending",
      "quoting",
      "quoted",
      "signing",
      "completed",
      "refunded",
      "failed",
      "expired",
    ] as const) {
      expect(isResumableIntentStatus(s)).toBe(false);
    }
  });

  // The load-bearing property of a resume: every status we reopen the modal
  // into must have a path to a terminal one. A resumable status that cannot
  // terminalize is the exact failure this issue is about -- a modal that looks
  // alive and never resolves -- except reintroduced deliberately.
  it("can reach a terminal status from every resumable status", () => {
    const terminal: IntentStatus[] = ["completed", "refunded", "failed", "expired"];
    for (const from of POLL_INFLIGHT_STATES) {
      expect(terminal.some((to) => canTransitionTo(from, to))).toBe(true);
    }
  });

  it("returns the most recent dispatched, non-terminal swap", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_old", NOW - 60_000, "settling"));
    upsertLocalSwap(WALLET, makeSwap("xi_new", NOW - 10_000, "bridging"));
    expect(findResumableSwap(WALLET, NOW)?.id).toBe("xi_new");
  });

  it("ignores terminal swaps, so a finished trade never reopens the modal", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_done", NOW - 10_000, "completed"));
    upsertLocalSwap(WALLET, makeSwap("xi_failed", NOW - 20_000, "failed"));
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
  });

  // The log only captures dispatched swaps, but a pre-dispatch row must never
  // resume even if one appears: the user abandoned a quote, they are not mid-swap.
  it("ignores a pre-dispatch row", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_quoted", NOW - 10_000, "quoted"));
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
  });

  it("ignores a swap older than the resume window", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_stale", NOW - RESUME_MAX_AGE_MS - 1, "settling"));
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
  });

  it("keeps a swap exactly at the window boundary", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_edge", NOW - RESUME_MAX_AGE_MS, "settling"));
    expect(findResumableSwap(WALLET, NOW)?.id).toBe("xi_edge");
  });

  it("returns null for an unknown or absent wallet", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_a", NOW - 10_000, "settling"));
    expect(findResumableSwap(undefined, NOW)).toBeNull();
    expect(findResumableSwap("0x0000000000000000000000000000000000000009", NOW)).toBeNull();
  });
});

// Closing the modal is an explicit "I am done watching this one". Without a
// persisted dismissal, any later reload would put it back in the user's face
// while the swap is still in flight.
describe("resume dismissal (#339)", () => {
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    installFakeStorage();
  });

  it("stops a dismissed swap from resuming, while it is still in flight", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_a", NOW - 10_000, "settling"));
    expect(findResumableSwap(WALLET, NOW)?.id).toBe("xi_a");
    dismissResumableSwap(WALLET, "xi_a", "settling");
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
  });

  it("is per intent id, so a NEW swap still resumes after an earlier dismissal", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_a", NOW - 20_000, "settling"));
    dismissResumableSwap(WALLET, "xi_a", "settling");
    upsertLocalSwap(WALLET, makeSwap("xi_b", NOW - 10_000, "executing"));
    expect(findResumableSwap(WALLET, NOW)?.id).toBe("xi_b");
  });

  // Written against the owning account, matching the activity log itself: on a
  // shared device an A->B switch must not leak A's dismissals into B's storage.
  it("is scoped per wallet", () => {
    const OTHER = "0xBbBbBb0000000000000000000000000000000002";
    upsertLocalSwap(WALLET, makeSwap("xi_a", NOW - 10_000, "settling"));
    upsertLocalSwap(OTHER, makeSwap("xi_a", NOW - 10_000, "settling"));
    dismissResumableSwap(WALLET, "xi_a", "settling");
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
    expect(findResumableSwap(OTHER, NOW)?.id).toBe("xi_a");
  });

  it("is idempotent and tolerates an absent wallet", () => {
    upsertLocalSwap(WALLET, makeSwap("xi_a", NOW - 10_000, "settling"));
    dismissResumableSwap(WALLET, "xi_a", "settling");
    dismissResumableSwap(WALLET, "xi_a", "settling");
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
    expect(() => dismissResumableSwap(undefined, "xi_a", "settling")).not.toThrow();
  });
});

// The intent id is minted at QUOTE time and reused verbatim by execute, so
// "the user closed the confirm modal" and "the user closed a swap in flight"
// arrive with the SAME id. Dismissing on the first one permanently tombstones
// the second, and #398's resume never fires again for that trade. Only a
// dispatched swap may be dismissed.
describe("dismissal is gated on dispatch (#398 residue)", () => {
  const NOW = 1_800_000_000_000;
  const ID = "xi_quote_then_swap";

  beforeEach(() => {
    installFakeStorage();
  });

  // The exact reported sequence: quote, open the confirm modal, close it without
  // signing, then go ahead and swap. The swap runs under the same id.
  it("ignores a close before the swap is dispatched", () => {
    dismissResumableSwap(WALLET, ID, "quoted");
    upsertLocalSwap(WALLET, makeSwap(ID, NOW - 10_000, "settling"));
    expect(findResumableSwap(WALLET, NOW)?.id).toBe(ID);
  });

  it("records a close while the swap is in flight", () => {
    upsertLocalSwap(WALLET, makeSwap(ID, NOW - 10_000, "settling"));
    dismissResumableSwap(WALLET, ID, "settling");
    expect(findResumableSwap(WALLET, NOW)).toBeNull();
  });

  it("records a close from every status the modal can be resumed into", () => {
    for (const s of POLL_INFLIGHT_STATES) {
      installFakeStorage();
      upsertLocalSwap(WALLET, makeSwap(ID, NOW - 10_000, "settling"));
      dismissResumableSwap(WALLET, ID, s);
      expect(findResumableSwap(WALLET, NOW)).toBeNull();
    }
  });

  // Pre-dispatch statuses share an id with the swap that follows; terminal ones
  // are never resumable, so writing a tombstone for either is pure downside.
  it("ignores every pre-dispatch and terminal status", () => {
    for (const s of [
      "idle",
      "pending",
      "quoting",
      "quoted",
      "signing",
      "completed",
      "refunded",
      "failed",
      "expired",
    ] as const) {
      installFakeStorage();
      upsertLocalSwap(WALLET, makeSwap(ID, NOW - 10_000, "settling"));
      dismissResumableSwap(WALLET, ID, s);
      expect(findResumableSwap(WALLET, NOW)?.id).toBe(ID);
    }
  });
});

// #339. On mobile, deep-linking to the wallet backgrounds the tab and the OS
// often evicts it. `useIntent`'s poll is gated on in-memory `state.intentId`, so
// it never resumes and the modal is frozen on whatever last rendered -- while
// the solver settled server-side. The persisted record is the only thing that
// survives the eviction, and this is what advances it on the next load.
//
// The recovery already existed in `useLocalActivity.refresh` and had no test.
// Extracting the decision is what makes it assertable.
describe("reconcileLocalSwap (recovery after the tab dies mid-flight, #339)", () => {
  it("unfreezes a settling record the solver actually completed", () => {
    const stranded = makeSwap("xi_1", 100, "settling");
    const next = reconcileLocalSwap(
      stranded,
      polled("xi_1", {
        status: "completed",
        settlementTxHash: "0xreceipt",
        settlementChainId: 8453,
      }),
    );

    expect(next).not.toBeNull();
    expect(next?.intentStatus).toBe("completed");
    expect(next?.status).toBe(toActivityStatus("completed"));
    // The receipt has to survive the merge: `hasSettlementReceipt` keys off it,
    // and without it a landed fill still escalates to "Still settling".
    expect(next?.data.settlementTxHash).toBe("0xreceipt");
    expect(next?.data.settlementChainId).toBe(8453);
  });

  it("advances a record through a non-terminal step too", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "executing"),
      polled("xi_1", { status: "settling" }),
    );
    expect(next?.intentStatus).toBe("settling");
  });

  // xochi#376: Riddler can hold an intent at top-level `settling` with
  // `substatus: filled` indefinitely. `filled` is what tells a user whose
  // destination leg has landed apart from one still waiting, so a repeat of the
  // same status still has to merge.
  it("merges a fill substatus arriving on an unchanged status", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "settling"),
      polled("xi_1", { status: "settling", substatus: "filled" }),
    );
    expect(next?.intentStatus).toBe("settling");
    expect(next?.data.substatus).toBe("filled");
  });

  // The marker is how the feed tells a nothing-moved failure (retry) from one
  // that may have moved funds (no retry).
  it("records the Worker's not_executed marker on a failure", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "executing"),
      polled("xi_1", { status: "failed", substatus: "not_executed" }),
    );
    expect(next?.intentStatus).toBe("failed");
    expect(next?.data.substatus).toBe("not_executed");
  });

  it("records the Worker's awaiting_recipient marker on a settling payout", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "executing"),
      polled("xi_1", { status: "settling", substatus: "awaiting_recipient" }),
    );
    expect(next?.intentStatus).toBe("settling");
    expect(next?.data.substatus).toBe("awaiting_recipient");
  });

  // A transient poll failure must not be mistaken for information.
  it("leaves the record untouched on a transient failure", () => {
    expect(reconcileLocalSwap(makeSwap("xi_1", 100, "settling"), null)).toBeNull();
  });

  // The dangerous case: a dispatched record that 404s may actually have
  // completed (the #170 id overload), so it must never be false-failed.
  it("leaves a DISPATCHED record alone on a definitive 404", () => {
    for (const status of ["executing", "bridging", "settling"] as const) {
      expect(reconcileLocalSwap(makeSwap("xi_1", 100, status), { notFound: true })).toBeNull();
    }
  });

  // Only a swept pre-dispatch quote legitimately vanishes.
  it("terminalizes a swept pre-dispatch quote as expired", () => {
    const next = reconcileLocalSwap(makeSwap("xi_1", 100, "quoted"), { notFound: true });
    expect(next?.intentStatus).toBe("expired");
  });

  it("keeps existing hashes when the poll omits them", () => {
    const withHash = makeSwap("xi_1", 100, "settling");
    withHash.data.txHash = "0xalready";
    const next = reconcileLocalSwap(withHash, polled("xi_1", { status: "completed" }));
    expect(next?.data.txHash).toBe("0xalready");
  });

  // The self-heal case. A pre-fix client abort stamped an in-doubt execute
  // terminal `failed` with no tx hash; the transition table has no
  // `failed -> settling` edge, so the guard has to make an explicit exception or
  // the correction it exists for can never land.
  it("heals a false-failed record the server proves dispatched", () => {
    const falseFailure = makeSwap("xi_1", 100, "failed");
    const next = reconcileLocalSwap(falseFailure, polled("xi_1", { status: "settling" }));
    expect(next?.intentStatus).toBe("settling");
  });

  it("does not heal a failed record the server still holds pre-execution", () => {
    const genuine = makeSwap("xi_1", 100, "failed");
    expect(reconcileLocalSwap(genuine, polled("xi_1", { status: "quoted" }))).toBeNull();
  });

  it("does not heal a failed record that has a tx hash", () => {
    const withHash = makeSwap("xi_1", 100, "failed");
    withHash.data.txHash = "0xalready";
    expect(reconcileLocalSwap(withHash, polled("xi_1", { status: "settling" }))).toBeNull();
  });
});

// `reconcileLocalSwap` is the only trust boundary between the status response and
// persisted client state, and every case above uses a cooperative server. These
// are the ones where the server is wrong.
describe("reconcileLocalSwap (an uncooperative server)", () => {
  it("refuses a status that regressed, so a 404 cannot then expire the record", () => {
    // The compound bug: adopting `pending` puts a DISPATCHED record into the
    // sweepable pre-dispatch set, and the next 404 terminalizes it as `expired` --
    // a swap that may have moved funds, shown to the user as an expired quote.
    const dispatched = makeSwap("xi_1", 100, "settling");
    expect(reconcileLocalSwap(dispatched, polled("xi_1", { status: "pending" }))).toBeNull();
    expect(reconcileLocalSwap(dispatched, polled("xi_1", { status: "quoted" }))).toBeNull();
    // ...and the record it left behind is still not sweepable.
    expect(isSweepablePreDispatch(dispatched.intentStatus)).toBe(false);
  });

  it("refuses a jump backwards through the in-flight states", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "settling"),
      polled("xi_1", { status: "executing" }),
    );
    expect(next).toBeNull();
  });

  it("drops a substatus this build does not model", () => {
    const record = makeSwap("xi_1", 100, "settling");
    record.data.substatus = "filling";
    const next = reconcileLocalSwap(
      record,
      polled("xi_1", { status: "settling", substatus: "quantum_filled" }),
    );
    // Kept what it had rather than persisting an unmodeled string.
    expect(next?.data.substatus).toBe("filling");
  });

  it("drops a settlement chain the app cannot render", () => {
    const record = makeSwap("xi_1", 100, "settling");
    record.data.settlementChainId = 8453;
    const next = reconcileLocalSwap(
      record,
      // 999 is not a supported chain: there is no explorer origin for it, so a
      // receipt link built from it would be dead.
      polled("xi_1", {
        status: "completed",
        settlementTxHash: "0xreceipt",
        settlementChainId: 999,
      }),
    );
    expect(next?.data.settlementChainId).toBe(8453);
  });

  // Tron is a LIVE destination corridor and its fill settles on Tron. Validating
  // with the EVM-only `isChainId` dropped that to null, so the receipt lost its
  // authoritative chain and fell back to the legacy `settlementTxChainId`
  // inference -- and that link is the primary CTA on a cross-chain fill.
  // `SwapActivity.settlementChainId` is typed `SelectableChainId`, so the type
  // was permitting what this validator refused.
  it("keeps a Tron settlement chain (live destination corridor)", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "settling"),
      polled("xi_1", {
        status: "completed",
        settlementTxHash: "0xreceipt",
        settlementChainId: 728126428,
      }),
    );
    expect(next?.data.settlementChainId).toBe(728126428);
    expect(next?.data.settlementTxHash).toBe("0xreceipt");
  });

  it("keeps a null settlement chain null rather than inventing one", () => {
    const next = reconcileLocalSwap(
      makeSwap("xi_1", 100, "settling"),
      polled("xi_1", { status: "completed", settlementChainId: 999 }),
    );
    expect(next?.data.settlementChainId ?? null).toBeNull();
  });

  it("refuses a response for a different intent", () => {
    const record = makeSwap("xi_1", 100, "settling");
    expect(reconcileLocalSwap(record, polled("xi_OTHER", { status: "completed" }))).toBeNull();
  });

  it("still merges when the worker omits the intent id", () => {
    const record = makeSwap("xi_1", 100, "settling");
    const next = reconcileLocalSwap(
      record,
      polled("xi_1", { intentId: null, status: "completed" }),
    );
    expect(next?.intentStatus).toBe("completed");
  });

  it("models the substatuses the status normalizer buckets, plus the Worker's markers", () => {
    for (const s of ["pulling", "pulled", "filling", "filled", "refunding"] as const) {
      expect(isKnownSubstatus(s)).toBe(true);
    }
    expect(isKnownSubstatus("not_executed")).toBe(true);
    expect(isKnownSubstatus("awaiting_recipient")).toBe(true);
    expect(isKnownSubstatus("quantum_filled")).toBe(false);
  });
});

// The transition guard reads the STORED status, and `intentStatus` is typed
// IntentStatus without being guaranteed to hold one: `read()` parses localStorage
// as SwapActivityItem[] with no re-validation, so a row keeps whatever the build
// that wrote it put there -- for an agent-stream row, the solver's own vocabulary
// ("pulling", "filling"). `canTransitionTo` looks `from` up in the transition
// table, so an unmodeled `from` refuses EVERY `to`: the row is non-terminal, is
// re-polled every 4s forever, and can never adopt the answer it gets.
describe("reconcileLocalSwap (a stored status this build cannot read)", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  /**
   * Seed the store the way an older build left it and read it back through the
   * real path, so the record under test carries a genuinely unmodeled status
   * rather than an asserted one.
   */
  function seedStoredRecord(id: string, storedStatus: string): SwapActivityItem {
    const raw = { ...makeSwap(id, 100, "executing"), intentStatus: storedStatus };
    window.localStorage.setItem(
      `${STORAGE_KEYS.localActivityPrefix}${WALLET.toLowerCase()}`,
      JSON.stringify([raw]),
    );
    return listLocalSwaps(WALLET)[0];
  }

  it("advances a row stored under the solver's granular vocabulary", () => {
    const stored = seedStoredRecord("xi_1", "pulling");
    expect(stored.intentStatus).toBe("pulling");

    const next = reconcileLocalSwap(
      stored,
      polled("xi_1", { status: "completed", txHash: "0xfill" }),
    );
    expect(next?.intentStatus).toBe("completed");
    expect(next?.status).toBe("completed");
  });

  it("advances a row stored under a status no table models at all", () => {
    const stored = seedStoredRecord("xi_1", "quantum_settling");
    const next = reconcileLocalSwap(stored, polled("xi_1", { status: "completed" }));
    expect(next?.intentStatus).toBe("completed");
  });

  // The other direction, and the guard's whole point: deferring to the server on a
  // local value we cannot read must not become deferring to it on one we can. Both
  // assertions hold before this fix too (everything was refused); they are here so
  // the pair cannot drift apart later.
  it("still refuses a real regression from a dispatched status", () => {
    expect(
      reconcileLocalSwap(makeSwap("xi_1", 100, "settling"), polled("xi_1", { status: "quoted" })),
    ).toBeNull();

    // `pulling` buckets to `executing`, which is dispatched, so the same
    // regression is refused through the bucket rather than waved through.
    const stored = seedStoredRecord("xi_2", "pulling");
    expect(reconcileLocalSwap(stored, polled("xi_2", { status: "quoted" }))).toBeNull();
  });
});

// A status poll stays open for up to TIMEOUTS.requestTimeout (15s) while the feed
// re-polls every 4s, so a request opened for wallet A routinely resolves after the
// user has switched to wallet B. Nothing bound the result to the wallet it was
// opened for, so B's feed was rendered from A's rows -- token pair, amounts, tx
// hashes -- and B got a completion toast for A's swap. Same shared-device leak as
// the resume path (#398), different path.
describe("refreshLocalSwaps (a poll must not outlive its wallet)", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  /** A promise plus the handle that resolves it, so a test controls poll timing. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open = (): void => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  it("refreshes and persists while the wallet is still connected", async () => {
    upsertLocalSwap(WALLET, makeSwap("xi_1", 100, "settling"));
    const refreshed = await refreshLocalSwaps(
      WALLET,
      (): Promise<PolledStatus> =>
        Promise.resolve(polled("xi_1", { status: "completed", settlementTxHash: "0xreceipt" })),
      () => true,
    );

    expect(refreshed).not.toBeNull();
    expect(refreshed?.[0].intentStatus).toBe("completed");
    expect(listLocalSwaps(WALLET)[0].data.settlementTxHash).toBe("0xreceipt");
  });
  it("persists the status-only verdict of an anonymous read", async () => {
    upsertLocalSwap(WALLET, makeSwap("xi_1", 100, "settling"));
    const requested: string[] = [];

    const refreshed = await refreshLocalSwaps(
      WALLET,
      (intentId): Promise<PolledStatus> => {
        requested.push(intentId);
        return Promise.resolve(polled("xi_1", { status: "completed", legsWithheld: true }));
      },
      () => true,
    );

    expect(requested).toEqual(["xi_1"]);
    expect(refreshed?.[0].legsWithheld).toBe(true);
  });

  it("purges a read token an earlier build stored", () => {
    const key = `${STORAGE_KEYS.localActivityPrefix}${WALLET.toLowerCase()}`;
    window.localStorage.setItem(
      key,
      JSON.stringify([{ ...makeSwap("xi_1", 100, "completed"), readToken: "A".repeat(43) }]),
    );

    const [listed] = listLocalSwaps(WALLET);

    expect(listed.id).toBe("xi_1");
    expect("readToken" in listed).toBe(false);
    expect(window.localStorage.getItem(key)).not.toContain("readToken");
  });

  it("drops a result that lands after the wallet switched, and writes nothing", async () => {
    upsertLocalSwap(WALLET, makeSwap("xi_1", 100, "settling"));
    let connected: string = WALLET;
    const poll = gate();

    const inFlight = refreshLocalSwaps(
      WALLET,
      async (): Promise<PolledStatus> => {
        await poll.wait;
        return polled("xi_1", { status: "completed", settlementTxHash: "0xreceipt" });
      },
      () => isSameWallet(connected, WALLET),
    );

    // The user switches wallets while the request is still open.
    connected = OTHER_WALLET;
    poll.open();
    const refreshed = await inFlight;

    // Null, so the caller has nothing to render into the new wallet's feed and
    // no item to fire a completion toast from.
    expect(refreshed).toBeNull();
    // The other wallet's log is untouched...
    expect(listLocalSwaps(OTHER_WALLET)).toEqual([]);
    // ...and so is the original, since the persist is guarded too.
    expect(listLocalSwaps(WALLET)[0].intentStatus).toBe("settling");
  });

  it("drops a result when the wallet disconnects mid-poll", async () => {
    upsertLocalSwap(WALLET, makeSwap("xi_1", 100, "settling"));
    let connected: string | undefined = WALLET;
    const poll = gate();

    const inFlight = refreshLocalSwaps(
      WALLET,
      async (): Promise<PolledStatus> => {
        await poll.wait;
        return polled("xi_1", { status: "completed" });
      },
      () => isSameWallet(connected, WALLET),
    );

    connected = undefined;
    poll.open();
    expect(await inFlight).toBeNull();
  });

  it("treats a differently-cased address as the same wallet", async () => {
    upsertLocalSwap(WALLET, makeSwap("xi_1", 100, "settling"));
    const refreshed = await refreshLocalSwaps(
      WALLET,
      (): Promise<PolledStatus> => Promise.resolve(polled("xi_1", { status: "completed" })),
      () => isSameWallet(WALLET.toUpperCase(), WALLET.toLowerCase()),
    );
    expect(refreshed?.[0].intentStatus).toBe("completed");
  });
});

// SPEC §5.1 (0.11.0): a private intent's status-only view withholds the fill
// receipt and substatus; `settlement_confirmed` is the one delivery signal left.
describe("status-only view: settlement_confirmed", () => {
  const stealth = (status: IntentStatus): SwapActivityItem => {
    const s = makeSwap("xi_priv", 100, status);
    return { ...s, data: { ...s.data, settlementType: "stealth" } };
  };

  it("reads it as delivery without making the record terminal", () => {
    const next = reconcileLocalSwap(
      stealth("settling"),
      polled("xi_priv", {
        status: "settling",
        terminal: false,
        legsWithheld: true,
        settlementConfirmed: true,
      }),
    );
    if (!next) throw new Error("expected the settling read to be adopted");
    expect(next.intentStatus).toBe("settling");
    expect(isTerminalIntentStatus(next.intentStatus)).toBe(false);
    expect(next.data.settlementConfirmed).toBe(true);
    expect(next.data.settlementTxHash ?? null).toBeNull();
  });

  it("follows the latest withheld read, and an owner read leaves it be", () => {
    const confirmed = {
      ...stealth("settling"),
      data: { ...stealth("settling").data, settlementConfirmed: true },
    };
    const owner = reconcileLocalSwap(
      confirmed,
      polled("xi_priv", { status: "settling", terminal: false, settlementTxHash: "0xfill" }),
    );
    expect(owner?.data.settlementConfirmed).toBe(true);
    expect(owner?.data.settlementTxHash).toBe("0xfill");

    // The client reports false on a refund (`withheldSettlementConfirmed`).
    const refunding = reconcileLocalSwap(
      confirmed,
      polled("xi_priv", {
        status: "settling",
        terminal: false,
        legsWithheld: true,
        settlementConfirmed: false,
      }),
    );
    expect(refunding?.data.settlementConfirmed).toBe(false);
  });
});
