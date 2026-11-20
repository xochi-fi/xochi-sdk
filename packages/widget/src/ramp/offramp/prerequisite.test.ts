import { describe, expect, it } from "vitest";
import { atomic, type RampMoney, type RampLegSnapshot, type XochiRampDriver } from "@xochi/client";
import { memoryOfframpPort } from "../../test/offrampPort.js";
import { buildRampIntent } from "../availability/model.js";
import { disclosureCodes } from "./model.js";
import { createOfframpPrerequisite } from "./prerequisite.js";
import { ROUTE_RECEIVED, ROUTE_WALLET, routeHarness } from "../../test/routePort.js";

class MemoryPrerequisite implements XochiRampDriver {
  quotes = 0;
  executions = 0;
  polls = 0;
  balance = 0n;
  throwExecute = false;
  now = Date.parse("2026-11-16T12:00:00Z");
  result: RampLegSnapshot = { name: "xochi", state: "completed", recoverable: false };
  source: RampMoney = {
    ...ROUTE_RECEIVED,
    asset: {
      kind: "crypto",
      chain_id: "eip155:1",
      asset_id: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    },
  };
  async quote() {
    this.quotes++;
    return {
      quoteId: `route_${this.quotes}`,
      expiresAt: new Date(this.now + 30_000).toISOString(),
      pay: this.source,
      receive: { ...ROUTE_RECEIVED, atomic: atomic("24000000") },
      recipient: ROUTE_WALLET,
      settlement: "public" as const,
    };
  }
  async execute() {
    this.executions++;
    if (this.throwExecute) throw new Error("route_unavailable");
    return this.result;
  }
  async poll() {
    this.polls++;
    return this.result;
  }
  route() {
    return createOfframpPrerequisite({
      source: this.source,
      driver: this,
      wallet: ROUTE_WALLET,
      spendable: async () => this.balance,
      now: () => this.now,
    });
  }
}

describe("independent ramp legs", () => {
  it("onramp: Peer success survives a failed Xochi route", async () => {
    const h = await routeHarness();
    const ctx = (revision: string) => ({
      expected_revision: revision,
      idempotency_key: crypto.randomUUID(),
    });
    let s = await h.client.offerRoute(h.snapshot.operation_id, ctx("0"));
    s = await h.client.recover(s.operation_id, "xochi", "approve_route", ctx(s.revision));
    h.driver.result = {
      name: "xochi",
      state: "failed",
      recoverable: true,
      failure_code: "route_failed",
    };
    s = await h.client.recover(s.operation_id, "xochi", "execute_route", ctx(s.revision));
    expect(s.peer.state).toBe("completed");
    expect(s.xochi?.state).toBe("failed");
    expect(h.peer.calls).toBe(0);
  });

  it("offramp: route receipt alone cannot authorize Peer; balance is read afresh", async () => {
    const io = new MemoryPrerequisite();
    const route = io.route();
    expect(await route.funded("24000000")).toBe(false);
    await route.act("quote");
    expect(route.snapshot().leg_order).toEqual(["xochi", "peer"]);
    expect(await route.funded("24000000")).toBe(false);
    await route.act("execute");
    expect(route.snapshot().xochi?.state).toBe("completed");
    expect(await route.funded("24000000")).toBe(false);
    io.balance = 24_000_000n;
    expect(await route.funded("24000000")).toBe(true);
    expect(await route.funded("24000001")).toBe(false);
    io.balance = 0n;
    expect(await route.funded("24000000")).toBe(false);
  });

  it("offramp: Peer failure and recovery cannot repeat the completed prerequisite", async () => {
    const io = new MemoryPrerequisite();
    const route = io.route();
    await route.act("quote");
    await route.act("execute");
    io.balance = 24_000_000n;
    const port = memoryOfframpPort({ account: ROUTE_WALLET });
    const { provider, client } = await port.runtime(ROUTE_WALLET);
    const intent = buildRampIntent({
      direction: "offramp",
      amount: "24000000",
      currency: "USD",
      recipient: ROUTE_WALLET,
      settlement: port.settlement()!,
    });
    const offers = provider.normalizeCapabilities(await provider.capabilities(intent), intent);
    const offer = offers.find((o) => o.availability.state === "available")!;
    const preview = await client.preview(intent, offer.offer_id, offer.capability_revision);
    await provider.setOwnAccount(preview.operation_id, "synthetic-own-account", "own_account");
    // Readiness changes after the estimate: real maker approval must fail closed.
    port.maker.ready.oracleFresh = false;
    const peer = await client.approve(
      preview.operation_id,
      preview.quote_id,
      disclosureCodes(preview),
      { expected_revision: "0", idempotency_key: "peer_approval" },
    );
    expect(peer.peer.state).toBe("failed");
    expect(port.maker.deposits).toBe(0);
    expect(await route.funded("24000000")).toBe(true);
    await route.act("quote");
    await route.act("execute");
    await route.act("check");
    port.maker.ready.oracleFresh = true;
    const refreshed = provider.normalizeCapabilities(await provider.capabilities(intent), intent);
    expect(refreshed.some((o) => o.availability.state === "available")).toBe(true);
    expect(route.snapshot().xochi?.state).toBe("completed");
    expect(io.executions).toBe(1);
    expect(io.quotes).toBe(1);
  });

  it("unknown submission permits reconciliation only, never another route", async () => {
    const io = new MemoryPrerequisite();
    io.throwExecute = true;
    const route = io.route();
    await route.act("quote");
    await route.act("execute");
    expect(route.snapshot().xochi?.state).toBe("in_doubt");
    await route.act("quote");
    await route.act("execute");
    expect(io.executions).toBe(1);
    expect(io.quotes).toBe(1);
    io.balance = 24_000_000n;
    expect(await route.funded("24000000")).toBe(false);
    await route.act("check");
    expect(await route.funded("24000000")).toBe(true);
  });

  it("rejects expiry and requires a fresh quote after a provably unsubmitted failure", async () => {
    const io = new MemoryPrerequisite();
    const route = io.route();
    await route.act("quote");
    io.now += 30_001;
    await route.act("execute");
    expect(io.executions).toBe(0);
    expect(route.snapshot().xochi?.failure_code).toBe("quote_expired");
    await route.act("quote");
    await route.act("execute");
    expect(io.quotes).toBe(2);
    expect(io.executions).toBe(1);
  });
});

describe("W6 durable prerequisite", () => {
  it("reload reconciles the original route without another execution", async () => {
    const io = new MemoryPrerequisite();
    const rows = new Map<string, string>();
    const storage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        rows.set(key, value);
      },
    };
    const options = {
      source: io.source,
      driver: io,
      wallet: ROUTE_WALLET,
      spendable: async () => io.balance,
      now: () => io.now,
      storage,
    };
    io.result = { name: "xochi", state: "processing", recoverable: false };
    const first = createOfframpPrerequisite(options);
    const stale = createOfframpPrerequisite(options);
    await first.act("quote");
    await stale.act("quote");
    await first.act("execute");
    const reloaded = createOfframpPrerequisite(options);
    await reloaded.act("quote");
    await reloaded.act("execute");
    expect(io.executions).toBe(1);
    await expect(stale.act("execute")).rejects.toThrow("checkpoint_changed");
    expect(reloaded.snapshot().operation_id).toBe(first.snapshot().operation_id);
    io.result = { name: "xochi", state: "completed", recoverable: false };
    await reloaded.act("check");
    io.balance = 24_000_000n;
    expect(await reloaded.funded("24000000")).toBe(true);
    const completed = createOfframpPrerequisite(options);
    expect(completed.snapshot().xochi?.state).toBe("completed");
    expect(await completed.funded("24000000")).toBe(true);
    await completed.act("execute");
    expect(io.executions).toBe(1);
  });
});
