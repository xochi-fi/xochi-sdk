/**
 * useOfframp
 *
 * One Send/payment_app cash-out: estimate -> review -> wallet steps -> order.
 *
 * - Estimate: S4's `preview` over a fresh, selectable offer. It is an
 *   approximation (`maker_estimate`) with a short validity window; once
 *   `expires_at` passes the review cannot be confirmed and must be re-estimated.
 * - Review confirm: the user's own payee goes to S5's provider-private
 *   `setOwnAccount` and nowhere else, then S4 `approve` records acceptance of
 *   every disclosure. Neither contacts the wallet.
 * - Wallet steps: each is its own click. `interact` prepares one unsigned plan,
 *   `takeUnsignedPlan` hands it out once, the wallet signs it, and the public
 *   hash is recorded before anything else. A rejected prompt is recorded as
 *   such; any other wallet failure stays in doubt and is reconciled by status
 *   checks only, never resubmitted.
 * - Order: progress is S5's `orderStatus`, rebuilt from chain and indexer
 *   facts. Withdrawal of unmatched USDC is a separate prepare + wallet approval.
 * - Reload: the sanitized local summary names the open order; S5 rebuilds it
 *   from its protected deposit mapping. Nothing on that path can create a
 *   deposit.
 *
 * Ramp events go through `createRampEmitter` and carry only its opaque
 * reference and bounded leg states.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RampCommandContext,
  RampIntent,
  RampLegState,
  RampOffer,
  RampPreview,
  RampSnapshot,
} from "@xochi/client";
import type { Hex } from "viem";
import { isUserRejection } from "../../lib/eip712.js";
import { createRampEmitter } from "../../lib/rampLifecycle.js";
import {
  MakerSetupRequired,
  type MakerPhase,
  type MakerOrderAmounts,
  type MakerReason,
  type MakerWalletAction,
} from "../peer/index.js";
import { railName } from "../availability/model.js";
import {
  listLocalOfframps,
  resumableOfframp,
  upsertLocalOfframp,
  type OfframpActivityItem,
  type OfframpStage,
  type OfframpStatus,
} from "./localOfframps.js";
import { canaryCapError, disclosureCodes, maskPayee } from "./model.js";
import { BASE_CHAIN_ID, type OfframpPort, type OfframpRuntime } from "./port.js";

export interface OfframpQuote {
  intent: RampIntent;
  offer: RampOffer;
  preview: RampPreview;
  railName: string;
  /** Masked payee already registered for this rail through explicit setup, if any. */
  registeredPayee?: string;
}

export interface OfframpOrder {
  ref: string;
  rail: string;
  railName: string;
  currency: string;
  /** Base USDC deposit, atomic. */
  amount: string;
  snapshot: RampSnapshot;
  amounts?: MakerOrderAmounts;
  phase?: MakerPhase;
  reason?: MakerReason;
  stage: OfframpStage;
  /** Set when the last wallet step's outcome is unknown and needs its hash. */
  pendingAction?: MakerWalletAction;
  /** Known next wallet step, when the order has told us. */
  nextAction?: MakerWalletAction;
  /** Rebuilt after a reload: only status, withdrawal and hash reattachment apply. */
  resumed: boolean;
  /** The payee shown on review, masked. Memory only. */
  payeeMask?: string;
}

export type OfframpView =
  | { kind: "edit" }
  | { kind: "review"; quote: OfframpQuote }
  | { kind: "order"; order: OfframpOrder };

export type OfframpBusy =
  | false
  | "estimating"
  | "confirming"
  | "switching"
  | "wallet"
  | "checking"
  | "withdrawing"
  | "setup";

const DECLINED = "You declined in your wallet. Nothing was sent.";
const UNCONFIRMED =
  "Your wallet did not confirm whether it sent the transaction. Check your wallet's activity; if it shows one, paste its hash into the transaction field. Nothing will be sent again automatically.";

function context(revision: string): RampCommandContext {
  return { expected_revision: revision, idempotency_key: crypto.randomUUID() };
}

function statusOf(snapshot: RampSnapshot, phase: MakerPhase | undefined): OfframpStatus {
  if (phase === "delivered") return "delivered";
  if (phase === "returned") return "returned";
  if (snapshot.peer.state === "in_doubt") return "in_doubt";
  return "open";
}

/** A display-only placeholder for an order whose state could not be read. */
function unreadable(ref: string, now: number): RampSnapshot {
  return {
    contract_version: "ramp/1",
    kind: "snapshot",
    operation_id: ref,
    revision: "0",
    direction: "offramp",
    leg_order: ["peer"],
    peer: { name: "peer", state: "in_doubt", recoverable: true, failure_code: "peer_in_doubt" },
    allowed_actions: ["check_status"],
    updated_at: new Date(now).toISOString(),
    terminal: false,
  };
}

export function useOfframp(
  port: OfframpPort,
  account: string | undefined,
  active: boolean,
  funding?: (amount: string) => Promise<boolean>,
) {
  const [runtime, setRuntime] = useState<OfframpRuntime | undefined>();
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [view, setView] = useState<OfframpView>({ kind: "edit" });
  const [busy, setBusy] = useState<OfframpBusy>(false);
  const [notice, setNotice] = useState<string | undefined>();
  const registered = useRef(new Map<string, string>());
  /** Lowest expected revision S5's command order still accepts. */
  const nextRevision = useRef(0n);
  /** S4's latest public snapshot for the current, non-resumed order. */
  const s4 = useRef<RampSnapshot | undefined>(undefined);
  const emitter = useRef<ReturnType<typeof createRampEmitter> | null>(null);
  const lastEmitted = useRef<RampLegState | undefined>(undefined);
  const orderRef = useRef<OfframpOrder | undefined>(undefined);
  orderRef.current = view.kind === "order" ? view.order : undefined;

  // One runtime per wallet. A wallet change drops every in-flight view.
  useEffect(() => {
    setRuntime(undefined);
    setRuntimeFailed(false);
    setView({ kind: "edit" });
    setNotice(undefined);
    registered.current = new Map();
    s4.current = undefined;
    emitter.current = null;
    if (!account || !active) return;
    let stale = false;
    port.runtime(account).then(
      (r) => !stale && setRuntime(r),
      () => !stale && setRuntimeFailed(true),
    );
    return () => {
      stale = true;
    };
    // `active` only gates the first read; a hidden panel keeps its runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, account, active && account !== undefined]);

  const save = useCallback(
    (order: OfframpOrder) => {
      const item: OfframpActivityItem = {
        id: order.ref,
        type: "offramp",
        timestamp: port.now(),
        stage: order.stage,
        status: statusOf(order.snapshot, order.phase),
        ...(order.phase ? { phase: order.phase } : {}),
        ...(order.pendingAction ? { pendingAction: order.pendingAction } : {}),
        data: { rail: order.rail, currency: order.currency, amount: order.amount },
      };
      upsertLocalOfframp(account, item);
    },
    [account, port],
  );

  const emit = useCallback((snapshot: RampSnapshot) => {
    const e = emitter.current;
    if (!e || lastEmitted.current === snapshot.peer.state) return;
    lastEmitted.current = snapshot.peer.state;
    if (snapshot.terminal) {
      e.terminal(snapshot.peer.state);
      emitter.current = null;
    } else if (snapshot.peer.state === "in_doubt") e.recoveryRequired("peer", "peer_in_doubt");
    else e.status(snapshot.peer.state);
  }, []);

  const showOrder = useCallback(
    (order: OfframpOrder) => {
      save(order);
      emit(order.snapshot);
      setView({ kind: "order", order });
    },
    [save, emit],
  );

  const bump = (revision: string) => {
    const next = BigInt(revision) + 1n;
    if (next > nextRevision.current) nextRevision.current = next;
  };

  /** Re-read the order from chain and indexer facts. Never prepares or sends anything. */
  const readOrder = useCallback(
    async (order: OfframpOrder, signal?: AbortSignal): Promise<OfframpOrder> => {
      if (!runtime) return order;
      try {
        const status = await runtime.provider.orderStatus(order.ref, signal);
        const settled = status.snapshot.peer.state !== "in_doubt";
        return {
          ...order,
          snapshot: status.snapshot,
          amounts: status.amounts,
          phase: status.phase ?? order.phase,
          reason: status.reason,
          ...(status.phase ? { stage: "deposit" as const } : {}),
          pendingAction: settled ? undefined : order.pendingAction,
        };
      } catch {
        return { ...order, snapshot: unreadable(order.ref, port.now()) };
      }
    },
    [runtime, port],
  );

  // Resume the newest open order once the wallet's runtime is ready.
  useEffect(() => {
    if (!runtime || !account) return;
    const row = resumableOfframp(listLocalOfframps(account));
    if (!row) return;
    let stale = false;
    const base: OfframpOrder = {
      ref: row.id,
      rail: row.data.rail,
      railName: railName({ rail: { id: row.data.rail, label: row.data.rail } }),
      currency: row.data.currency,
      amount: row.data.amount,
      snapshot: unreadable(row.id, port.now()),
      ...(row.phase ? { phase: row.phase } : {}),
      stage: row.stage,
      ...(row.pendingAction ? { pendingAction: row.pendingAction } : {}),
      resumed: true,
    };
    void (async () => {
      if (row.stage === "before_deposit") {
        // No deposit step was handed to the wallet, so nothing is in escrow and
        // nothing can be resumed: the estimate and its approval died with the page.
        upsertLocalOfframp(account, { ...row, status: "not_started" });
        return;
      }
      setBusy("checking");
      const order = await readOrder(base);
      if (stale) return;
      setBusy(false);
      showOrder(order);
    })();
    return () => {
      stale = true;
    };
  }, [runtime, account, port, readOrder, showOrder]);

  // Follow an open deposit without user action; each read is a plain status read.
  const order = view.kind === "order" ? view.order : undefined;
  useEffect(() => {
    if (!order || !port.pollMs || busy || order.snapshot.terminal || order.stage !== "deposit")
      return;
    if (order.pendingAction && order.snapshot.peer.state === "in_doubt") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readOrder(order, controller.signal).then(
        (next) =>
          !controller.signal.aborted && orderRef.current?.ref === next.ref && showOrder(next),
      );
    }, port.pollMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [order, busy, port, readOrder, showOrder]);

  const estimate = useCallback(
    async (offer: RampOffer, intent: RampIntent) => {
      if (!runtime || busy) return;
      const capped = canaryCapError(intent.exact.money.atomic, port.canaryCap());
      if (capped) {
        setNotice(capped);
        return;
      }
      setBusy("estimating");
      setNotice(undefined);
      try {
        const preview = await runtime.client.preview(
          intent,
          offer.offer_id,
          offer.capability_revision,
        );
        const mask = registered.current.get(offer.rail.id);
        setView({
          kind: "review",
          quote: {
            intent,
            offer,
            preview,
            railName: railName(offer),
            ...(mask ? { registeredPayee: mask } : {}),
          },
        });
      } catch {
        setNotice("Peer could not give a fresh estimate for this rail. Check the rails again.");
      } finally {
        setBusy(false);
      }
    },
    [runtime, busy, port],
  );

  /** Explicit own-account setup for a rail Peer marks as needing it. */
  const setupAccount = useCallback(
    async (rail: string, payee: string): Promise<boolean> => {
      if (!runtime || busy) return false;
      setBusy("setup");
      setNotice(undefined);
      try {
        await runtime.provider.setupOwnAccount(rail, payee.trim(), "own_account");
        registered.current.set(rail, maskPayee(payee));
        return true;
      } catch (error) {
        setNotice(
          error instanceof MakerSetupRequired
            ? "Peer needs more setup for this rail (for example Seller Autopilot or an identity check) in the Peer app first."
            : "Peer did not accept this account. Nothing was created.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runtime, busy],
  );

  const edit = useCallback(() => {
    if (busy) return;
    setNotice(undefined);
    setView({ kind: "edit" });
  }, [busy]);

  /** Review confirmed: own payee into the provider-private store, then S4 approve. */
  const confirm = useCallback(
    async (payee: string | undefined) => {
      if (!runtime || busy || view.kind !== "review") return;
      const { quote } = view;
      const capped = canaryCapError(quote.preview.pay.atomic, port.canaryCap());
      if (capped) {
        setNotice(capped);
        return;
      }
      if (Date.parse(quote.preview.expires_at) <= port.now()) {
        setNotice("This estimate expired. Get a new estimate before continuing.");
        return;
      }
      setBusy("confirming");
      setNotice(undefined);
      const id = quote.preview.operation_id;
      try {
        if (funding && !(await funding(quote.preview.pay.atomic))) {
          setNotice(
            "Spendable Base USDC could not be confirmed in this wallet. Peer has not started; check the balance. The completed Xochi route will not repeat.",
          );
          return;
        }
        if (!quote.registeredPayee) {
          if (!payee) return;
          await runtime.provider.setOwnAccount(id, payee.trim(), "own_account");
        }
        emitter.current = createRampEmitter("offramp");
        lastEmitted.current = undefined;
        let snapshot = await runtime.client.approve(
          id,
          quote.preview.quote_id,
          disclosureCodes(quote.preview),
          context("0"),
        );
        bump("0");
        s4.current = snapshot;
        const next: OfframpOrder = {
          ref: id,
          rail: quote.offer.rail.id,
          railName: quote.railName,
          currency: quote.intent.fiat.currency,
          amount: quote.preview.pay.atomic,
          snapshot,
          stage: "before_deposit",
          resumed: false,
          payeeMask: quote.registeredPayee ?? (payee ? maskPayee(payee) : undefined),
        };
        if (snapshot.peer.state === "failed") {
          setNotice("Peer's terms changed or the estimate expired. Get a new estimate.");
          showOrder(next);
          return;
        }
        showOrder(next);
        // Prepares the first unsigned wallet step; contacts no wallet.
        snapshot = await runtime.client.interact(id, {}, context(snapshot.revision));
        bump(s4.current.revision);
        s4.current = snapshot;
        showOrder({ ...next, snapshot });
      } catch {
        setNotice("Peer did not accept this cash-out. No wallet step was started.");
      } finally {
        setBusy(false);
      }
    },
    [runtime, busy, view, port, showOrder, funding],
  );

  const switchNetwork = useCallback(async () => {
    if (busy) return;
    setBusy("switching");
    try {
      await port.wallet.switchToBase();
      setNotice(undefined);
    } catch {
      setNotice("The wallet did not switch to Base.");
    } finally {
      setBusy(false);
    }
  }, [busy, port]);

  /** One explicit wallet approval: the plan already prepared for this order. */
  const walletStep = useCallback(async () => {
    const current = orderRef.current;
    if (!runtime || busy || !current || !account) return;
    if (port.wallet.chainId() !== BASE_CHAIN_ID) {
      setNotice("Switch your wallet to Base first.");
      return;
    }
    setBusy("wallet");
    setNotice(undefined);
    const { provider, client } = runtime;
    let order = current;
    try {
      let plan;
      try {
        plan = await provider.takeUnsignedPlan(order.ref);
      } catch {
        // No prepared plan (for example after a decline): prepare the next one first.
        if (order.resumed || !s4.current) throw new Error("no_plan");
        const prepared = await client.interact(order.ref, {}, context(s4.current.revision));
        bump(s4.current.revision);
        s4.current = prepared;
        order = { ...order, snapshot: prepared };
        if (prepared.peer.state !== "action_required") {
          showOrder(order);
          return;
        }
        plan = await provider.takeUnsignedPlan(order.ref);
      }
      if (plan.account.toLowerCase() !== account.toLowerCase()) {
        await provider.recordWalletRejection(order.ref);
        setNotice(
          "The connected wallet is not the one this cash-out belongs to. Nothing was sent.",
        );
        return;
      }
      order = {
        ...order,
        pendingAction: plan.action,
        stage: plan.action === "create_deposit" ? "deposit" : order.stage,
      };
      save(order);
      let hash: Hex;
      try {
        hash = await port.wallet.send(plan);
      } catch (error) {
        if (isUserRejection(error)) {
          await provider.recordWalletRejection(order.ref);
          setNotice(DECLINED);
          showOrder({
            ...order,
            pendingAction: undefined,
            stage: current.stage,
            nextAction: plan.action,
          });
        } else {
          setNotice(UNCONFIRMED);
          showOrder({ ...order, snapshot: unreadable(order.ref, port.now()) });
        }
        return;
      }
      await provider.recordSubmission(order.ref, plan.action, hash);
      try {
        await port.wallet.wait(hash);
      } catch {
        // A missing receipt keeps the order in doubt; status checks settle it.
      }
      if (plan.action !== "withdraw_unmatched" && !order.resumed && s4.current) {
        const checked = await client.recover(
          order.ref,
          "peer",
          "check_status",
          context(s4.current.revision),
        );
        bump(s4.current.revision);
        s4.current = checked;
      }
      order = await readOrder(order);
      order = {
        ...order,
        nextAction:
          plan.action === "approve_usdc" && order.snapshot.peer.state === "action_required"
            ? "create_deposit"
            : undefined,
      };
      showOrder(order);
    } catch {
      setNotice("Peer could not hand out the next wallet step. Check the status again.");
      showOrder(await readOrder(order));
    } finally {
      setBusy(false);
    }
  }, [runtime, busy, account, port, save, showOrder, readOrder]);

  const check = useCallback(async () => {
    const current = orderRef.current;
    if (!runtime || busy || !current) return;
    setBusy("checking");
    try {
      showOrder(await readOrder(current));
    } finally {
      setBusy(false);
    }
  }, [runtime, busy, readOrder, showOrder]);

  /** Reattach the public hash of a wallet step whose outcome the page lost. */
  const attachHash = useCallback(
    async (hash: string) => {
      const current = orderRef.current;
      if (!runtime || busy || !current) return;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) {
        setNotice("Paste the full transaction hash: 0x followed by 64 hex characters.");
        return;
      }
      setBusy("checking");
      setNotice(undefined);
      try {
        await runtime.provider.recordSubmission(
          current.ref,
          current.pendingAction ?? "create_deposit",
          hash.trim(),
        );
      } catch {
        setNotice("That hash does not match this cash-out's pending wallet step.");
      }
      try {
        showOrder(await readOrder(current));
      } finally {
        setBusy(false);
      }
    },
    [runtime, busy, readOrder, showOrder],
  );

  /** Prepare the withdrawal plan only; the wallet approval is the next, separate click. */
  const prepareWithdrawal = useCallback(
    async (amount: string) => {
      const current = orderRef.current;
      if (!runtime || busy || !current) return;
      setBusy("withdrawing");
      setNotice(undefined);
      try {
        const expected = nextRevision.current.toString();
        const snapshot = await runtime.provider.prepareWithdrawal(
          current.ref,
          amount,
          context(expected),
        );
        bump(expected);
        if (snapshot.peer.state === "action_required") {
          showOrder({ ...current, snapshot, nextAction: "withdraw_unmatched" });
          return;
        }
        const read = await readOrder(current);
        setNotice(
          read.reason === "active_intent_blocks_withdrawal"
            ? "A buyer is mid-payment, so the full deposit cannot be withdrawn now. Enter the unmatched part instead."
            : "Peer did not accept that withdrawal amount. It must be positive and no more than the unmatched USDC.",
        );
        showOrder(read);
      } catch {
        setNotice("Peer could not prepare the withdrawal. Check the status again.");
      } finally {
        setBusy(false);
      }
    },
    [runtime, busy, readOrder, showOrder],
  );

  /** Leave a finished order (or one never deposited) for a new cash-out. */
  const startOver = useCallback(() => {
    if (busy) return;
    setNotice(undefined);
    s4.current = undefined;
    setView({ kind: "edit" });
  }, [busy]);

  return {
    runtime,
    runtimeFailed,
    view,
    busy,
    notice,
    estimate,
    setupAccount,
    edit,
    confirm,
    switchNetwork,
    walletStep,
    check,
    attachHash,
    prepareWithdrawal,
    startOver,
  };
}
