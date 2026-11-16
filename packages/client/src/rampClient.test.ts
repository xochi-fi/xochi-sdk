// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { createRampClient } from "./rampClient.js";
import {
  createBrowserRampOperationStore,
  createMemoryRampOperationStore,
  type RampOperationStore,
} from "./rampOperationStore.js";
import type { RampProvider, XochiRampLeg } from "./rampProvider.js";
import {
  atomic,
  rampOutcome,
  type RampCommandContext,
  type RampDirection,
  type RampIntent,
  type RampLegName,
  type RampLegState,
  type RampOffer,
  type RampPreview,
  type RampSnapshot,
} from "./ramp.js";

const fiat = { kind: "fiat" as const, currency: "USD", decimals: 2 };
const crypto = {
  kind: "crypto" as const,
  chain_id: "eip155:8453",
  asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  decimals: 6,
};
const disclosures = {
  public_state: ["base_public"],
  identity_visible_to: ["counterparty"],
  liveness_dependencies: ["peer_tee"],
};
const accepted = Object.values(disclosures).flat();
const future = "2099-01-01T00:00:00Z";
const ctx = (revision: string, key: string): RampCommandContext => ({
  expected_revision: revision,
  idempotency_key: key,
});
function intent(direction: RampDirection = "onramp", route = false): RampIntent {
  return {
    contract_version: "ramp/1",
    kind: "intent",
    direction,
    fiat,
    crypto,
    exact: { side: "fiat", money: { asset: fiat, atomic: atomic("10000") } },
    recipient: "0x1111111111111111111111111111111111111111",
    ...(route
      ? {
          route: {
            from: crypto,
            to: crypto,
            recipient: "0x1111111111111111111111111111111111111111",
            settlement: "public" as const,
          },
        }
      : {}),
  };
}
class FakeProvider implements RampProvider {
  readonly id = "peer";
  calls = { approve: 0, interact: 0, status: 0, recover: 0, capabilities: 0 };
  request = intent();
  capabilityRevision = "cap_test";
  quoteExpiry = future;
  routeQuoteId = "route_quote_test";
  script: Array<RampLegState | Error | (() => Promise<RampSnapshot>) | "unknown"> = [];
  offer(): RampOffer {
    return {
      contract_version: "ramp/1",
      kind: "offer",
      offer_id: "offer_test",
      capability_revision: this.capabilityRevision,
      provider_id: "peer",
      direction: this.request.direction,
      fiat,
      crypto,
      rail: { id: "test_rail", label: "Test rail" },
      bounds: {
        measured_in: "fiat",
        minimum: { asset: fiat, atomic: atomic("100") },
        maximum: { asset: fiat, atomic: atomic("100000") },
      },
      interaction: { presentation: "manual", requirement_codes: [] },
      availability: { state: "available", valid_until: future },
      disclosures,
      observed_at: "2026-01-01T00:00:00Z",
    };
  }
  async capabilities(request: RampIntent) {
    this.calls.capabilities++;
    this.request = request;
    return undefined;
  }
  normalizeCapabilities() {
    return [this.offer()];
  }
  async preview(request: RampIntent): Promise<RampPreview> {
    this.request = request;
    return {
      contract_version: "ramp/1",
      kind: "preview",
      operation_id: "op_test",
      quote_id: "quote_test",
      offer_id: "offer_test",
      capability_revision: "cap_test",
      request_digest: `0x${"0".repeat(64)}`,
      pay: { asset: request.direction === "onramp" ? fiat : crypto, atomic: atomic("10000") },
      receive: { asset: request.direction === "onramp" ? crypto : fiat, atomic: atomic("10000") },
      fees: [],
      expires_at: this.quoteExpiry,
      leg_order: request.route
        ? request.direction === "onramp"
          ? ["peer", "xochi"]
          : ["xochi", "peer"]
        : ["peer"],
      disclosures,
    };
  }
  snapshot(leg: RampLegName, state: RampLegState): RampSnapshot {
    const s: RampSnapshot = {
      contract_version: "ramp/1",
      kind: "snapshot",
      operation_id: "op_test",
      revision: "999",
      direction: this.request.direction,
      leg_order: this.request.route
        ? this.request.direction === "onramp"
          ? ["peer", "xochi"]
          : ["xochi", "peer"]
        : ["peer"],
      peer: { name: "peer", state: "quoted", recoverable: false },
      ...(this.request.route
        ? { xochi: { name: "xochi" as const, state: "quoted" as const, recoverable: false } }
        : {}),
      allowed_actions: [],
      terminal: false,
      updated_at: "2026-01-01T00:00:00Z",
    };
    Object.assign(s, { [leg]: { name: leg, state, recoverable: state === "in_doubt" } });
    s.terminal = rampOutcome(s).terminal;
    if (state === "in_doubt") s.allowed_actions = ["check_status"];
    return s;
  }
  async next(leg: RampLegName): Promise<RampSnapshot> {
    const next = this.script.shift() ?? "completed";
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    if (next === "unknown") return {} as RampSnapshot;
    return this.snapshot(leg, next);
  }
  async approve() {
    this.calls.approve++;
    return this.next("peer");
  }
  async interact() {
    this.calls.interact++;
    return this.next("peer");
  }
  async status() {
    this.calls.status++;
    return this.next("peer");
  }
  async recover() {
    this.calls.recover++;
    return this.next("peer");
  }
  route(): XochiRampLeg {
    return {
      quoteId: async () => this.routeQuoteId,
      approve: () => this.next("xochi"),
      execute: () => this.next("xochi"),
      status: () => this.next("xochi"),
      recover: () => this.next("xochi"),
    };
  }
}
async function setup(
  request = intent(),
  store: RampOperationStore = createMemoryRampOperationStore(),
) {
  const peer = new FakeProvider();
  const client = createRampClient({ peer, xochi: peer.route(), store });
  await client.preview(request, "offer_test", "cap_test");
  return { peer, client, store };
}

describe("resumable ramp commands", () => {
  it("returns immutable exact receipts before revision checks and conflicts on changed content", async () => {
    const { peer, client } = await setup();
    peer.script.push("action_required", "completed");
    const first = await client.approve("op_test", "quote_test", accepted, ctx("0", "approve_test"));
    const last = await client.interact("op_test", {}, ctx(first.revision, "interact_test"));
    expect(
      await client.approve("op_test", "quote_test", accepted, ctx("0", "approve_test")),
    ).toEqual(first);
    expect(
      await client.approve("op_test", "quote_other", accepted, ctx("0", "approve_test")),
    ).toEqual(last);
    expect(await client.approve("op_test", "quote_test", accepted, ctx("0", "stale_test"))).toEqual(
      last,
    );
    expect(peer.calls.approve).toBe(1);
    expect(Object.isFrozen(first.peer)).toBe(true);
    expect(first.peer.state).toBe("action_required");
    expect(last.peer.state).toBe("completed");
  });

  it("atomically reserves competing commands across client instances before provider submission", async () => {
    const { peer, client, store } = await setup();
    let finish!: (s: RampSnapshot) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    peer.script.push(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const submitting = client.approve("op_test", "quote_test", accepted, ctx("0", "first_test"));
    await start;
    const resumed = createRampClient({ peer, store });
    const reserved = await resumed.get("op_test");
    expect(reserved.peer.state).toBe("in_doubt");
    expect(
      await resumed.approve("op_test", "quote_test", accepted, ctx("0", "second_test")),
    ).toEqual(reserved);
    expect(
      await resumed.approve("op_test", "quote_test", accepted, ctx("0", "first_test")),
    ).toEqual(reserved);
    expect(peer.calls.approve).toBe(1);
    finish(peer.snapshot("peer", "completed"));
    expect((await submitting).peer.state).toBe("completed");
  });

  it.each([new Error("provider_timeout"), "unknown" as const, "in_doubt" as const])(
    "reconciles uncertain outcomes without resubmitting: %s",
    async (outcome) => {
      const { peer, client, store } = await setup();
      peer.script.push(outcome);
      const uncertain = await client.approve(
        "op_test",
        "quote_test",
        accepted,
        ctx("0", "submit_test"),
      );
      expect(uncertain.peer.state).toBe("in_doubt");
      expect(uncertain.allowed_actions).toEqual(["check_status"]);
      const resumed = createRampClient({ peer, store });
      expect(await resumed.interact("op_test", {}, ctx(uncertain.revision, "again_test"))).toEqual(
        uncertain,
      );
      const final = await resumed.recover(
        "op_test",
        "peer",
        "check_status",
        ctx(uncertain.revision, "status_test"),
      );
      expect(final.peer.state).toBe("completed");
      expect(final.terminal).toBe(true);
      expect(peer.calls).toMatchObject({ approve: 1, interact: 0, status: 1 });
      expect(
        await resumed.approve("op_test", "quote_test", accepted, ctx("0", "submit_test")),
      ).toEqual(uncertain);
    },
  );

  it.each(["onramp", "offramp"] as const)(
    "keeps successful legs after the other fails: %s",
    async (direction) => {
      const { client, peer } = await setup(intent(direction, true));
      peer.script.push("completed", "failed");
      let first: RampSnapshot;
      let second: RampSnapshot;
      if (direction === "onramp") {
        first = await client.approve("op_test", "quote_test", accepted, ctx("0", "peer_test"));
        second = await client.recover(
          "op_test",
          "xochi",
          "approve_route",
          ctx(first.revision, "route_test"),
        );
        expect(second.peer.state).toBe("completed");
        expect(second.xochi?.state).toBe("failed");
      } else {
        expect(
          (await client.approve("op_test", "quote_test", accepted, ctx("0", "early_test")))
            .revision,
        ).toBe("0");
        first = await client.recover("op_test", "xochi", "approve_route", ctx("0", "route_test"));
        second = await client.approve(
          "op_test",
          "quote_test",
          accepted,
          ctx(first.revision, "peer_test"),
        );
        expect(second.xochi?.state).toBe("completed");
        expect(second.peer.state).toBe("failed");
      }
      expect(rampOutcome(second)).toEqual({ state: "partial_success", terminal: true });
    },
  );

  it("invalidates a changed capability before submission", async () => {
    const { client, peer } = await setup();
    peer.capabilityRevision = "cap_changed";
    const result = await client.approve(
      "op_test",
      "quote_test",
      accepted,
      ctx("0", "changed_test"),
    );
    expect(result.peer.failure_code).toBe("quote_changed");
    expect(result.peer.state).toBe("failed");
    expect(peer.calls.approve).toBe(0);
  });

  it("does not refresh capabilities or fail over submitted operations", async () => {
    const { client, peer } = await setup();
    peer.script.push("action_required", "completed");
    const first = await client.approve("op_test", "quote_test", accepted, ctx("0", "approve_test"));
    const count = peer.calls.capabilities;
    peer.capabilityRevision = "cap_changed";
    expect(
      (await client.interact("op_test", {}, ctx(first.revision, "interact_test"))).peer.state,
    ).toBe("completed");
    expect(peer.calls.capabilities).toBe(count);
  });

  it("requires disclosure acceptance and the bound quote before calling providers", async () => {
    const { client, peer } = await setup();
    expect(
      (await client.approve("op_test", "quote_wrong", accepted, ctx("0", "wrong_test"))).revision,
    ).toBe("0");
    expect(
      (await client.approve("op_test", "quote_test", [], ctx("0", "missing_test"))).revision,
    ).toBe("0");
    expect(peer.calls.approve).toBe(0);
  });

  it("skips an optional onramp route while preserving confirmed Peer delivery", async () => {
    const { client } = await setup(intent("onramp", true));
    const funded = await client.approve("op_test", "quote_test", accepted, ctx("0", "peer_test"));
    const final = await client.recover(
      "op_test",
      "xochi",
      "skip_route",
      ctx(funded.revision, "skip_test"),
    );
    expect(final.peer.state).toBe("completed");
    expect(final.xochi?.state).toBe("skipped");
    expect(final.terminal).toBe(true);
  });

  it.each([2, 3])("keeps submission safe if store transaction %s fails", async (failure) => {
    const backing = createMemoryRampOperationStore();
    let count = 0;
    const store: RampOperationStore = {
      get: (id) => backing.get(id),
      transact: (id, update) => {
        count++;
        if (count === failure) return Promise.reject(new Error("internal"));
        return backing.transact(id, update);
      },
    };
    const { client, peer } = await setup(intent(), store);
    await expect(
      client.approve("op_test", "quote_test", accepted, ctx("0", "peer_test")),
    ).rejects.toThrow("internal");
    const saved = await client.get("op_test");
    expect(peer.calls.approve).toBe(failure === 2 ? 0 : 1);
    expect(saved.peer.state).toBe(failure === 2 ? "quoted" : "in_doubt");
    if (failure === 3) {
      const resumed = createRampClient({ peer, store: backing });
      const final = await resumed.recover(
        "op_test",
        "peer",
        "check_status",
        ctx(saved.revision, "resume_test"),
      );
      expect(final.peer.state).toBe("completed");
      expect(peer.calls.approve).toBe(1);
    }
  });

  it("resumes route execution with its own quote and replays its receipt after reload", async () => {
    const { client, peer, store } = await setup(intent("onramp", true));
    peer.script.push("completed", "action_required", "completed");
    const funded = await client.approve("op_test", "quote_test", accepted, ctx("0", "peer_test"));
    const approved = await client.recover(
      "op_test",
      "xochi",
      "approve_route",
      ctx(funded.revision, "route_approve_test"),
    );
    const resumed = createRampClient({ peer, xochi: peer.route(), store });
    const context = ctx(approved.revision, "route_execute_test");
    const final = await resumed.recover("op_test", "xochi", "execute_route", context);
    expect(final.xochi?.state).toBe("completed");
    expect(final.peer.state).toBe("completed");
    peer.routeQuoteId = "route_changed_test";
    const reloaded = createRampClient({ peer, xochi: peer.route(), store });
    expect(await reloaded.recover("op_test", "xochi", "execute_route", context)).toEqual(final);
  });

  it("keeps an aborted submitted interaction in doubt and ignores its late response", async () => {
    const { client, peer } = await setup();
    peer.script.push("action_required");
    const approved = await client.approve(
      "op_test",
      "quote_test",
      accepted,
      ctx("0", "approve_test"),
    );
    const abort = new AbortController();
    let finish!: (snapshot: RampSnapshot) => void;
    peer.script.push(() => {
      abort.abort();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = await client.interact(
      "op_test",
      { signal: abort.signal },
      ctx(approved.revision, "abort_test"),
    );
    expect(result.peer.state).toBe("in_doubt");
    expect(result.allowed_actions).toEqual(["check_status"]);
    finish(peer.snapshot("peer", "failed"));
    expect(await client.get("op_test")).toEqual(result);
    expect(peer.calls.interact).toBe(1);
  });

  it("does not unlock later legs when a prerequisite fails", async () => {
    const { client, peer } = await setup(intent("offramp", true));
    peer.script.push("failed");
    const failed = await client.recover(
      "op_test",
      "xochi",
      "approve_route",
      ctx("0", "route_test"),
    );
    expect(failed.peer.state).toBe("skipped");
    expect(failed.terminal).toBe(true);
    expect(failed.allowed_actions).toEqual([]);
    expect(peer.calls.approve).toBe(0);
  });

  it("rejects regressive status responses after submission", async () => {
    const { client, peer } = await setup();
    peer.script.push("processing", "action_required");
    const processing = await client.approve(
      "op_test",
      "quote_test",
      accepted,
      ctx("0", "approve_test"),
    );
    const result = await client.recover(
      "op_test",
      "peer",
      "check_status",
      ctx(processing.revision, "status_test"),
    );
    expect(result.peer.state).toBe("in_doubt");
    expect(result.allowed_actions).toEqual(["check_status"]);
  });

  it("rejects an already expired preview without persisting an operation", async () => {
    const peer = new FakeProvider();
    const store = createMemoryRampOperationStore();
    const client = createRampClient({ peer, store });
    peer.quoteExpiry = "2000-01-01T00:00:00Z";
    await expect(client.preview(intent(), "offer_test", "cap_test")).rejects.toThrow(
      "quote_changed",
    );
    expect(await store.get("op_test")).toBeUndefined();
    expect(peer.calls.approve).toBe(0);
  });

  it("persists only sanitized summaries and resumes from a new browser store", async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    // A deterministic lock service implementing the same exclusive callback protocol.
    let tail = Promise.resolve();
    const locks = {
      request: (_name: string, callback: () => unknown) => {
        const next = tail.then(callback);
        tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    } as unknown as Pick<LockManager, "request">;
    const store = createBrowserRampOperationStore({ storage, locks });
    const { client, peer } = await setup(intent(), store);
    peer.script.push("action_required");
    const first = await client.approve("op_test", "quote_test", accepted, ctx("0", "approve_test"));
    const raw = [...data.values()][0];
    expect(raw).not.toContain("quote_test");
    expect(raw).not.toContain("approve_test");
    expect(raw).not.toContain("recipient");
    expect(raw).not.toContain("request_digest");
    const resumed = createRampClient({
      peer,
      store: createBrowserRampOperationStore({ storage, locks }),
    });
    expect(await resumed.get("op_test")).toEqual(first);
    const final = await resumed.recover(
      "op_test",
      "peer",
      "check_status",
      ctx(first.revision, "resume_test"),
    );
    expect(final.peer.state).toBe("completed");
    expect(peer.calls.approve).toBe(1);
    expect(
      await resumed.approve("op_test", "quote_test", accepted, ctx("0", "approve_test")),
    ).toEqual(first);
  });
});
