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
});
