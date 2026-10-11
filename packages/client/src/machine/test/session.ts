/**
 * Test support: a scripted host for the machine. No mocks: it calls `update`
 * and `view` exactly as the React interpreter does, with a clock the test owns,
 * and records every message so a session can be replayed.
 */

import type { Eip712TypedData } from "../../shared/index.js";
import {
  init,
  update,
  type ApiCall,
  type Context,
  type Effect,
  type MachineConfig,
  type Model,
  type Msg,
  type MsgBody,
  type WalletCall,
} from "../machine.js";
import { view } from "../view.js";
import type { Receipt } from "../receipt.js";
import type { IntentStatusData, QuoteResponse } from "../wire.js";

export const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
export const WALLET = "0x1111111111111111111111111111111111111111";
export const SOLVER = "0x0000000000000000000000000000000000005011";
export const ATTACKER = "0x000000000000000000000000000000000000dEaD";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
export const AMOUNT = "1000000";
export const TO_AMOUNT = "500000000000000";

export const CONFIG: MachineConfig = {
  solverPin: { erc3009Allowlist: [SOLVER.toLowerCase()], permit2Allowlist: [], requirePin: true },
  depositAttestationSigner: null,
};

/**
 * The intent deadline the fixtures serve: an hour past T0. The signer bounds it
 * against the WALL clock (no lower bound, an upper bound of an hour ahead), and
 * T0 is in the past, so this is always inside it.
 */
const INTENT_DEADLINE = Math.floor(T0 / 1000) + 3600;

export function ctx(over: Partial<Context> = {}, wallet: Partial<Context["wallet"]> = {}): Context {
  return {
    fromChainId: 8453,
    toChainId: 42161,
    fromToken: USDC_BASE,
    toToken: WETH_ARBITRUM,
    settlementPreference: "public",
    trustScore: 0,
    slippageBps: 50,
    recipientAddress: null,
    refundAddress: null,
    stealthMetaAddress: null,
    paused: false,
    ...over,
    wallet: { address: WALLET, chainId: 8453, stepwise: false, ...wallet },
  };
}

/** A full XochiIntent v3 message for the default `ctx()` trade. */
export function intentTypedData(over: Record<string, unknown> = {}): Eip712TypedData {
  return {
    domain: { name: "Xochi", version: "3", chainId: 8453 },
    types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
    primaryType: "XochiIntent",
    message: {
      wallet: WALLET,
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: USDC_BASE,
      toToken: WETH_ARBITRUM,
      fromAmount: AMOUNT,
      toAmount: TO_AMOUNT,
      recipient: WALLET,
      settlementPreference: "public",
      deadline: INTENT_DEADLINE,
      ...over,
    },
  };
}

export function erc3009Pull(to = SOLVER, value = AMOUNT): Eip712TypedData {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    types: { ReceiveWithAuthorization: [{ name: "to", type: "address" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: WALLET, to, value, validAfter: 0, validBefore: INTENT_DEADLINE + 300 },
  };
}

/** A solvable, executable Base USDC -> Arbitrum WETH quote, expiring 60s after `now`. */
export function quote(over: Partial<QuoteResponse> = {}, now = T0): QuoteResponse {
  return {
    success: true,
    intentId: "xi_1",
    quoteId: "xq_1",
    canSolve: true,
    toAmount: TO_AMOUNT,
    minToAmount: "497500000000000",
    xochiFee: "0",
    xochiFeeRate: "0.0022",
    costBps: 22,
    estimatedGasCost: "",
    expiry: new Date(now + 60_000).toISOString(),
    gasless: true,
    paymentMethod: "erc3009",
    eip712Data: intentTypedData(),
    settlementOptions: [],
    ...over,
  };
}

export function statusData(over: Partial<IntentStatusData> = {}): IntentStatusData {
  return {
    intentId: "xi_1",
    status: "executing",
    txHash: null,
    receivingTxHash: null,
    settlementTxHash: null,
    settlementChainId: null,
    error: null,
    refundReason: null,
    substatus: null,
    terminal: false,
    ...over,
  };
}

export function apiCalls<Op extends ApiCall["op"]>(fx: Effect[], op: Op) {
  return fx.flatMap((e) =>
    e.type === "Api" && e.call.op === op ? [e.call as Extract<ApiCall, { op: Op }>] : [],
  );
}

export function walletCalls<Op extends WalletCall["op"]>(fx: Effect[], op: Op) {
  return fx.flatMap((e) =>
    e.type === "Wallet" && e.call.op === op ? [e.call as Extract<WalletCall, { op: Op }>] : [],
  );
}

export function logs(fx: Effect[], level?: "debug" | "warn" | "error"): string[] {
  return fx.flatMap((e) =>
    e.type === "Emit" && e.event.kind === "log" && (!level || e.event.level === level)
      ? [e.event.message]
      : [],
  );
}

/** Exactly one effect of a kind, or the test fails loudly. */
export function only<T>(items: T[]): T {
  if (items.length !== 1) throw new Error(`expected exactly one, got ${items.length}`);
  return items[0];
}

export interface Step {
  msg: Msg;
  effects: Effect[];
  receipt: Receipt;
}

/** A host with a test-owned clock that records every step. */
export class Session {
  model: Model;
  now: number;
  hidden = false;
  readonly steps: Step[] = [];

  constructor(context: Context = ctx(), config: MachineConfig = CONFIG, now = T0) {
    this.model = init(config, context);
    this.now = now;
  }

  send(body: MsgBody, advanceMs = 0): Effect[] {
    this.now += advanceMs;
    const msg = { ...body, now: this.now, hidden: this.hidden } as Msg;
    const [model, effects] = update(this.model, msg);
    this.model = model;
    this.steps.push({ msg, effects, receipt: view(model) });
    return effects;
  }

  get receipt(): Receipt {
    return view(this.model);
  }

  get intent() {
    return this.model.intent;
  }

  /** Type an amount and let the debounce fire; returns the quote request. */
  requestQuote(amount = AMOUNT): Extract<ApiCall, { op: "quote" }> {
    this.send({ type: "QuoteRequested", amount });
    return only(apiCalls(this.send({ type: "TimerFired", timer: "debounce" }, 500), "quote"));
  }

  /** Quote and answer with `served`; returns the reply's effects. */
  quoteWith(served: QuoteResponse, amount = AMOUNT): Effect[] {
    const call = this.requestQuote(amount);
    return this.send({
      type: "QuoteReplied",
      flight: call.flight,
      result: { ok: true, quote: served },
    });
  }
}
