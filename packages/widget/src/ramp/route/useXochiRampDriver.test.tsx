// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { XochiRampPreview, RampLegSnapshot, QuoteResponse } from "@xochi/client";
import { listLocalSwaps } from "../../lib/localActivity.js";
import {
  useXochiRampDriver,
  routeMachineStatus,
  type RampSwapInterpreter,
} from "./useXochiRampDriver.js";
import { ROUTE_RECEIVED, ROUTE_WALLET } from "../../test/routePort.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
/** In-memory implementation of the validated Swap interpreter, with no signing material. */
class MemorySwap implements RampSwapInterpreter {
  status: RampSwapInterpreter["status"] = "idle";
  quote: QuoteResponse | null = null;
  error: RampSwapInterpreter["error"] = null;
  canSign = false;
  intentId: string | null = null;
  tierName = "Standard";
  legsWithheld = null;
  txHash = null;
  receivingTxHash = null;
  settlementTxHash: string | null = null;
  settlementChainId = null;
  substatus = null;
  receipt: RampSwapInterpreter["receipt"] = { phase: "confirm" };
  quotes: string[] = [];
  refreshes: boolean[] = [];
  signatures = 0;
  resumes: string[] = [];
  requestQuote(amount: string) {
    this.quotes.push(amount);
  }
  refreshQuote(force = false) {
    this.refreshes.push(force);
  }
  reset() {
    this.quote = null;
    this.status = "idle";
    this.canSign = false;
  }
  sign() {
    this.signatures++;
    this.status = "signing";
    this.canSign = false;
    this.receipt = { phase: "awaiting-wallet" };
  }
  resume(id: string) {
    this.resumes.push(id);
    this.intentId = id;
    this.status = "executing";
    this.receipt = { phase: "submitting" };
  }
  quoted() {
    this.status = "quoted";
    this.canSign = true;
    this.intentId = "xochi_public_intent";
    this.quote = {
      success: true,
      intentId: this.intentId,
      quoteId: "xochi_public_quote",
      canSolve: true,
      toAmount: "24500000",
      minToAmount: "24300000",
      xochiFee: "500000",
      xochiFeeRate: "0.22",
      estimatedGasCost: "0",
      expiry: "2099-01-01T00:00:00Z",
      gasless: true,
      settlementOptions: [],
    };
  }
}
function options(intent: MemorySwap) {
  return {
    intent,
    pay: ROUTE_RECEIVED,
    receiveAsset: ROUTE_RECEIVED.asset,
    recipient: "Stealth recipient",
    settlement: "stealth" as const,
    authorized: true,
    operationId: "widget_operation",
    wallet: ROUTE_WALLET,
    payee: "other" as const,
  };
}
it("captures only public Activity facts before signing and tracks a wallet refusal", async () => {
  const machine = new MemorySwap();
  const { result, rerender } = renderHook(() => useXochiRampDriver(options(machine)));
  let quoted!: Promise<XochiRampPreview>;
  act(() => {
    quoted = result.current.quote();
  });
  expect(machine.quotes).toEqual(["25000000"]);
  expect(machine.refreshes).toEqual([true]);
  expect(listLocalSwaps(ROUTE_WALLET)).toHaveLength(0);
  await act(async () => {
    machine.quoted();
    rerender();
  });
  const preview = await quoted;
  let executed!: Promise<RampLegSnapshot>;
  act(() => {
    executed = result.current.execute(preview.quoteId);
  });
  const row = listLocalSwaps(ROUTE_WALLET)[0];
  expect(row.rampOperationId).toBe("widget_operation");
  expect(row.id).toBe("xochi_public_intent");
  expect(row.data.stealthPayee).toBe("other");
  expect(JSON.stringify(row)).not.toContain(preview.recipient);
  expect(JSON.stringify(row)).not.toContain("signature");
  expect(machine.signatures).toBe(1);
  await act(async () => {
    machine.status = "quoted";
    machine.error = "approval_rejected";
    machine.receipt = { phase: "confirm" };
    rerender();
  });
  expect((await executed).state).toBe("failed");
  expect(listLocalSwaps(ROUTE_WALLET)[0].intentStatus).toBe("failed");
});
it("reload polls the original Xochi intent and never quotes or signs again", async () => {
  const machine = new MemorySwap();
  const first = renderHook(() => useXochiRampDriver(options(machine)));
  let quote!: Promise<XochiRampPreview>;
  act(() => {
    quote = first.result.current.quote();
  });
  await act(async () => {
    machine.quoted();
    first.rerender();
  });
  const preview = await quote;
  let execution!: Promise<RampLegSnapshot>;
  act(() => {
    execution = first.result.current.execute(preview.quoteId);
  });
  await act(async () => {
    machine.status = "executing";
    machine.receipt = { phase: "submitting" };
    first.rerender();
  });
  expect((await execution).state).toBe("processing");
  first.unmount();
  const resumed = new MemorySwap();
  const second = renderHook(() =>
    useXochiRampDriver({ ...options(resumed), routeState: "in_doubt" }),
  );
  expect(resumed.resumes).toEqual(["xochi_public_intent"]);
  expect(resumed.quotes).toHaveLength(0);
  expect(resumed.signatures).toBe(0);
  expect((await second.result.current.poll()).state).toBe("processing");
  await act(async () => {
    resumed.status = "completed";
    resumed.receipt = { phase: "success" };
    resumed.settlementTxHash = `0x${"ab".repeat(32)}`;
    second.rerender();
  });
  expect((await second.result.current.poll()).state).toBe("completed");
  expect(listLocalSwaps(ROUTE_WALLET)[0].status).toBe("completed");
});
it("missing reload evidence remains in doubt without a new quote or wallet action", async () => {
  const machine = new MemorySwap();
  const { result } = renderHook(() =>
    useXochiRampDriver({ ...options(machine), routeState: "in_doubt" }),
  );
  expect((await result.current.poll()).state).toBe("in_doubt");
  expect(machine.quotes).toHaveLength(0);
  expect(machine.signatures).toBe(0);
  expect(machine.resumes).toHaveLength(0);
});
it.each(["pending", "not-sent", "may-have-moved", "awaiting-wallet"] as const)(
  "does not make a safe retry out of %s",
  (phase) => {
    expect(
      routeMachineStatus({ receipt: { phase }, settlementTxHash: null, receivingTxHash: null })
        .state,
    ).toBe("in_doubt");
  },
);
