import { describe, expect, it, vi } from "vitest";
import {
  atomic,
  rampOutcome,
  type RampLegSnapshot,
  type RampSnapshot,
  type RampMoney,
} from "./ramp.js";
import { createMemoryRampOperationStore } from "./rampOperationStore.js";
import { createRampClient } from "./rampClient.js";
import type { RampProvider } from "./rampProvider.js";
import { createXochiRampLeg, type XochiRampDriver, type XochiRampPreview } from "./xochiRampLeg.js";

const delivered: RampMoney = {
  asset: {
    kind: "crypto",
    chain_id: "eip155:8453",
    asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
  },
  atomic: atomic("25000000"),
};
const wallet = "0x1111111111111111111111111111111111111111";
const completed: RampLegSnapshot = {
  name: "xochi",
  state: "completed",
  recoverable: false,
  transaction_hash: `0x${"12".repeat(32)}`,
};
const failed: RampLegSnapshot = {
  name: "xochi",
  state: "failed",
  recoverable: true,
  failure_code: "route_failed",
};
const doubt: RampLegSnapshot = {
  name: "xochi",
  state: "in_doubt",
  recoverable: true,
  failure_code: "xochi_in_doubt",
};
class MemoryXochi implements XochiRampDriver {
  quotes = 0;
  executions = 0;
  polls = 0;
  quoteFails = false;
  quoteHang = false;
  quoteStarted = Promise.withResolvers<void>();
  execution: RampLegSnapshot | Error = completed;
  polled: RampLegSnapshot | Error = completed;
  now = Date.parse("2026-11-16T12:00:00Z");
  settlement: "public" | "stealth" = "public";
  async quote(): Promise<XochiRampPreview> {
    this.quotes++;
    this.quoteStarted.resolve();
    if (this.quoteHang) return new Promise<XochiRampPreview>(() => {});
    if (this.quoteFails) throw new Error("route_failed");
    return {
      quoteId: `route_quote_${this.quotes}`,
      expiresAt: new Date(this.now + 30_000).toISOString(),
      pay: delivered,
      receive: { ...delivered, atomic: atomic("24000000") },
      recipient: wallet,
      settlement: this.settlement,
    };
  }
  async execute() {
    this.executions++;
    if (this.execution instanceof Error) throw this.execution;
    return this.execution;
  }
  async poll() {
    this.polls++;
    if (this.polled instanceof Error) throw this.polled;
    return this.polled;
  }
}
/** A provider with a read-only, scripted chain; accidental resubmission is a test failure. */
class MemoryPeer implements RampProvider {
  readonly id = "peer";
  submissions = 0;
  reads = 0;
  snapshot!: RampSnapshot;
  async capabilities() {
    return [];
  }
  normalizeCapabilities() {
    return [];
  }
  async preview(): Promise<never> {
    throw new Error("invalid_request");
  }
  async approve(): Promise<never> {
    this.submissions++;
    throw new Error("invalid_request");
  }
  async interact(): Promise<never> {
    this.submissions++;
    throw new Error("invalid_request");
  }
  async recover(): Promise<never> {
    this.submissions++;
    throw new Error("invalid_request");
  }
  async status() {
    this.reads++;
    return this.snapshot;
  }
}
async function harness(
  peerState: RampSnapshot["peer"] = {
    name: "peer",
    state: "completed",
    recoverable: false,
    payout_state: "released",
  },
  commandTimeoutMs?: number,
) {
  const store = createMemoryRampOperationStore();
  const driver = new MemoryXochi();
  const peer = new MemoryPeer();
  let snapshot: RampSnapshot = {
    contract_version: "ramp/1",
    kind: "snapshot",
    operation_id: "ramp_local_test",
    revision: "0",
    direction: "onramp",
    leg_order: ["peer"],
    peer: { ...peerState, name: "peer" },
    allowed_actions: ["check_status"],
    updated_at: new Date(driver.now).toISOString(),
    terminal: false,
  };
  snapshot = {
    ...snapshot,
    terminal: rampOutcome(snapshot).terminal,
    allowed_actions: rampOutcome(snapshot).terminal ? [] : ["check_status"],
  };
  peer.snapshot = snapshot;
  await store.transact(snapshot.operation_id, () => ({
    record: { snapshot, receipts: {} },
    result: undefined,
  }));
  const leg = createXochiRampLeg({ store, driver, delivered, now: () => driver.now });
  const client = createRampClient({ peer, xochi: leg, store, commandTimeoutMs });
  let seq = 0;
  const context = (s: RampSnapshot) => ({
    expected_revision: s.revision,
    idempotency_key: `action_${++seq}`,
  });
  const offer = async () => {
    snapshot = await client.offerRoute(snapshot.operation_id, context(snapshot));
    return snapshot;
  };
  const act = async (
    action: "approve_route" | "execute_route" | "recover_route" | "skip_route" | "check_status",
  ) => {
    snapshot = await client.recover(snapshot.operation_id, "xochi", action, context(snapshot));
    expect(snapshot.peer).toEqual(peerState);
    expect(peer.submissions).toBe(0);
    return snapshot;
  };
  return { store, peer, driver, leg, client, context, offer, act, snapshot: () => snapshot };
}

describe("independent onramp Xochi leg", () => {
  it("a timed-out quote is a recoverable route failure, not uncertain money movement", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness(undefined, 10);
      await h.offer();
      h.driver.quoteHang = true;
      const pending = h.act("approve_route");
      await h.driver.quoteStarted.promise;
      await vi.advanceTimersByTimeAsync(11);
      const result = await pending;
      expect(result.xochi?.state).toBe("failed");
      expect(rampOutcome(result).state).toBe("partial_success");
      expect(result.allowed_actions).toContain("recover_route");
      expect(h.driver.executions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("an unsafe failed execute remains in doubt and cannot enable a retry", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    h.driver.execution = {
      name: "xochi",
      state: "failed",
      recoverable: false,
      failure_code: "route_failed",
    };
    const result = await h.act("execute_route");
    expect(result.xochi?.state).toBe("in_doubt");
    expect(result.allowed_actions).toEqual(["check_status"]);
  });
  it.each(["public", "stealth"] as const)(
    "reviews and separately executes a fresh %s route",
    async (settlement) => {
      const h = await harness();
      h.driver.settlement = settlement;
      const offered = await h.offer();
      expect(offered.allowed_actions).toEqual(["approve_route", "skip_route"]);
      expect(h.driver.quotes).toBe(0);
      expect((await h.act("approve_route")).xochi?.state).toBe("action_required");
      expect(h.leg.preview(offered.operation_id)?.settlement).toBe(settlement);
      expect(h.driver.executions).toBe(0);
      const done = await h.act("execute_route");
      expect(done.xochi?.transaction_hash).toBe(completed.transaction_hash);
      expect(rampOutcome(done)).toEqual({ terminal: true, state: "completed" });
      expect(h.driver.quotes).toBe(1);
      expect(h.driver.executions).toBe(1);
    },
  );
  it.each([
    { name: "peer", state: "not_started", recoverable: false },
    { name: "peer", state: "quoted", recoverable: false },
    { name: "peer", state: "action_required", recoverable: false },
    { name: "peer", state: "processing", recoverable: false },
    { name: "peer", state: "processing", recoverable: false, payout_state: "held" },
    { name: "peer", state: "in_doubt", recoverable: true },
    { name: "peer", state: "failed", recoverable: true },
    { name: "peer", state: "failed", recoverable: false },
    { name: "peer", state: "refunded", recoverable: false },
  ] satisfies RampSnapshot["peer"][])(
    "never quotes before Peer delivery: $state/$payout_state",
    async (peer) => {
      const h = await harness(peer);
      expect((await h.offer()).xochi).toBeUndefined();
      await h.act("approve_route");
      expect(h.driver.quotes).toBe(0);
      expect(h.driver.executions).toBe(0);
      await expect(
        h.leg.approve(h.snapshot().operation_id, h.context(h.snapshot())),
      ).rejects.toThrow("invalid_request");
    },
  );
  it("offers after a held payout is released without another Peer submission", async () => {
    const h = await harness({
      name: "peer",
      state: "processing",
      recoverable: false,
      payout_state: "held",
    });
    expect((await h.offer()).xochi).toBeUndefined();
    h.peer.snapshot = {
      ...h.snapshot(),
      peer: { name: "peer", state: "completed", recoverable: false, payout_state: "released" },
      terminal: true,
      allowed_actions: [],
    };
    const released = await h.client.recover(
      h.snapshot().operation_id,
      "peer",
      "check_status",
      h.context(h.snapshot()),
    );
    const offered = await h.client.offerRoute(released.operation_id, h.context(released));
    expect(offered.xochi?.state).toBe("not_started");
    expect(h.peer.submissions).toBe(0);
    expect(h.driver.quotes).toBe(0);
  });
  it("a failed quote is partial success; retry only obtains another Xochi quote", async () => {
    const h = await harness();
    await h.offer();
    h.driver.quoteFails = true;
    const result = await h.act("approve_route");
    expect(rampOutcome(result)).toEqual({ terminal: false, state: "partial_success" });
    h.driver.quoteFails = false;
    expect((await h.act("recover_route")).xochi?.state).toBe("action_required");
    expect(h.driver.quotes).toBe(2);
    expect(h.driver.executions).toBe(0);
    expect((await h.act("execute_route")).xochi?.state).toBe("completed");
  });
  it("expires only the Xochi quote and retries with a new quote", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    const original = h.leg.preview(h.snapshot().operation_id)?.quoteId;
    h.driver.now += 30_001;
    expect((await h.act("execute_route")).xochi?.failure_code).toBe("quote_expired");
    expect(h.driver.executions).toBe(0);
    await h.act("recover_route");
    expect(h.leg.preview(h.snapshot().operation_id)?.quoteId).not.toBe(original);
    expect((await h.act("execute_route")).xochi?.state).toBe("completed");
  });
  it("wallet refusal or a proven unsubmitted failure can be retried or skipped", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    h.driver.execution = failed;
    expect((await h.act("execute_route")).xochi?.state).toBe("failed");
    await h.act("recover_route");
    expect(h.driver.quotes).toBe(2);
    h.driver.execution = failed;
    await h.act("execute_route");
    const skipped = await h.act("skip_route");
    expect(skipped.xochi?.state).toBe("skipped");
    expect(rampOutcome(skipped)).toEqual({ terminal: true, state: "completed" });
  });
  it("a lost execute answer reconciles the original route and blocks retry and skip", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    h.driver.execution = new Error("provider_timeout");
    const unknown = await h.act("execute_route");
    expect(unknown.allowed_actions).toEqual(["check_status"]);
    await h.act("recover_route");
    await h.act("approve_route");
    await h.act("skip_route");
    expect(h.driver.quotes).toBe(1);
    expect(h.driver.executions).toBe(1);
    h.driver.polled = doubt;
    expect((await h.act("check_status")).xochi?.state).toBe("in_doubt");
    h.driver.polled = completed;
    expect((await h.act("check_status")).xochi?.state).toBe("completed");
    expect(h.driver.executions).toBe(1);
  });
  it("uncertainty must become proven failure before retry obtains a fresh quote", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    h.driver.execution = { name: "xochi", state: "processing", recoverable: false };
    await h.act("execute_route");
    h.driver.polled = new Error("provider_timeout");
    expect((await h.act("check_status")).xochi?.state).toBe("in_doubt");
    h.driver.polled = failed;
    expect(rampOutcome(await h.act("check_status")).state).toBe("partial_success");
    await h.act("recover_route");
    h.driver.execution = completed;
    expect((await h.act("execute_route")).xochi?.state).toBe("completed");
    expect(h.driver.quotes).toBe(2);
    expect(h.driver.executions).toBe(2);
  });
  it("skips before any quote without invoking Xochi or Peer", async () => {
    const h = await harness();
    await h.offer();
    const result = await h.act("skip_route");
    expect(result.xochi?.state).toBe("skipped");
    expect(result.peer.state).toBe("completed");
    expect(h.driver.quotes + h.driver.executions + h.driver.polls + h.peer.submissions).toBe(0);
  });
  it("concurrent approvals and execution replays cross the Xochi boundary once", async () => {
    const h = await harness();
    const offered = await h.offer();
    const context = h.context(offered);
    const approve = () => h.client.recover(offered.operation_id, "xochi", "approve_route", context);
    await Promise.all([approve(), approve()]);
    expect(h.driver.quotes).toBe(1);
    const ready = await h.client.get(offered.operation_id);
    const execution = h.context(ready);
    const execute = () => h.client.recover(ready.operation_id, "xochi", "execute_route", execution);
    await Promise.all([execute(), execute()]);
    await execute();
    expect(h.driver.executions).toBe(1);
  });
  it("a stale quoted reference cannot authorize the current route", async () => {
    const h = await harness();
    await h.offer();
    await h.act("approve_route");
    expect(
      (await h.leg.execute(h.snapshot().operation_id, "old_quote", h.context(h.snapshot()))).xochi
        ?.failure_code,
    ).toBe("quote_changed");
    expect(h.driver.executions).toBe(0);
  });
});
