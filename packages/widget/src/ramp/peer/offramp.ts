import {
  atomic,
  parseRamp,
  type RampAction,
  type RampErrorCode,
  type RampCommandContext,
  type RampIntent,
  type RampOffer,
  type RampPreview,
  type RampProvider,
  type RampSnapshot,
} from "@xochi/client";
import type { PreparedTransaction } from "@zkp2p/sdk";
import { fetchPeerCapabilities } from "./discovery.js";
import { previewPeerOffer } from "./preview.js";
import type { PeerDiscoveryOptions, PeerDiscoveryResult } from "./types.js";

export type MakerPhase = "awaiting_buyer" | "matched" | "delivering" | "delivered" | "returned";
export type MakerReason =
  | "setup_required"
  | "active_intent_blocks_withdrawal"
  | "quote_expired"
  | "quote_changed";
export type MakerWalletAction = "approve_usdc" | "create_deposit" | "withdraw_unmatched";
/** Wallet-only material, never an event, snapshot, bridge payload or persistence record. */
export interface MakerUnsignedPlan {
  readonly action: MakerWalletAction;
  readonly transaction: PreparedTransaction;
  readonly expiresAt: string;
}
export interface MakerReadiness {
  readonly oracleFresh: boolean;
  readonly requiresIdentityAttestation: boolean;
  readonly identityAttested: boolean;
  /** A refusal is authoritative; unknown never implies Autopilot is unnecessary. */
  readonly sellerSetup: "ready" | "required" | "unknown";
}
/** Fresh, coherent protocol/indexer facts. Amounts include reserved fees in unavailable funds. */
export interface MakerDepositFacts {
  readonly remaining: string;
  readonly unmatched: string;
  /** Gross USDC debited by verified fills, including protocol fees; never pending fiat. */
  readonly filled: string;
  readonly withdrawn: string;
  readonly activeIntents: number;
  readonly closed: boolean;
}
export type MakerReconciliation =
  | { readonly state: "pending" }
  | { readonly state: "reverted" }
  | { readonly state: "confirmed"; readonly depositId?: string };
/** Trusted I/O only. Implementations must not log raw errors, registration data or identifiers. */
export interface PeerMakerIO {
  readiness(intent: RampIntent, rail: string): Promise<MakerReadiness>;
  /** POST /v2/makers/create, via SDK registerPayeeDetails. Own account only. */
  registerOwnPayee(rail: string, ownAccount: string): Promise<string>;
  allowance(owner: string, amount: string): Promise<boolean>;
  prepareApproval(amount: string): Promise<PreparedTransaction>;
  prepareDeposit(input: {
    intent: RampIntent;
    rail: string;
    amount: string;
    payeeHash: string;
  }): Promise<PreparedTransaction>;
  /** Confirm the receipt AND exact sender, chain, target, calldata and value against expected.
   * For creation, return only the deposit ID decoded from that successful escrow receipt.
   * Missing/unknown receipts remain pending; never infer absence or resubmit. */
  reconcile(
    hash: string,
    action: MakerWalletAction,
    owner: string,
    expected: PreparedTransaction,
  ): Promise<MakerReconciliation>;
  /** Validate deposit owner, Base USDC identity, confirmation/finality and indexer/chain
   * coherence; derive totals from deposit, active intents and verified fills/withdrawals.
   * Never label signalled or payment-pending intents as filled. Throw on missing/stale data. */
  deposit(depositId: string, owner: string): Promise<MakerDepositFacts>;
  prepareWithdrawal(depositId: string, amount: string, full: boolean): Promise<PreparedTransaction>;
}
/** Safe bounded failures; never use Error.message from a provider response. */
export class MakerSetupRequired extends Error {
  constructor() {
    super("setup_required");
  }
}
export class MakerWithdrawalBlocked extends Error {
  constructor() {
    super("active_intent_blocks_withdrawal");
  }
}
interface Entry {
  intent: RampIntent;
  offer: RampOffer;
  preview: RampPreview;
  snapshot: RampSnapshot;
  ownAccount?: string;
  payeeHash?: string;
  depositId?: string;
  plan?: MakerUnsignedPlan;
  claimed?: MakerWalletAction;
  hash?: string;
  approved: boolean;
  phase?: MakerPhase;
  withdrawalAmount?: string;
  reason?: MakerReason;
  transactionHashes: Set<string>;
  commandRevision: bigint;
  receipts: Map<string, { fingerprint: string; snapshot: RampSnapshot }>;
}
/** Retain this object inside the trusted runtime to resume; never serialize it to browser storage. */
const privateStores = new WeakMap<
  PeerMakerPrivateStore,
  { entries: Map<string, Entry>; tail: Promise<unknown> }
>();
export class PeerMakerPrivateStore {
  constructor() {
    privateStores.set(this, { entries: new Map(), tail: Promise.resolve() });
  }
}
function access<T>(
  store: PeerMakerPrivateStore,
  run: (entries: Map<string, Entry>) => Promise<T>,
): Promise<T> {
  const data = privateStores.get(store)!;
  const pending = data.tail.then(() => run(data.entries));
  data.tail = pending.catch(() => undefined);
  return pending;
}
const copy = <T>(value: T): T => structuredClone(value);
class LocalFailure extends Error {
  constructor(readonly code: RampErrorCode) {
    super(code);
  }
}
function fail(code: RampErrorCode | "setup_required" | "oracle_paused" = "invalid_request"): never {
  if (code === "setup_required") throw new MakerSetupRequired();
  throw new LocalFailure(code === "oracle_paused" ? "capability_unavailable" : code);
}
function factsValid(facts: MakerDepositFacts, total: string): boolean {
  try {
    const remaining = BigInt(atomic(facts.remaining));
    const unmatched = BigInt(atomic(facts.unmatched));
    const filled = BigInt(atomic(facts.filled));
    const withdrawn = BigInt(atomic(facts.withdrawn));
    return (
      remaining >= unmatched &&
      remaining + filled + withdrawn === BigInt(total) &&
      Number.isSafeInteger(facts.activeIntents) &&
      facts.activeIntents >= 0 &&
      (!facts.closed || remaining === 0n)
    );
  } catch {
    return false;
  }
}
function readinessCode(
  value: MakerReadiness,
): "oracle_paused" | "setup_required" | "capability_unavailable" | undefined {
  if (value.oracleFresh !== true) return "oracle_paused";
  if (
    (value.requiresIdentityAttestation && value.identityAttested !== true) ||
    value.sellerSetup === "required"
  )
    return "setup_required";
  if (value.sellerSetup !== "ready") return "capability_unavailable";
}
export interface PeerOfframpProvider extends RampProvider {
  /** Trusted local UI input. This confirms the handle belongs to the connected user. */
  setOwnAccount(operationId: string, account: string, ownership: "own_account"): Promise<void>;
  /** Single-use handoff to the caller's wallet. Claiming creates uncertainty until reconciled. */
  takeUnsignedPlan(operationId: string): Promise<MakerUnsignedPlan>;
  recordSubmission(
    operationId: string,
    action: MakerWalletAction,
    transactionHash: string,
  ): Promise<void>;
  /** Use only when the wallet confirms that no transaction was broadcast. */
  recordWalletRejection(operationId: string): Promise<void>;
  prepareWithdrawal(
    operationId: string,
    amount: string,
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
  orderStatus(
    operationId: string,
  ): Promise<{ snapshot: RampSnapshot; phase?: MakerPhase; reason?: MakerReason }>;
}
export function createPeerOfframpProvider(options: {
  io: PeerMakerIO;
  discovery: PeerDiscoveryOptions;
  store?: PeerMakerPrivateStore;
  mintOperationId?: () => string;
}): PeerOfframpProvider {
  const store = options.store ?? new PeerMakerPrivateStore();
  const now = options.discovery.now ?? Date.now;
  const io = options.io;
  const refusedRails = new Set<string>();
  async function readReady(intent: RampIntent, rail: string): Promise<MakerReadiness> {
    try {
      const result = await io.readiness(intent, rail);
      return {
        ...result,
        requiresIdentityAttestation:
          result.requiresIdentityAttestation || ["wise", "paypal", "alipay"].includes(rail),
      };
    } catch {
      fail("capability_unavailable");
    }
  }

  const entry = (entries: Map<string, Entry>, id: string): Entry => entries.get(id) ?? fail();
  function update(
    e: Entry,
    state: RampSnapshot["peer"]["state"],
    actions: RampAction[],
    failure?: RampSnapshot["peer"]["failure_code"],
  ): RampSnapshot {
    e.snapshot = {
      ...e.snapshot,
      revision: (BigInt(e.snapshot.revision) + 1n).toString(),
      peer: {
        name: "peer",
        state,
        recoverable: !["completed", "refunded"].includes(state),
        ...(failure ? { failure_code: failure } : {}),
      },
      allowed_actions: actions,
      updated_at: new Date(now()).toISOString(),
      terminal: ["completed", "refunded"].includes(state),
    };
    return copy(e.snapshot);
  }
  async function fresh(e: Entry) {
    if (Date.parse(e.preview.expires_at) <= now()) fail("quote_expired");
    const ready = await readReady(e.intent, e.offer.rail.id);
    const code = refusedRails.has(e.offer.rail.id) ? "setup_required" : readinessCode(ready);
    if (code) fail(code);
    // Re-read authoritative maker bounds/rate/fees, and require another review if changed.
    const preview = await previewPeerOffer(
      e.offer,
      e.intent,
      e.preview.operation_id,
      options.discovery,
    );
    if (!preview.ok) fail(preview.code);
  }
  function validatePlan(
    transaction: PreparedTransaction,
    action: MakerWalletAction,
    expiresAt: string,
  ): MakerUnsignedPlan {
    if (
      transaction.chainId !== 8453 ||
      transaction.value !== 0n ||
      !/^0x[0-9a-fA-F]{40}$/.test(transaction.to) ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.data)
    )
      fail("provider_declined");
    return { action, transaction: copy(transaction), expiresAt };
  }
  async function refresh(e: Entry): Promise<RampSnapshot> {
    if (e.snapshot.terminal) return copy(e.snapshot);
    if (e.claimed) {
      if (!e.hash) return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
      const result = await io.reconcile(e.hash, e.claimed, e.intent.recipient, e.plan!.transaction);
      if (result.state === "pending")
        return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
      const action = e.claimed;
      if (result.state === "confirmed" && action === "create_deposit") {
        if (!result.depositId) return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
        e.depositId = result.depositId;
        // The actual payment handle is no longer needed after successful registration/deposit.
        delete e.ownAccount;
        delete e.payeeHash;
      }
      delete e.claimed;
      delete e.hash;
      delete e.plan;
      if (result.state === "reverted")
        return update(e, "failed", ["check_status", "recover_peer"], "provider_declined");
      if (action === "approve_usdc")
        return update(e, "action_required", ["interact", "check_status"]);
    }
    if (!e.depositId) return copy(e.snapshot);
    const facts = await io.deposit(e.depositId, e.intent.recipient);
    if (!factsValid(facts, e.preview.pay.atomic)) fail("provider_declined");
    const filled = BigInt(facts.filled),
      withdrawn = BigInt(facts.withdrawn),
      remaining = BigInt(facts.remaining);
    e.phase =
      remaining === 0n && facts.activeIntents === 0
        ? withdrawn > 0n
          ? "returned"
          : filled > 0n
            ? "delivered"
            : undefined
        : filled > 0n
          ? "delivering"
          : facts.activeIntents > 0
            ? "matched"
            : "awaiting_buyer";
    if (!e.phase) return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
    if (e.phase === "delivered") return update(e, "completed", []);
    if (e.phase === "returned") return update(e, "refunded", []);
    return update(e, "processing", [
      "check_status",
      ...(BigInt(facts.unmatched) > 0n ? ["interact" as const] : []),
    ]);
  }
  async function command(
    id: string,
    name: string,
    context: RampCommandContext,
    run: (e: Entry) => Promise<RampSnapshot>,
  ) {
    return access(store, async (entries) => {
      const e = entry(entries, id);
      const fingerprint = JSON.stringify([name, context]);
      const receipt = e.receipts.get(context.idempotency_key);
      if (receipt)
        return receipt.fingerprint === fingerprint
          ? copy(receipt.snapshot)
          : fail("session_conflict");
      if (e.snapshot.terminal) fail("invalid_request");
      if (
        !context.idempotency_key ||
        !/^(0|[1-9][0-9]*)$/.test(context.expected_revision) ||
        // S4 owns public revisions and increments around its reservations. Provider-local
        // observations/wallet handoffs have their own revisions, so compare command order
        // rather than equating those independent counters.
        BigInt(context.expected_revision) < e.commandRevision ||
        e.claimed
      )
        fail("session_conflict");
      e.commandRevision = BigInt(context.expected_revision) + 1n;
      let snapshot: RampSnapshot;
      try {
        snapshot = await run(e);
      } catch (error) {
        if (error instanceof MakerSetupRequired) {
          refusedRails.add(e.offer.rail.id);
          e.reason = "setup_required";
        } else if (error instanceof MakerWithdrawalBlocked)
          e.reason = "active_intent_blocks_withdrawal";
        else if (
          error instanceof LocalFailure &&
          (error.code === "quote_expired" || error.code === "quote_changed")
        )
          e.reason = error.code;
        // Registration may have succeeded; it cannot submit a transaction. Never pass its error through.
        snapshot = update(
          e,
          "failed",
          ["requote", "check_status"],
          error instanceof MakerSetupRequired
            ? "capability_unavailable"
            : error instanceof LocalFailure
              ? error.code
              : "provider_declined",
        );
      }
      e.receipts.set(context.idempotency_key, { fingerprint, snapshot: copy(snapshot) });
      return snapshot;
    });
  }
  const provider: PeerOfframpProvider = {
    id: "peer",
    async capabilities(intent) {
      if (intent.direction !== "offramp") return { offers: [] };
      const result = await fetchPeerCapabilities(intent, options.discovery);
      for (const offer of result.offers) {
        try {
          const code = refusedRails.has(offer.rail.id)
            ? "setup_required"
            : readinessCode(await readReady(intent, offer.rail.id));
          if (code)
            offer.availability =
              code === "setup_required"
                ? { state: "setup_required", requirement_codes: ["maker_account_setup"] }
                : { state: "temporarily_unavailable", reason_code: code };
        } catch {
          offer.availability = {
            state: "availability_unknown",
            reason_code: "capability_unavailable",
          };
        }
      }
      const available = result.offers.filter((o) => o.availability.state === "available");
      result.availability = available.length
        ? {
            state: "available",
            valid_until: new Date(
              Math.min(
                ...available.map((o) =>
                  o.availability.state === "available"
                    ? Date.parse(o.availability.valid_until)
                    : Infinity,
                ),
              ),
            ).toISOString(),
          }
        : result.offers.length &&
            result.offers.every((o) => o.availability.state === "setup_required")
          ? { state: "setup_required", requirement_codes: ["maker_account_setup"] }
          : { state: "availability_unknown", reason_code: "capability_unavailable" };
      return result;
    },
    normalizeCapabilities(raw) {
      if (!raw || typeof raw !== "object" || !("offers" in raw) || !Array.isArray(raw.offers))
        return [];
      return raw.offers.flatMap((value) => {
        const parsed = parseRamp(value);
        return parsed.ok && parsed.value.kind === "offer" && parsed.value.direction === "offramp"
          ? [parsed.value]
          : [];
      });
    },
    async preview(intent, offer) {
      if (
        intent.direction !== "offramp" ||
        options.discovery.user?.toLowerCase() !== intent.recipient.toLowerCase()
      )
        fail();
      const id = (options.mintOperationId ?? (() => crypto.randomUUID()))();
      const result = await previewPeerOffer(offer, intent, id, options.discovery);
      if (!result.ok) fail(result.code);
      const code = refusedRails.has(offer.rail.id)
        ? "setup_required"
        : readinessCode(await readReady(intent, offer.rail.id));
      if (code) fail(code);
      return access(store, async (entries) => {
        if (entries.has(id)) fail("session_conflict");
        const preview = result.preview;
        const snapshot: RampSnapshot = {
          contract_version: "ramp/1",
          kind: "snapshot",
          operation_id: id,
          revision: "0",
          direction: "offramp",
          leg_order: ["peer"],
          peer: { name: "peer", state: "quoted", recoverable: true },
          allowed_actions: ["approve", "requote"],
          updated_at: new Date(now()).toISOString(),
          terminal: false,
        };
        entries.set(id, {
          intent: copy(intent),
          offer: copy(offer),
          preview: copy(preview),
          snapshot,
          approved: false,
          transactionHashes: new Set(),
          commandRevision: 0n,
          receipts: new Map(),
        });
        return copy(preview);
      });
    },
    approve(preview, context) {
      return command(
        preview.operation_id,
        `approve:${JSON.stringify(preview)}`,
        context,
        async (e) => {
          if (JSON.stringify(e.preview) !== JSON.stringify(preview) || e.depositId || e.approved)
            fail("quote_changed");
          await fresh(e);
          e.approved = true;
          return update(e, "action_required", ["interact", "check_status"]);
        },
      );
    },
    interact(id, context) {
      return command(id, "interact", context, async (e) => {
        if (e.depositId) return refresh(e); // Withdrawal requires a separately named amount/review.
        if (e.plan) return copy(e.snapshot);
        if (!e.approved) fail();
        await fresh(e);
        if (!e.ownAccount) fail("setup_required");
        if (!(await io.allowance(e.intent.recipient, e.preview.pay.atomic))) {
          e.plan = validatePlan(
            await io.prepareApproval(e.preview.pay.atomic),
            "approve_usdc",
            e.preview.expires_at,
          );
        } else {
          if (!e.ownAccount) fail("setup_required");
          e.payeeHash ??= await io.registerOwnPayee(e.offer.rail.id, e.ownAccount);
          e.plan = validatePlan(
            await io.prepareDeposit({
              intent: e.intent,
              rail: e.offer.rail.id,
              amount: e.preview.pay.atomic,
              payeeHash: e.payeeHash,
            }),
            "create_deposit",
            e.preview.expires_at,
          );
        }
        return update(e, "action_required", ["check_status"]);
      });
    },
    async status(id) {
      return access(store, async (entries) => {
        const e = entry(entries, id);
        try {
          return await refresh(e);
        } catch {
          return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
        }
      });
    },
    async recover(id, action, context) {
      if (action === "check_status") return provider.status(id);
      if (action !== "recover_peer" && action !== "requote") fail();
      return command(id, action, context, async (e) => {
        if (e.depositId) return refresh(e);
        // A new quote/approval is required after a reverted transaction or stale estimate.
        delete e.plan;
        e.approved = false;
        return update(e, "quoted", ["requote"]);
      });
    },
    async setOwnAccount(id, account, ownership) {
      await access(store, async (entries) => {
        const e = entry(entries, id);
        if (
          ownership !== "own_account" ||
          !account ||
          account.length > 256 ||
          e.depositId ||
          e.claimed ||
          e.payeeHash
        )
          fail();
        e.ownAccount = account;
      });
    },
    async takeUnsignedPlan(id) {
      return access(store, async (entries) => {
        const e = entry(entries, id);
        if (!e.plan || e.claimed) fail();
        if (Date.parse(e.plan.expiresAt) <= now()) {
          delete e.plan;
          fail("quote_expired");
        }
        if (e.plan.action !== "withdraw_unmatched") await fresh(e);
        else {
          if (!e.depositId || !e.withdrawalAmount) fail();
          let facts: MakerDepositFacts;
          try {
            facts = await io.deposit(e.depositId, e.intent.recipient);
          } catch {
            fail("peer_in_doubt");
          }
          if (
            !factsValid(facts, e.preview.pay.atomic) ||
            BigInt(e.withdrawalAmount) > BigInt(facts.unmatched) ||
            (BigInt(e.withdrawalAmount) === BigInt(facts.remaining) && facts.activeIntents > 0)
          )
            throw new MakerWithdrawalBlocked();
        }
        e.claimed = e.plan.action;
        update(e, "in_doubt", ["check_status"], "peer_in_doubt");
        return copy(e.plan);
      });
    },
    async recordSubmission(id, action, hash) {
      await access(store, async (entries) => {
        const e = entry(entries, id);
        if (e.claimed !== action || e.hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) fail();
        if ([...entries.values()].some((other) => other.transactionHashes.has(hash.toLowerCase())))
          fail("session_conflict");
        e.transactionHashes.add(hash.toLowerCase());
        e.hash = hash;
      });
    },
    async recordWalletRejection(id) {
      await access(store, async (entries) => {
        const e = entry(entries, id);
        if (!e.claimed || e.hash) fail();
        delete e.claimed;
        delete e.plan;
        update(
          e,
          e.depositId ? "processing" : "action_required",
          ["interact", "check_status"],
          "approval_rejected",
        );
      });
    },
    prepareWithdrawal(id, amount, context) {
      return command(id, `withdraw:${amount}`, context, async (e) => {
        if (!e.depositId || e.plan) fail();
        const requested = BigInt(atomic(amount));
        const facts = await io.deposit(e.depositId, e.intent.recipient);
        if (
          !factsValid(facts, e.preview.pay.atomic) ||
          requested <= 0n ||
          requested > BigInt(facts.unmatched)
        )
          fail();
        const full = requested === BigInt(facts.remaining);
        if (full && facts.activeIntents > 0) throw new MakerWithdrawalBlocked();
        e.withdrawalAmount = amount;
        e.plan = validatePlan(
          await io.prepareWithdrawal(e.depositId, amount, full),
          "withdraw_unmatched",
          new Date(now() + 30_000).toISOString(),
        );
        return update(e, "action_required", ["check_status"]);
      });
    },
    async orderStatus(id) {
      const snapshot = await provider.status(id);
      return access(store, async (entries) => ({
        snapshot,
        ...(snapshot.peer.state !== "in_doubt" && entry(entries, id).phase
          ? { phase: entry(entries, id).phase }
          : {}),
        ...(entry(entries, id).reason ? { reason: entry(entries, id).reason } : {}),
      }));
    },
  };
  return provider;
}
export type { PeerDiscoveryResult };
