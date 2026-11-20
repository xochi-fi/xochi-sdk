import { describe, expect, it } from "vitest";
import {
  atomic,
  createRampClient,
  createMemoryRampOperationStore,
  parseRamp,
  type RampCommandContext,
  type RampIntent,
  type RampSnapshot,
} from "@xochi/client";
import type { MakerMappingStorage, ProtectedMakerMapping } from "./protectedMapping.js";
import type { PreparedTransaction } from "@zkp2p/sdk";
import recorded from "./fixtures/usd-best-by-platform.json";
import { peerConfiguration } from "./discovery.js";
import {
  createPeerOfframpProvider,
  MakerSetupRequired,
  PeerMakerPrivateStore,
  type MakerDepositFacts,
  type MakerReadiness,
  type MakerReconciliation,
  type MakerWalletAction,
  type PeerMakerIO,
} from "./offramp.js";
class MemoryMappingStorage implements MakerMappingStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const config = peerConfiguration();
const wallet = "0x000000000000000000000000000000000000dEaD";
const hash = `0x${"1".repeat(64)}`;
const originalTime = Date.parse(recorded.responseObject.quoteExpiresAt) - 20_000;
const intent: RampIntent = {
  contract_version: "ramp/1",
  kind: "intent",
  direction: "offramp",
  fiat: { kind: "fiat", currency: "USD", decimals: 6 },
  crypto: config.settlement,
  exact: { side: "crypto", money: { asset: config.settlement, atomic: atomic("25000000") } },
  recipient: wallet,
};
const transaction = (): PreparedTransaction => ({
  chainId: 8453,
  to: config.escrow as `0x${string}`,
  data: "0x1234",
  value: 0n,
});
/** Deterministic chain/provider implementation. It holds synthetic private mappings, never real handles. */
class MemoryMaker implements PeerMakerIO {
  time = originalTime;
  ready: { -readonly [K in keyof MakerReadiness]: MakerReadiness[K] } = {
    oracleFresh: true,
    requiresIdentityAttestation: true,
    identityAttested: true,
    sellerSetup: "ready",
  };
  hasAllowance = false;
  registrationCount = 0;
  depositPlans = 0;
  withdrawalPlans: { amount: string; full: boolean }[] = [];
  refuseRegistration = false;
  outcome: MakerReconciliation = { state: "pending" };
  facts: { -readonly [K in keyof MakerDepositFacts]: MakerDepositFacts[K] } = {
    remaining: "25000000",
    unmatched: "25000000",
    filled: "0",
    withdrawn: "0",
    activeIntents: 0,
    closed: false,
  };
  async rebuild(mapping: ProtectedMakerMapping, pendingWithdrawalHash?: string) {
    if (
      !mapping.creationTxHash ||
      (mapping.depositId !== null &&
        BigInt(mapping.legRevision) % 2n === 1n &&
        !pendingWithdrawalHash)
    )
      return { state: "pending" as const };
    return { state: "confirmed" as const, depositId: "123", amount: "25000000" };
  }
  async readiness() {
    return { ...this.ready };
  }
  async registerOwnPayee() {
    this.registrationCount++;
    if (this.refuseRegistration) throw new MakerSetupRequired();
    return "synthetic_payee_hash";
  }
  async allowance() {
    return this.hasAllowance;
  }
  async prepareApproval() {
    return transaction();
  }
  async prepareDeposit() {
    this.depositPlans++;
    return transaction();
  }
  async reconcile(_hash: string, action: MakerWalletAction) {
    if (this.outcome.state === "confirmed" && action === "approve_usdc") this.hasAllowance = true;
    return this.outcome;
  }
  async deposit() {
    return { ...this.facts };
  }
  async prepareWithdrawal(_id: string, amount: string, full: boolean) {
    this.withdrawalPlans.push({ amount, full });
    return transaction();
  }
  evidence() {
    return {
      observed_at: new Date(this.time).toISOString(),
      valid_until: new Date(this.time + 20_000).toISOString(),
      rail: "wise",
      currency: "USD",
      chain_id: "eip155:8453",
      asset_id: config.settlement.asset_id,
      decimals: 6,
      rate: { numerator: "101", denominator: "100" },
      bounds: { minimum: "1000000", maximum: "100000000" },
      fees: [],
      credential: "verified",
      wallet,
    };
  }
}
function setup(io = new MemoryMaker(), store = new PeerMakerPrivateStore()) {
  const discovery = {
    user: wallet,
    now: () => io.time,
    reads: {
      bestByPlatform: async () => ({
        ...structuredClone(recorded),
        responseObject: {
          ...structuredClone(recorded.responseObject),
          quoteExpiresAt: new Date(io.time + 20_000).toISOString(),
        },
      }),
      quote: async () => structuredClone(recorded),
      makerEvidence: async () => io.evidence(),
    },
  };
  const provider = createPeerOfframpProvider({
    io,
    discovery,
    store,
    mintOperationId: () => "widget_operation",
  });
  return { io, provider, discovery, store };
}
const context = (s: RampSnapshot, key: string): RampCommandContext => ({
  expected_revision: s.revision,
  idempotency_key: key,
});
async function previewed(allowance = true) {
  const s = setup();
  s.io.hasAllowance = allowance;
  const offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
  const preview = await s.provider.preview(intent, offers.find((o) => o.rail.id === "wise")!);
  await s.provider.setOwnAccount(preview.operation_id, "[synthetic-own-account]", "own_account");
  let snapshot = await s.provider.approve(preview, {
    expected_revision: "0",
    idempotency_key: "approve",
  });
  return { ...s, preview, snapshot };
}
async function deposited() {
  const s = await previewed();
  s.snapshot = await s.provider.interact(s.preview.operation_id, context(s.snapshot, "prepare"));
  const plan = await s.provider.takeUnsignedPlan(s.preview.operation_id);
  expect(plan.action).toBe("create_deposit");
  await s.provider.recordSubmission(s.preview.operation_id, plan.action, hash);
  s.io.outcome = { state: "confirmed", depositId: "synthetic_deposit" };
  s.snapshot = await s.provider.status(s.preview.operation_id);
  return s;
}
describe("Peer maker unsigned lifecycle", () => {
  it("cancels maker readiness and never returns aborted offers", async () => {
    const s = setup();
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let readSignal: AbortSignal | undefined;
    s.io.readiness = async (_intent?: RampIntent, _rail?: string, signal?: AbortSignal) => {
      readSignal = signal;
      started();
      return new Promise<MakerReadiness>(() => {});
    };
    const pending = s.provider.capabilities(intent, controller.signal);
    await reading;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(readSignal?.aborted).toBe(true);
  });
  it("cancels approval reads without consuming the command receipt", async () => {
    const s = setup();
    const offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
    const preview = await s.provider.preview(
      intent,
      offers.find((offer) => offer.rail.id === "wise")!,
    );
    const original = s.io.readiness.bind(s.io);
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    s.io.readiness = async () => {
      started();
      return new Promise<MakerReadiness>(() => {});
    };
    const controller = new AbortController();
    const context = { expected_revision: "0", idempotency_key: "approve-cancelled" };
    const pending = s.provider.approve(preview, context, controller.signal);
    await reading;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    s.io.readiness = original;
    expect((await s.provider.approve(preview, context)).peer.state).toBe("action_required");
  });
  it("rejects pre-aborted preview and status without publishing state", async () => {
    const s = await deposited();
    const signal = AbortSignal.abort();
    await expect(s.provider.status(s.preview.operation_id, signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(s.provider.orderStatus(s.preview.operation_id, signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
    await expect(s.provider.preview(intent, offers[0], signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("cancels an in-flight order read without changing its revision", async () => {
    const s = await deposited();
    const before = await s.provider.status(s.preview.operation_id);
    const original = s.io.deposit.bind(s.io);
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (facts: MakerDepositFacts) => void;
    s.io.deposit = async () => {
      started();
      return new Promise<MakerDepositFacts>((resolve) => {
        finish = resolve;
      });
    };
    const pending = s.provider.orderStatus(s.preview.operation_id, controller.signal);
    await reading;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish({ ...s.io.facts, remaining: "0", unmatched: "0", filled: "25000000", closed: true });
    s.io.deposit = original;
    const after = await s.provider.status(s.preview.operation_id);
    expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 2n);
    expect(after.peer.state).toBe("processing");
  });
  it("omits totals while reconciliation is unknown or incoherent", async () => {
    const s = await deposited();
    s.io.facts.remaining = "1";
    const status = await s.provider.orderStatus(s.preview.operation_id);
    expect(status.snapshot.peer.state).toBe("in_doubt");
    expect(status.amounts).toBeUndefined();
  });

  it("prepares approval then deposit, leaving every wallet action explicit", async () => {
    const s = await previewed(false);
    s.snapshot = await s.provider.interact(
      s.preview.operation_id,
      context(s.snapshot, "allowance"),
    );
    const plan = await s.provider.takeUnsignedPlan(s.preview.operation_id);
    expect(plan.action).toBe("approve_usdc");
    expect(s.io.depositPlans).toBe(0);
    await expect(s.provider.takeUnsignedPlan(s.preview.operation_id)).rejects.toThrow(
      "invalid_request",
    );
    expect((await s.provider.status(s.preview.operation_id)).allowed_actions).toEqual([
      "check_status",
    ]);
    await s.provider.recordSubmission(s.preview.operation_id, plan.action, hash);
    s.io.outcome = { state: "confirmed" };
    s.snapshot = await s.provider.status(s.preview.operation_id);
    s.snapshot = await s.provider.interact(s.preview.operation_id, context(s.snapshot, "deposit"));
    expect((await s.provider.takeUnsignedPlan(s.preview.operation_id)).action).toBe(
      "create_deposit",
    );
    expect(s.io.registrationCount).toBe(1);
    expect(s.io.depositPlans).toBe(1);
  });
  it("returns identical command receipts and rejects conflicting/stale commands", async () => {
    const s = await previewed();
    const ctx = context(s.snapshot, "prepare");
    const first = await s.provider.interact(s.preview.operation_id, ctx);
    expect(await s.provider.interact(s.preview.operation_id, ctx)).toEqual(first);
    await expect(
      s.provider.interact(s.preview.operation_id, { ...ctx, idempotency_key: "stale" }),
    ).rejects.toThrow("session_conflict");
    expect(s.io.depositPlans).toBe(1);
  });
  it("keeps uncertainty pinned and never recreates a submitted deposit", async () => {
    const s = await deposited();
    const resumed = createPeerOfframpProvider({ io: s.io, discovery: s.discovery, store: s.store });
    expect((await resumed.orderStatus(s.preview.operation_id)).phase).toBe("awaiting_buyer");
    await resumed.interact(
      s.preview.operation_id,
      context(await resumed.status(s.preview.operation_id), "resume"),
    );
    expect(s.io.depositPlans).toBe(1);
    const serialized = JSON.stringify(await resumed.orderStatus(s.preview.operation_id));
    for (const forbidden of [
      "synthetic_deposit",
      "synthetic_payee_hash",
      "synthetic-own-account",
      "depositId",
      "payeeHash",
    ])
      expect(serialized).not.toContain(forbidden);
    expect(parseRamp(await resumed.status(s.preview.operation_id)).ok).toBe(true);
    expect(JSON.stringify(s.store)).toBe("{}");
  });
  it("rebuilds awaiting, matched, partial delivery and delivery from fresh facts", async () => {
    const s = await deposited();
    expect((await s.provider.orderStatus(s.preview.operation_id)).phase).toBe("awaiting_buyer");
    s.io.facts.activeIntents = 1;
    expect((await s.provider.orderStatus(s.preview.operation_id)).phase).toBe("matched");
    Object.assign(s.io.facts, { remaining: "15000000", unmatched: "10000000", filled: "10000000" });
    const partial = await s.provider.orderStatus(s.preview.operation_id);
    expect(partial.phase).toBe("delivering");
    expect(partial.amounts).toEqual({
      deposited: "25000000",
      filled: "10000000",
      reserved: "5000000",
      withdrawable: "10000000",
      withdrawn: "0",
    });
    expect(partial.snapshot.terminal).toBe(false);
    Object.assign(s.io.facts, {
      remaining: "0",
      unmatched: "0",
      filled: "25000000",
      activeIntents: 0,
      closed: true,
    });
    const delivered = await s.provider.orderStatus(s.preview.operation_id);
    expect(delivered.phase).toBe("delivered");
    expect(delivered.amounts).toEqual({
      deposited: "25000000",
      filled: "25000000",
      reserved: "0",
      withdrawable: "0",
      withdrawn: "0",
    });
    expect(delivered.snapshot.peer.state).toBe("completed");
  });
  it("allows partial unmatched withdrawal while a buyer blocks full withdrawal", async () => {
    const s = await deposited();
    Object.assign(s.io.facts, { unmatched: "15000000", activeIntents: 1 });
    s.snapshot = await s.provider.prepareWithdrawal(
      s.preview.operation_id,
      "25000000",
      context(s.snapshot, "full"),
    );
    expect(s.io.withdrawalPlans).toHaveLength(0);
    s.snapshot = await s.provider.prepareWithdrawal(
      s.preview.operation_id,
      "15000000",
      context(s.snapshot, "partial"),
    );
    expect(s.io.withdrawalPlans).toEqual([{ amount: "15000000", full: false }]);
    expect((await s.provider.takeUnsignedPlan(s.preview.operation_id)).action).toBe(
      "withdraw_unmatched",
    );
    await s.provider.recordSubmission(
      s.preview.operation_id,
      "withdraw_unmatched",
      `0x${"2".repeat(64)}`,
    );
    Object.assign(s.io.facts, { remaining: "10000000", unmatched: "0", withdrawn: "15000000" });
    expect((await s.provider.orderStatus(s.preview.operation_id)).snapshot.terminal).toBe(false);
  });
  it("preserves a terminal mixed fill and return without calling it refunded", async () => {
    const s = await deposited();
    Object.assign(s.io.facts, {
      remaining: "10000000",
      unmatched: "10000000",
      filled: "15000000",
    });
    await s.provider.orderStatus(s.preview.operation_id);
    s.snapshot = await s.provider.prepareWithdrawal(
      s.preview.operation_id,
      "10000000",
      context(s.snapshot, "mixed-withdraw"),
    );
    await s.provider.takeUnsignedPlan(s.preview.operation_id);
    await s.provider.recordSubmission(
      s.preview.operation_id,
      "withdraw_unmatched",
      `0x${"2".repeat(64)}`,
    );
    Object.assign(s.io.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "10000000",
      closed: true,
    });
    const result = await s.provider.orderStatus(s.preview.operation_id);
    expect(result.snapshot.peer.state).toBe("completed");
    expect(result.snapshot.terminal).toBe(true);
    expect(result.snapshot.allowed_actions).toEqual([]);
    expect(result.snapshot.peer).toMatchObject({
      partial_result: { filled_atomic: "15000000", returned_atomic: "10000000" },
    });
    expect(parseRamp(result.snapshot).ok).toBe(true);
  });
  it("rebuilds returned state after full withdrawal", async () => {
    const s = await deposited();
    s.snapshot = await s.provider.prepareWithdrawal(
      s.preview.operation_id,
      "25000000",
      context(s.snapshot, "withdraw"),
    );
    await s.provider.takeUnsignedPlan(s.preview.operation_id);
    await s.provider.recordSubmission(
      s.preview.operation_id,
      "withdraw_unmatched",
      `0x${"2".repeat(64)}`,
    );
    Object.assign(s.io.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "25000000",
      closed: true,
    });
    const returned = await s.provider.orderStatus(s.preview.operation_id);
    expect(returned.phase).toBe("returned");
    expect(returned.amounts).toEqual({
      deposited: "25000000",
      filled: "0",
      reserved: "0",
      withdrawable: "0",
      withdrawn: "25000000",
    });
    expect(returned.snapshot.peer.state).toBe("refunded");
  });
  it("expires estimates before preparation and before single-use handoff", async () => {
    const s = await previewed();
    s.io.time += 20_000;
    const expired = await s.provider.interact(
      s.preview.operation_id,
      context(s.snapshot, "expired"),
    );
    expect(expired.peer.failure_code).toBe("quote_expired");
    expect(s.io.depositPlans).toBe(0);
    const t = await previewed();
    await t.provider.interact(t.preview.operation_id, context(t.snapshot, "prepare"));
    t.io.time += 20_000;
    await expect(t.provider.takeUnsignedPlan(t.preview.operation_id)).rejects.toThrow(
      "quote_expired",
    );
  });
  it("accepts a new observation of unchanged economics without perpetual requoting", async () => {
    const s = await previewed();
    s.io.time += 1000;
    expect(
      (await s.provider.interact(s.preview.operation_id, context(s.snapshot, "fresh"))).peer.state,
    ).toBe("action_required");
  });
  it("maps identity and seller setup to non-executable capabilities", async () => {
    const s = setup();
    s.io.ready.identityAttested = false;
    let offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
    expect(offers.find((o) => o.rail.id === "wise")!.availability.state).toBe("setup_required");
    s.io.ready.identityAttested = true;
    s.io.ready.oracleFresh = false;
    offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
    expect(offers.find((o) => o.rail.id === "wise")!.availability).toEqual({
      state: "temporarily_unavailable",
      reason_code: "oracle_paused",
    });
  });
  it("remembers an authoritative Autopilot refusal without exposing its response", async () => {
    const s = await previewed();
    s.io.refuseRegistration = true;
    const result = await s.provider.interact(
      s.preview.operation_id,
      context(s.snapshot, "refusal"),
    );
    expect(result.peer.failure_code).toBe("capability_unavailable");
    const offers = s.provider.normalizeCapabilities(await s.provider.capabilities(intent), intent);
    expect(offers.find((o) => o.rail.id === "wise")!.availability.state).toBe("setup_required");
  });
  it("keeps a missing receipt and incoherent deposit facts in doubt", async () => {
    const s = await deposited();
    s.io.facts.unmatched = "99999999";
    const result = await s.provider.status(s.preview.operation_id);
    expect(result.peer.state).toBe("in_doubt");
    expect(result.allowed_actions).toEqual(["check_status"]);
  });
  it("runs separate wallet approvals through the S4 command client", async () => {
    const s = setup();
    s.io.time = Date.now();
    const client = createRampClient({ peer: s.provider, store: createMemoryRampOperationStore() });
    const offers = await client.discover(intent);
    const offer = offers.find((o) => o.rail.id === "wise")!;
    const preview = await client.preview(intent, offer.offer_id, offer.capability_revision);
    const id = preview.operation_id;
    await s.provider.setOwnAccount(id, "[synthetic-own-account]", "own_account");
    const disclosures = [
      ...preview.disclosures.public_state,
      ...preview.disclosures.identity_visible_to,
      ...preview.disclosures.liveness_dependencies,
    ];
    let snapshot = await client.approve(id, preview.quote_id, disclosures, {
      expected_revision: "0",
      idempotency_key: "approve",
    });
    expect(snapshot.peer.state).toBe("action_required");
    snapshot = await client.interact(id, {}, context(snapshot, "prepare_approval"));
    expect(snapshot.peer.state).toBe("action_required");
    const plan = await s.provider.takeUnsignedPlan(id);
    expect(plan.action).toBe("approve_usdc");
    snapshot = await client.recover(id, "peer", "check_status", context(snapshot, "uncertain"));
    expect(snapshot.peer.state).toBe("in_doubt");
    await s.provider.recordSubmission(id, plan.action, hash);
    s.io.outcome = { state: "confirmed" };
    snapshot = await client.recover(
      id,
      "peer",
      "check_status",
      context(snapshot, "confirmed_approval"),
    );
    expect(snapshot.peer.state).toBe("action_required");
    snapshot = await client.interact(id, {}, context(snapshot, "prepare_deposit"));
    expect(snapshot.peer.state).toBe("action_required");
    expect((await s.provider.takeUnsignedPlan(id)).action).toBe("create_deposit");
    await s.provider.recordSubmission(id, "create_deposit", `0x${"2".repeat(64)}`);
    s.io.outcome = { state: "confirmed", depositId: "synthetic_deposit" };
    snapshot = await client.recover(
      id,
      "peer",
      "check_status",
      context(snapshot, "confirmed_deposit"),
    );
    expect(snapshot.peer.state).toBe("processing");
    expect(s.io.depositPlans).toBe(1);
  });
  it("persists only approved private mapping fields and rebuilds after a new runtime", async () => {
    const s = await previewed();
    const storage = new MemoryMappingStorage();
    const provider = createPeerOfframpProvider({
      io: s.io,
      discovery: s.discovery,
      store: s.store,
      storage,
    });
    s.snapshot = await provider.interact(
      s.preview.operation_id,
      context(s.snapshot, "prepare_durable"),
    );
    await provider.takeUnsignedPlan(s.preview.operation_id);
    let saved = [...storage.values.values()][0]!;
    expect(JSON.parse(saved)[0]).toEqual({
      operationRef: s.preview.operation_id,
      escrowAddress: config.escrow,
      depositId: null,
      creationTxHash: null,
      legRevision: expect.any(String),
    });
    const pending = createPeerOfframpProvider({ io: s.io, discovery: s.discovery, storage });
    expect((await pending.status(s.preview.operation_id)).peer.state).toBe("in_doubt");
    await pending.recordSubmission(s.preview.operation_id, "create_deposit", hash);
    s.io.outcome = { state: "confirmed", depositId: "123" };
    const rebuilt = await pending.orderStatus(s.preview.operation_id);
    expect(rebuilt.phase).toBe("awaiting_buyer");
    expect(s.io.depositPlans).toBe(1);
    saved = [...storage.values.values()][0]!;
    expect(Object.keys(JSON.parse(saved)[0]).sort()).toEqual([
      "creationTxHash",
      "depositId",
      "escrowAddress",
      "legRevision",
      "operationRef",
    ]);
    for (const value of [
      "synthetic-own-account",
      "payeeHash",
      "intent",
      "preview",
      "signature",
      "credential",
      "synthetic_payee_hash",
    ])
      expect(saved).not.toContain(value);
    const foreign = createPeerOfframpProvider({
      io: s.io,
      discovery: { ...s.discovery, user: "0x0000000000000000000000000000000000000001" },
      storage,
    });
    await expect(foreign.status(s.preview.operation_id)).rejects.toThrow("peer_in_doubt");
    const withdrawn = await pending.prepareWithdrawal(
      s.preview.operation_id,
      "25000000",
      context(rebuilt.snapshot, "durable_withdraw"),
    );
    expect(withdrawn.peer.state).toBe("action_required");
    await pending.takeUnsignedPlan(s.preview.operation_id);
    const reloaded = createPeerOfframpProvider({ io: s.io, discovery: s.discovery, storage });
    expect((await reloaded.status(s.preview.operation_id)).peer.state).toBe("in_doubt");
    await expect(
      reloaded.prepareWithdrawal(
        s.preview.operation_id,
        "25000000",
        context(withdrawn, "duplicate"),
      ),
    ).rejects.toThrow("invalid_request");
    await reloaded.recordSubmission(
      s.preview.operation_id,
      "withdraw_unmatched",
      `0x${"2".repeat(64)}`,
    );
    Object.assign(s.io.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "25000000",
      closed: true,
    });
    expect((await reloaded.orderStatus(s.preview.operation_id)).phase).toBe("returned");
    expect(storage.values.size).toBe(0);
  });
  it("fails closed for corrupted or unavailable protected storage", async () => {
    const s = await previewed();
    const storage = new MemoryMappingStorage();
    const provider = createPeerOfframpProvider({
      io: s.io,
      discovery: s.discovery,
      store: s.store,
      storage,
    });
    await provider.interact(s.preview.operation_id, context(s.snapshot, "storage_prepare"));
    await provider.takeUnsignedPlan(s.preview.operation_id);
    const key = [...storage.values.keys()][0]!;
    storage.values.set(key, "[synthetic-corrupted-record]");
    const restored = createPeerOfframpProvider({ io: s.io, discovery: s.discovery, storage });
    await expect(restored.status(s.preview.operation_id)).rejects.toThrow("peer_in_doubt");
    const unavailable: MakerMappingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("[synthetic-storage-error]");
      },
      removeItem: () => {},
    };
    const t = await previewed();
    const blocked = createPeerOfframpProvider({
      io: t.io,
      discovery: t.discovery,
      store: t.store,
      storage: unavailable,
    });
    await blocked.interact(t.preview.operation_id, context(t.snapshot, "unavailable_prepare"));
    await expect(blocked.takeUnsignedPlan(t.preview.operation_id)).rejects.toThrow("peer_in_doubt");
  });
});
