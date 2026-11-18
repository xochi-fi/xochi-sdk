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
import { peerConfiguration } from "./discovery.js";
import { makeOffer } from "./normalization.js";
import {
  browserMakerStorage,
  ProtectedMakerMappings,
  type MakerMappingStorage,
  type ProtectedMakerMapping,
} from "./protectedMapping.js";
import { boundedPeerRead, checkPeerAbort, fetchPeerCapabilities } from "./discovery.js";
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
  /** The connected wallet must match this public sender before signing. */
  readonly account: string;
  readonly expiresAt: string;
}
/** Public Base USDC atomic totals; filled includes fees debited by verified fills. */
export interface MakerOrderAmounts {
  readonly deposited: string;
  readonly filled: string;
  /** Active reservations, including reserved fees unavailable for withdrawal. */
  readonly reserved: string;
  readonly withdrawable: string;
  readonly withdrawn: string;
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
  rebuild?(
    mapping: ProtectedMakerMapping,
    pendingWithdrawalHash?: string,
    signal?: AbortSignal,
  ): Promise<{ state: "pending" } | { state: "confirmed"; depositId: string; amount: string }>;

  readiness(intent: RampIntent, rail: string, signal?: AbortSignal): Promise<MakerReadiness>;
  /** POST /v2/makers/create, via SDK registerPayeeDetails. Own account only. */
  registerOwnPayee(rail: string, ownAccount: string): Promise<string>;
  allowance(owner: string, amount: string, signal?: AbortSignal): Promise<boolean>;
  prepareApproval(amount: string): Promise<PreparedTransaction>;
  prepareDeposit(
    input: {
      intent: RampIntent;
      rail: string;
      amount: string;
      payeeHash: string;
    },
    signal?: AbortSignal,
  ): Promise<PreparedTransaction>;
  /** Confirm the receipt AND exact sender, chain, target, calldata and value against expected.
   * For creation, return only the deposit ID decoded from that successful escrow receipt.
   * Missing/unknown receipts remain pending; never infer absence or resubmit. */
  reconcile(
    hash: string,
    action: MakerWalletAction,
    owner: string,
    expected: PreparedTransaction,
    signal?: AbortSignal,
  ): Promise<MakerReconciliation>;
  /** Validate deposit owner, Base USDC identity, confirmation/finality and indexer/chain
   * coherence; derive totals from deposit, active intents and verified fills/withdrawals.
   * Never label signalled or payment-pending intents as filled. Throw on missing/stale data. */
  deposit(depositId: string, owner: string, signal?: AbortSignal): Promise<MakerDepositFacts>;
  prepareWithdrawal(
    depositId: string,
    amount: string,
    full: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedTransaction>;
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
  creationHash?: string;
  plan?: MakerUnsignedPlan;
  claimed?: MakerWalletAction;
  hash?: string;
  approved: boolean;
  amounts?: MakerOrderAmounts;
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
  approve(
    preview: RampPreview,
    context: RampCommandContext,
    signal?: AbortSignal,
  ): Promise<RampSnapshot>;
  interact(
    operationId: string,
    context: RampCommandContext,
    signal?: AbortSignal,
  ): Promise<RampSnapshot>;
  recover(
    operationId: string,
    action: RampAction,
    context: RampCommandContext,
    signal?: AbortSignal,
  ): Promise<RampSnapshot>;
  status(operationId: string, signal?: AbortSignal): Promise<RampSnapshot>;
  /** Explicit setup-only registration; returns no payee/provider identifier. */
  setupOwnAccount(rail: string, account: string, ownership: "own_account"): Promise<void>;
  /** Trusted local UI input. This confirms the handle belongs to the connected user. */
  setOwnAccount(operationId: string, account: string, ownership: "own_account"): Promise<void>;
  /** Single-use handoff to the caller's wallet. Claiming creates uncertainty until reconciled. */
  takeUnsignedPlan(operationId: string, signal?: AbortSignal): Promise<MakerUnsignedPlan>;
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
    signal?: AbortSignal,
  ): Promise<RampSnapshot>;
  orderStatus(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{
    snapshot: RampSnapshot;
    phase?: MakerPhase;
    reason?: MakerReason;
    amounts?: MakerOrderAmounts;
  }>;
}
export function createPeerOfframpProvider(options: {
  io: PeerMakerIO;
  discovery: PeerDiscoveryOptions;
  store?: PeerMakerPrivateStore;
  mintOperationId?: () => string;
  storage?: MakerMappingStorage | null;
}): PeerOfframpProvider {
  const store = options.store ?? new PeerMakerPrivateStore();
  const now = options.discovery.now ?? Date.now;
  const io = options.io;
  const refusedRails = new Set<string>();
  const recoveredWithdrawalHashes = new Map<string, string>();
  const registrations = new Map<string, { account: string; hash: string }>();
  const config = peerConfiguration(options.discovery);
  const browserStorage =
    options.storage === null ? undefined : (options.storage ?? browserMakerStorage());
  const mappings =
    browserStorage && options.discovery.user
      ? new ProtectedMakerMappings(browserStorage, options.discovery.user, config.escrow)
      : undefined;
  function persist(e: Entry) {
    if (!mappings) return;
    if (e.snapshot.terminal) {
      mappings.remove(e.snapshot.operation_id);
      return;
    }
    if (!e.depositId && !e.creationHash && e.claimed !== "create_deposit") {
      mappings.remove(e.snapshot.operation_id);
      return;
    }
    if (e.depositId || e.creationHash || e.claimed === "create_deposit")
      mappings.put({
        operationRef: e.snapshot.operation_id,
        escrowAddress: config.escrow,
        depositId: e.depositId ?? null,
        creationTxHash: e.creationHash ?? null,
        legRevision: e.snapshot.revision,
      });
  }
  async function restore(
    entries: Map<string, Entry>,
    id: string,
    signal?: AbortSignal,
  ): Promise<RampSnapshot | undefined> {
    const saved = mappings?.get(id);
    if (!saved) fail();
    const snapshot: RampSnapshot = {
      contract_version: "ramp/1",
      kind: "snapshot",
      operation_id: id,
      revision: saved.legRevision,
      direction: "offramp",
      leg_order: ["peer"],
      peer: { name: "peer", state: "in_doubt", recoverable: true, failure_code: "peer_in_doubt" },
      allowed_actions: ["check_status"],
      updated_at: new Date(now()).toISOString(),
      terminal: false,
    };
    const rebuilt = await (io.rebuild
      ? boundedPeerRead(
          (bound) => io.rebuild!(saved, recoveredWithdrawalHashes.get(id), bound),
          signal,
        )
      : undefined);
    checkPeerAbort(signal);
    if (!rebuilt || rebuilt.state === "pending") return snapshot;
    const amount = atomic(rebuilt.amount);
    const intent: RampIntent = {
      contract_version: "ramp/1",
      kind: "intent",
      direction: "offramp",
      exact: { side: "crypto", money: { asset: config.settlement, atomic: amount } },
      fiat: { kind: "fiat", currency: "USD", decimals: 6 },
      crypto: config.settlement,
      recipient: options.discovery.user!,
    };
    const offer = makeOffer(
      intent,
      config,
      "recovered",
      now(),
      { state: "availability_unknown", reason_code: "capability_unavailable" },
      ["recovered"],
    );
    // Only recovery reads use this internal record; it can never prepare a second deposit.
    const preview: RampPreview = {
      contract_version: "ramp/1",
      kind: "preview",
      operation_id: id,
      quote_id: "recovered",
      offer_id: offer.offer_id,
      capability_revision: offer.capability_revision,
      request_digest: `0x${"0".repeat(64)}`,
      pay: { asset: config.settlement, atomic: amount },
      receive: { asset: intent.fiat, atomic: atomic("0") },
      fees: [],
      expires_at: new Date(0).toISOString(),
      leg_order: ["peer"],
      disclosures: offer.disclosures,
    };
    entries.set(id, {
      intent,
      offer,
      preview,
      snapshot,
      depositId: rebuilt.depositId,
      creationHash: saved.creationTxHash ?? undefined,
      approved: false,
      transactionHashes: new Set(saved.creationTxHash ? [saved.creationTxHash.toLowerCase()] : []),
      // S4 owns its persisted public CAS counter; it is independent of this leg revision.
      commandRevision: 0n,
      receipts: new Map(),
    });
  }
  async function readReady(
    intent: RampIntent,
    rail: string,
    signal?: AbortSignal,
  ): Promise<MakerReadiness> {
    try {
      const result = await boundedPeerRead((bound) => io.readiness(intent, rail, bound), signal);
      checkPeerAbort(signal);
      return {
        ...result,
        requiresIdentityAttestation:
          result.requiresIdentityAttestation || ["wise", "paypal", "alipay"].includes(rail),
      };
    } catch {
      checkPeerAbort(signal);
      fail("capability_unavailable");
    }
  }

  function entry(entries: Map<string, Entry>, id: string): Entry {
    const value = entries.get(id) ?? fail();
    if (
      options.discovery.user &&
      value.intent.recipient.toLowerCase() !== options.discovery.user.toLowerCase()
    )
      fail("session_conflict");
    return value;
  }
  function update(
    e: Entry,
    state: RampSnapshot["peer"]["state"],
    actions: RampAction[],
    failure?: RampSnapshot["peer"]["failure_code"],
  ): RampSnapshot {
    e.snapshot = {
      ...e.snapshot,
      // An odd provider revision durably marks a withdrawal wallet handoff. After
      // reload it cannot be re-authorized until its known wallet hash is reconciled.
      revision: (() => {
        let next = BigInt(e.snapshot.revision) + 1n;
        const parity = e.claimed === "withdraw_unmatched" ? 1n : 0n;
        if (next % 2n !== parity) next++;
        return next.toString();
      })(),
      peer: {
        name: "peer",
        state,
        recoverable: !["completed", "refunded"].includes(state),
        ...(failure ? { failure_code: failure } : {}),
        ...(state === "completed" &&
        e.amounts &&
        BigInt(e.amounts.filled) > 0n &&
        BigInt(e.amounts.withdrawn) > 0n
          ? {
              partial_result: {
                settlement: "base_usdc" as const,
                filled_atomic: e.amounts.filled,
                returned_atomic: e.amounts.withdrawn,
              },
            }
          : {}),
      },
      allowed_actions: actions,
      updated_at: new Date(now()).toISOString(),
      terminal: ["completed", "refunded"].includes(state),
    };
    persist(e);
    return copy(e.snapshot);
  }
  async function fresh(e: Entry, signal?: AbortSignal) {
    if (Date.parse(e.preview.expires_at) <= now()) fail("quote_expired");
    const ready = await readReady(e.intent, e.offer.rail.id, signal);
    const code = refusedRails.has(e.offer.rail.id) ? "setup_required" : readinessCode(ready);
    if (code) fail(code);
    // Re-read authoritative maker bounds/rate/fees, and require another review if changed.
    const preview = await previewPeerOffer(e.offer, e.intent, e.preview.operation_id, {
      ...options.discovery,
      signal,
    });
    checkPeerAbort(signal);
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
    return { action, transaction: copy(transaction), expiresAt, account: options.discovery.user! };
  }
  async function refresh(e: Entry, signal?: AbortSignal): Promise<RampSnapshot> {
    checkPeerAbort(signal);
    if (e.snapshot.terminal) return copy(e.snapshot);
    if (e.claimed) {
      if (!e.hash) return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
      const result = await boundedPeerRead(
        (bound) =>
          io.reconcile(e.hash!, e.claimed!, e.intent.recipient, e.plan!.transaction, bound),
        signal,
      );
      checkPeerAbort(signal);
      if (result.state === "pending")
        return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
      const action = e.claimed;
      if (result.state === "confirmed" && action === "create_deposit") {
        if (!result.depositId) return update(e, "in_doubt", ["check_status"], "peer_in_doubt");
        e.depositId = result.depositId;
        // The actual payment handle is no longer needed after successful registration/deposit.
        delete e.ownAccount;
        delete e.payeeHash;
        registrations.delete(e.offer.rail.id);
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
    const facts = await boundedPeerRead(
      (bound) => io.deposit(e.depositId!, e.intent.recipient, bound),
      signal,
    );
    checkPeerAbort(signal);
    if (!factsValid(facts, e.preview.pay.atomic)) fail("provider_declined");
    const filled = BigInt(facts.filled),
      withdrawn = BigInt(facts.withdrawn),
      remaining = BigInt(facts.remaining);
    e.amounts = {
      deposited: atomic(e.preview.pay.atomic),
      filled: atomic(facts.filled),
      reserved: atomic(remaining - BigInt(facts.unmatched)),
      withdrawable: atomic(facts.unmatched),
      withdrawn: atomic(facts.withdrawn),
    };
    e.phase =
      remaining === 0n && facts.activeIntents === 0
        ? filled > 0n
          ? "delivered"
          : withdrawn > 0n
            ? "returned"
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
    signal?: AbortSignal,
  ) {
    return access(store, async (entries) => {
      checkPeerAbort(signal);
      const e = copy(entry(entries, id));
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
        checkPeerAbort(signal);
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
      checkPeerAbort(signal);
      entries.set(id, e);
      e.receipts.set(context.idempotency_key, { fingerprint, snapshot: copy(snapshot) });
      return snapshot;
    });
  }
  async function readStatus(
    entries: Map<string, Entry>,
    id: string,
    signal?: AbortSignal,
  ): Promise<RampSnapshot> {
    checkPeerAbort(signal);
    // Stage reconciliation so cancellation cannot publish a partially read order.
    const staged = new Map(entries);
    if (staged.has(id)) staged.set(id, copy(staged.get(id)!));
    if (!staged.has(id)) {
      try {
        const pending = await restore(staged, id, signal);
        if (pending) return pending;
      } catch {
        checkPeerAbort(signal);
        fail("peer_in_doubt");
      }
    }
    const e = entry(staged, id);
    let snapshot: RampSnapshot;
    try {
      snapshot = await refresh(e, signal);
    } catch {
      checkPeerAbort(signal);
      snapshot = update(e, "in_doubt", ["check_status"], "peer_in_doubt");
    }
    checkPeerAbort(signal);
    entries.set(id, e);
    return snapshot;
  }
  const provider: PeerOfframpProvider = {
    id: "peer",
    async setupOwnAccount(rail, account, ownership) {
      if (
        ownership !== "own_account" ||
        !account ||
        account.length > 256 ||
        !Object.hasOwn(config.rails, rail)
      )
        fail();
      try {
        const hash = await io.registerOwnPayee(rail, account);
        registrations.set(rail, { account, hash });
        refusedRails.delete(rail);
      } catch (error) {
        if (error instanceof MakerSetupRequired) {
          refusedRails.add(rail);
          throw new MakerSetupRequired();
        }
        fail("provider_declined");
      }
    },
    async capabilities(intent, signal) {
      checkPeerAbort(signal);
      if (intent.direction !== "offramp") return { offers: [] };
      const result = await fetchPeerCapabilities(intent, { ...options.discovery, signal });
      for (const offer of result.offers) {
        try {
          const code = refusedRails.has(offer.rail.id)
            ? "setup_required"
            : readinessCode(await readReady(intent, offer.rail.id, signal));
          if (code)
            offer.availability =
              code === "setup_required"
                ? { state: "setup_required", requirement_codes: ["maker_account_setup"] }
                : { state: "temporarily_unavailable", reason_code: code };
        } catch {
          checkPeerAbort(signal);
          offer.availability = {
            state: "availability_unknown",
            reason_code: "capability_unavailable",
          };
        }
      }
      checkPeerAbort(signal);
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
    async preview(intent, offer, signal) {
      checkPeerAbort(signal);
      if (
        intent.direction !== "offramp" ||
        options.discovery.user?.toLowerCase() !== intent.recipient.toLowerCase()
      )
        fail();
      const id = (options.mintOperationId ?? (() => crypto.randomUUID()))();
      const result = await previewPeerOffer(offer, intent, id, { ...options.discovery, signal });
      if (!result.ok) fail(result.code);
      const code = refusedRails.has(offer.rail.id)
        ? "setup_required"
        : readinessCode(await readReady(intent, offer.rail.id, signal));
      if (code) fail(code);
      return access(store, async (entries) => {
        checkPeerAbort(signal);
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
          ...(registrations.has(offer.rail.id)
            ? {
                ownAccount: registrations.get(offer.rail.id)!.account,
                payeeHash: registrations.get(offer.rail.id)!.hash,
              }
            : {}),
          transactionHashes: new Set(),
          commandRevision: 0n,
          receipts: new Map(),
        });
        return copy(preview);
      });
    },
    approve(preview, context, signal) {
      return command(
        preview.operation_id,
        `approve:${JSON.stringify(preview)}`,
        context,
        async (e) => {
          if (JSON.stringify(e.preview) !== JSON.stringify(preview) || e.depositId || e.approved)
            fail("quote_changed");
          await fresh(e, signal);
          e.approved = true;
          return update(e, "action_required", ["interact", "check_status"]);
        },
        signal,
      );
    },
    interact(id, context, signal) {
      return command(
        id,
        "interact",
        context,
        async (e) => {
          if (e.depositId) return refresh(e, signal); // Withdrawal requires a separately named amount/review.
          if (e.plan) return copy(e.snapshot);
          if (!e.approved) fail();
          await fresh(e, signal);
          if (!e.ownAccount) fail("setup_required");
          if (
            !(await boundedPeerRead(
              (bound) => io.allowance(e.intent.recipient, e.preview.pay.atomic, bound),
              signal,
            ))
          ) {
            e.plan = validatePlan(
              await io.prepareApproval(e.preview.pay.atomic),
              "approve_usdc",
              e.preview.expires_at,
            );
          } else {
            checkPeerAbort(signal);
            if (!e.ownAccount) fail("setup_required");
            e.payeeHash ??= await io.registerOwnPayee(e.offer.rail.id, e.ownAccount);
            checkPeerAbort(signal);
            e.plan = validatePlan(
              await io.prepareDeposit(
                {
                  intent: e.intent,
                  rail: e.offer.rail.id,
                  amount: e.preview.pay.atomic,
                  payeeHash: e.payeeHash,
                },
                signal,
              ),
              "create_deposit",
              e.preview.expires_at,
            );
          }
          checkPeerAbort(signal);
          return update(e, "action_required", ["check_status"]);
        },
        signal,
      );
    },
    async status(id, signal) {
      checkPeerAbort(signal);
      return access(store, (entries) => readStatus(entries, id, signal));
    },
    async recover(id, action, context, signal) {
      checkPeerAbort(signal);
      if (action === "check_status") return provider.status(id, signal);
      if (action !== "recover_peer" && action !== "requote") fail();
      return command(
        id,
        action,
        context,
        async (e) => {
          if (e.depositId) return refresh(e, signal);
          // A new quote/approval is required after a reverted transaction or stale estimate.
          delete e.plan;
          e.approved = false;
          return update(e, "quoted", ["requote"]);
        },
        signal,
      );
    },
    async setOwnAccount(id, account, ownership) {
      await access(store, async (entries) => {
        const e = entry(entries, id);
        if (
          ownership !== "own_account" ||
          !account ||
          account.length > 256 ||
          e.depositId ||
          e.approved ||
          e.claimed ||
          e.payeeHash
        )
          fail();
        e.ownAccount = account;
      });
    },
    async takeUnsignedPlan(id, signal) {
      checkPeerAbort(signal);
      return access(store, async (entries) => {
        const e = entry(entries, id);
        if (!e.plan || e.claimed) fail();
        if (Date.parse(e.plan.expiresAt) <= now()) {
          delete e.plan;
          fail("quote_expired");
        }
        if (e.plan.action !== "withdraw_unmatched") await fresh(e, signal);
        else {
          if (!e.depositId || !e.withdrawalAmount) fail();
          let facts: MakerDepositFacts;
          try {
            facts = await boundedPeerRead(
              (bound) => io.deposit(e.depositId!, e.intent.recipient, bound),
              signal,
            );
          } catch {
            checkPeerAbort(signal);
            fail("peer_in_doubt");
          }
          if (
            !factsValid(facts, e.preview.pay.atomic) ||
            BigInt(e.withdrawalAmount) > BigInt(facts.unmatched) ||
            (BigInt(e.withdrawalAmount) === BigInt(facts.remaining) && facts.activeIntents > 0)
          )
            throw new MakerWithdrawalBlocked();
        }
        checkPeerAbort(signal);
        e.claimed = e.plan.action;
        update(e, "in_doubt", ["check_status"], "peer_in_doubt");
        return copy(e.plan);
      });
    },
    async recordSubmission(id, action, hash) {
      await access(store, async (entries) => {
        if (!entries.has(id)) {
          const saved = mappings?.get(id);
          if (
            saved?.depositId &&
            action === "withdraw_unmatched" &&
            BigInt(saved.legRevision) % 2n === 1n &&
            /^0x[0-9a-fA-F]{64}$/.test(hash)
          ) {
            recoveredWithdrawalHashes.set(id, hash);
            return;
          }
          if (
            !saved ||
            saved.creationTxHash ||
            action !== "create_deposit" ||
            !/^0x[0-9a-fA-F]{64}$/.test(hash)
          )
            fail();
          mappings!.put({ ...saved, creationTxHash: hash });
          return;
        }
        const e = entry(entries, id);
        if (e.claimed !== action || e.hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) fail();
        if ([...entries.values()].some((other) => other.transactionHashes.has(hash.toLowerCase())))
          fail("session_conflict");
        e.transactionHashes.add(hash.toLowerCase());
        e.hash = hash;
        if (action === "create_deposit") e.creationHash = hash;
        persist(e);
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
    prepareWithdrawal(id, amount, context, signal) {
      return command(
        id,
        `withdraw:${amount}`,
        context,
        async (e) => {
          if (!e.depositId || e.plan) fail();
          const requested = BigInt(atomic(amount));
          const facts = await boundedPeerRead(
            (bound) => io.deposit(e.depositId!, e.intent.recipient, bound),
            signal,
          );
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
            await io.prepareWithdrawal(e.depositId, amount, full, signal),
            "withdraw_unmatched",
            new Date(now() + 30_000).toISOString(),
          );
          checkPeerAbort(signal);
          return update(e, "action_required", ["check_status"]);
        },
        signal,
      );
    },
    async orderStatus(id, signal) {
      checkPeerAbort(signal);
      return access(store, async (entries) => {
        const snapshot = await readStatus(entries, id, signal);
        checkPeerAbort(signal);
        return {
          snapshot,
          ...(snapshot.peer.state !== "in_doubt" && entries.get(id)?.amounts
            ? { amounts: copy(entries.get(id)!.amounts) }
            : {}),
          ...(snapshot.peer.state !== "in_doubt" && entries.get(id)?.phase
            ? { phase: entries.get(id)?.phase }
            : {}),
          ...(entries.get(id)?.reason ? { reason: entries.get(id)?.reason } : {}),
        };
      });
    },
  };
  return provider;
}
export type { PeerDiscoveryResult };
