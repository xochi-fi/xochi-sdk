import { useEffect, useRef } from "react";
import {
  atomic,
  NOT_EXECUTED_SUBSTATUS,
  type RampLegSnapshot,
  type RampMoney,
  type XochiRampDriver,
  type XochiRampPreview,
} from "@xochi/client";
import { toActivityStatus, upsertLocalSwap } from "../../lib/localActivity.js";
import type { SwapActivityItem } from "../../types/activity.js";
import { findOnrampRoute } from "./routeActivity.js";
import type { UseIntentReturn } from "../../hooks/useIntent.js";

/** The validated interpreter boundary; signing data stays inside the existing Swap machine. */
export type RampSwapInterpreter = Pick<
  UseIntentReturn,
  | "status"
  | "quote"
  | "error"
  | "canSign"
  | "intentId"
  | "tierName"
  | "legsWithheld"
  | "txHash"
  | "receivingTxHash"
  | "settlementTxHash"
  | "settlementChainId"
  | "substatus"
  | "requestQuote"
  | "refreshQuote"
  | "reset"
  | "sign"
  | "resume"
> & { receipt: Pick<UseIntentReturn["receipt"], "phase"> };

/** The existing Swap machine remains the sole quote validation and signing authority. */
export function routeMachineStatus(
  intent: Pick<RampSwapInterpreter, "receipt" | "settlementTxHash" | "receivingTxHash">,
): RampLegSnapshot {
  const base = { name: "xochi" as const, recoverable: false };
  const hash = intent.settlementTxHash ?? intent.receivingTxHash;
  const transaction = hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? { transaction_hash: hash } : {};
  switch (intent.receipt.phase) {
    case "success":
      return { ...base, state: "completed", ...transaction };
    case "failed":
    case "refunded":
      return { ...base, state: "failed", recoverable: true, failure_code: "route_failed" };
    case "submitting":
    case "bridging":
    case "settling":
      return { ...base, state: "processing" };
    default:
      return { ...base, state: "in_doubt", recoverable: true, failure_code: "xochi_in_doubt" };
  }
}

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

/** Promise port over useIntent's quote/execute/poll interpreter, with no second signing flow. */
export function useXochiRampDriver(options: {
  intent: RampSwapInterpreter;
  pay: RampMoney;
  receiveAsset: RampMoney["asset"];
  recipient: string;
  settlement: "public" | "stealth";
  authorized: boolean;
  operationId: string;
  wallet: string;
  payee: "own" | "other";
  routeState?: RampLegSnapshot["state"];
}): XochiRampDriver {
  const latest = useRef(options);
  latest.current = options;
  const quoteWait = useRef<Pending<XochiRampPreview> | undefined>(undefined);
  const executeWait = useRef<Pending<RampLegSnapshot> | undefined>(undefined);
  const held = useRef<{ local: string; native: string } | undefined>(undefined);
  const attempted = useRef(false);
  const captured = useRef<SwapActivityItem | undefined>(undefined);
  const restored = useRef(false);
  const driver = useRef<XochiRampDriver | undefined>(undefined);
  if (!driver.current)
    driver.current = {
      quote() {
        const { intent, authorized, pay } = latest.current;
        if (!authorized || quoteWait.current || executeWait.current)
          return Promise.reject(new Error("invalid_request"));
        held.current = undefined;
        attempted.current = false;
        captured.current = undefined;
        const result = new Promise<XochiRampPreview>((resolve, reject) => {
          quoteWait.current = { resolve, reject };
        });
        intent.reset();
        intent.requestQuote(pay.atomic);
        // Bypass the transport's cache on every explicit review/retry. No automatic spending.
        intent.refreshQuote(true);
        return result;
      },
      execute(local) {
        const { intent, authorized } = latest.current;
        if (
          !authorized ||
          held.current?.local !== local ||
          held.current.native !== intent.quote?.quoteId ||
          !intent.canSign
        )
          return Promise.resolve({
            name: "xochi",
            state: "failed",
            recoverable: true,
            failure_code: "quote_changed",
          });
        const o = latest.current;
        if (o.pay.asset.kind !== "crypto" || o.receiveAsset.kind !== "crypto" || !intent.intentId)
          throw new Error("invalid_request");
        attempted.current = true;
        // Capture before wallet work with the public Xochi facts Activity already stores.
        // The correlation is widget-minted; no Peer handle or recipient key is persisted.
        captured.current = {
          id: intent.intentId,
          type: "swap",
          rampOperationId: o.operationId,
          timestamp: Date.now(),
          status: "pending",
          intentStatus: "executing",
          data: {
            fromChainId: 8453,
            toChainId: Number(
              o.receiveAsset.chain_id.slice(7),
            ) as SwapActivityItem["data"]["toChainId"],
            fromToken: o.pay.asset.asset_id,
            toToken: o.receiveAsset.asset_id,
            fromAmount: o.pay.atomic,
            toAmount: intent.quote?.toAmount ?? null,
            tier: intent.tierName,
            feeRate: Number(intent.quote?.xochiFeeRate ?? "0"),
            txHash: null,
            isCrossChain: o.receiveAsset.chain_id !== "eip155:8453",
            settlementType: o.settlement,
            ...(o.settlement === "stealth" && o.payee === "other"
              ? { stealthPayee: "other" as const }
              : {}),
          },
        };
        upsertLocalSwap(o.wallet, captured.current);
        const result = new Promise<RampLegSnapshot>((resolve, reject) => {
          executeWait.current = { resolve, reject };
        });
        intent.sign();
        return result;
      },
      async poll() {
        // A lost runtime never fabricates a new order or guesses the original submission failed.
        if (!attempted.current)
          return {
            name: "xochi",
            state: "in_doubt",
            recoverable: true,
            failure_code: "xochi_in_doubt",
          };
        return routeMachineStatus(latest.current.intent);
      },
    };
  const { intent } = options;
  useEffect(() => {
    if (
      restored.current ||
      attempted.current ||
      intent.status !== "idle" ||
      !options.routeState ||
      !["processing", "in_doubt"].includes(options.routeState)
    )
      return;
    restored.current = true;
    const record = findOnrampRoute(options.wallet, options.operationId, options.pay);
    if (!record) return; // Missing local evidence never permits re-execution.
    captured.current = record;
    attempted.current = true;
    // Stored statuses never authorize a terminal verdict. Re-read the original Xochi intent.
    intent.resume(record.id, "executing", options.wallet);
  }, [intent, options]);
  useEffect(() => {
    const record = captured.current;
    if (!record || record.id !== intent.intentId || !attempted.current) return;
    if (["idle", "quoting", "pending", "signing"].includes(intent.status)) return;
    if (intent.status === "quoted" && !intent.error) return;
    const rejected = intent.status === "quoted" && !!intent.error;
    const status = rejected ? "failed" : intent.status;
    const next: SwapActivityItem = {
      ...record,
      status: toActivityStatus(status),
      intentStatus: status,
      ...(intent.legsWithheld === null ? {} : { legsWithheld: intent.legsWithheld }),
      data: {
        ...record.data,
        txHash: intent.txHash,
        receivingTxHash: intent.receivingTxHash,
        settlementTxHash: intent.settlementTxHash,
        settlementChainId: intent.settlementChainId,
        substatus:
          rejected || intent.receipt.phase === "failed" ? NOT_EXECUTED_SUBSTATUS : intent.substatus,
      },
    };
    upsertLocalSwap(options.wallet, next);
  }, [
    intent.status,
    intent.error,
    intent.txHash,
    intent.receivingTxHash,
    intent.settlementTxHash,
    intent.receipt.phase,
    intent.substatus,
  ]);
  useEffect(() => {
    if (quoteWait.current) {
      if (intent.canSign && intent.quote) {
        const pending = quoteWait.current;
        quoteWait.current = undefined;
        const local = crypto.randomUUID();
        held.current = { local, native: intent.quote.quoteId };
        pending.resolve({
          quoteId: local,
          expiresAt: intent.quote.expiry,
          pay: options.pay,
          receive: { asset: options.receiveAsset, atomic: atomic(intent.quote.toAmount) },
          recipient: options.recipient,
          settlement: options.settlement,
        });
      } else if (intent.error && !["quoting", "pending"].includes(intent.status)) {
        quoteWait.current.reject(new Error("route_failed"));
        quoteWait.current = undefined;
      }
    }
    if (executeWait.current) {
      if (intent.status === "quoted" && intent.error) {
        executeWait.current.resolve({
          name: "xochi",
          state: "failed",
          recoverable: true,
          failure_code: "approval_rejected",
        });
        executeWait.current = undefined;
        attempted.current = false;
      } else if (!["quoted", "signing", "idle", "pending", "quoting"].includes(intent.status)) {
        executeWait.current.resolve(routeMachineStatus(intent));
        executeWait.current = undefined;
      }
    }
  }, [intent, options]);
  useEffect(
    () => () => {
      quoteWait.current?.reject(new Error("route_failed"));
      executeWait.current?.reject(new Error("xochi_in_doubt"));
      quoteWait.current = undefined;
      executeWait.current = undefined;
    },
    [],
  );
  return driver.current;
}
