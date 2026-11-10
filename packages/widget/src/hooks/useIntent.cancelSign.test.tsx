// @vitest-environment jsdom

/**
 * Cancelling a wallet prompt that never answers, end to end through the real
 * `@xochi/client` machine and this frame's runtime. Only `fetch` is stubbed
 * (src/test/intentHarness.tsx), including the wallet's `eth_signTypedData_v4`,
 * which wagmi's mock connector sends through it; holding that request open is
 * a dismissed wallet prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import { useIntent } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  quoteWire,
  statusWire,
  nextAmount,
  TEST_WALLET,
  USDC_BASE,
  WETH_ARBITRUM,
  type ApiCall,
} from "../test/intentHarness.js";

const INTENT_ID = "66666666-6666-6666-6666-666666666666";
const REPLACEMENT_INTENT_ID = "77777777-7777-7777-7777-777777777777";
const REPLACEMENT_QUOTE_ID = "88888888-8888-8888-8888-888888888888";
const SIGNATURE = `0x${"11".repeat(65)}`;
const PULL_RECIPIENT = "0x3333333333333333333333333333333333333333";
const PAST_DEBOUNCE_MS = 600;
let quoteSequence = 0;
let servePull = false;

beforeEach(() => {
  quoteSequence = 0;
  servePull = false;
  intentAPI.clearQuoteCache();
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signableQuote = (request: Record<string, unknown>) => {
  quoteSequence += 1;
  const ids = {
    intent_id: quoteSequence === 1 ? INTENT_ID : REPLACEMENT_INTENT_ID,
    quote_id: quoteSequence === 1 ? "22222222-2222-2222-2222-222222222222" : REPLACEMENT_QUOTE_ID,
  };
  if (request.preview === true) return quoteWire({ ...ids, preview: true });
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return quoteWire({
    ...ids,
    payment_method: "erc3009",
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: base.id },
      types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: TEST_WALLET,
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        fromAmount: request.from_amount,
        toAmount: "500000000000000",
        recipient: TEST_WALLET,
        settlementPreference: request.settlement_preference,
        deadline,
      },
    },
    ...(servePull
      ? {
          pull_authorization: {
            domain: {
              name: "USD Coin",
              version: "2",
              chainId: base.id,
              verifyingContract: USDC_BASE,
            },
            types: { ReceiveWithAuthorization: [{ name: "to", type: "address" }] },
            primaryType: "ReceiveWithAuthorization",
            message: {
              from: TEST_WALLET,
              to: PULL_RECIPIENT,
              value: request.from_amount,
              validAfter: 0,
              validBefore: deadline + 300,
            },
          },
        }
      : {}),
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Quote and Confirm; the wallet's signature is `wallet()`'s answer. */
async function confirmWith(
  wallet: (call: ApiCall) => unknown,
  options: { stepwise?: boolean; withPull?: boolean } = {},
) {
  servePull = options.withPull === true;
  const config = createTestWagmiConfig();
  if (options.stepwise) {
    Object.defineProperty(config.connectors[0], "id", { value: "walletConnect" });
    Object.defineProperty(config.connectors[0], "type", { value: "walletConnect" });
  }
  const api = stubApi((call: ApiCall) => {
    if (call.body?.method === "eth_signTypedData_v4") return wallet(call);
    if (call.url.endsWith("/api/intent/quote")) return signableQuote(call.body ?? {});
    if (call.url.endsWith("/api/intent/execute")) {
      return { success: true, intent_id: INTENT_ID, status: "executing" };
    }
    if (call.url.endsWith("/status")) return statusWire({ intent_id: INTENT_ID });
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const { result, rerender } = renderHook(
    ({
      authorized,
      settlement,
      paused,
    }: {
      authorized: boolean;
      settlement: "public" | "stealth";
      paused: boolean;
    }) =>
      useIntent({
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        settlementPreference: settlement,
        settlementAuthorized: authorized,
        paused,
      }),
    {
      initialProps: {
        authorized: true,
        settlement: "public" as "public" | "stealth",
        paused: false,
      },
      wrapper: testWrapper(config),
    },
  );
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
  });
  act(() => result.current.requestQuote(nextAmount()));
  await advance(PAST_DEBOUNCE_MS);
  expect(result.current.status).toBe("quoted");
  act(() => result.current.sign());
  const executeCalls = () => api.calls.filter((c) => c.url.endsWith("/api/intent/execute"));
  return { result, rerender, api, executeCalls };
}

describe("cancelSign", () => {
  it("ends a pending prompt, and a late wallet answer executes nothing", async () => {
    let answer: (signature: string) => void = () => {};
    const { result, api, executeCalls } = await confirmWith(
      (call) =>
        new Promise((resolve) => {
          answer = (signature) => resolve({ jsonrpc: "2.0", id: call.body?.id, result: signature });
        }),
    );
    for (let i = 0; i < 10 && !api.calls.some((c) => c.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    let took = false;
    act(() => {
      took = result.current.cancelSign();
    });
    expect(took).toBe(true);
    expect(result.current.status).toBe("quoted");

    answer(SIGNATURE);
    await advance(0);
    await advance(0);
    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).toBe("quoted");
  });
  it("rejects a wallet answer that loses route authority before returning", async () => {
    let answer: (signature: string) => void = () => {};
    const { result, rerender, api, executeCalls } = await confirmWith(
      (call) =>
        new Promise((resolve) => {
          answer = (signature) => resolve({ jsonrpc: "2.0", id: call.body?.id, result: signature });
        }),
    );
    for (let i = 0; i < 10 && !api.calls.some((call) => call.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    act(() => {
      rerender({ authorized: false, settlement: "public", paused: false });
      answer(SIGNATURE);
    });
    await advance(0);
    await advance(0);

    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).not.toBe("executing");
  });

  it("rejects a wallet answer after the authorized settlement changes", async () => {
    let answer: (signature: string) => void = () => {};
    const { result, rerender, api, executeCalls } = await confirmWith(
      (call) =>
        new Promise((resolve) => {
          answer = (signature) => resolve({ jsonrpc: "2.0", id: call.body?.id, result: signature });
        }),
    );
    for (let i = 0; i < 10 && !api.calls.some((call) => call.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    act(() => {
      rerender({ authorized: true, settlement: "stealth", paused: false });
      answer(SIGNATURE);
    });
    await advance(0);
    await advance(0);

    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.quote).toBeNull();
  });

  it("discards a quote when its context changes before the wallet answers", async () => {
    const { result, rerender, api, executeCalls } = await confirmWith(
      () => new Promise(() => undefined),
    );
    for (let i = 0; i < 10 && !api.calls.some((call) => call.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    rerender({ authorized: true, settlement: "stealth", paused: false });
    await advance(0);

    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.quote).toBeNull();
  });

  it("discards the old quote when a stale wallet prompt is rejected", async () => {
    let rejectWallet: (error: Error) => void = () => {};
    const { result, rerender, api, executeCalls } = await confirmWith(
      () =>
        new Promise((_resolve, reject) => {
          rejectWallet = reject;
        }),
    );
    for (let i = 0; i < 10 && !api.calls.some((call) => call.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    act(() => {
      rerender({ authorized: true, settlement: "stealth", paused: false });
      rejectWallet(new Error("wallet request rejected"));
    });
    await advance(0);
    await advance(0);

    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.quote).toBeNull();
  });

  it("preserves a replacement quote when the old wallet prompt answers late", async () => {
    let answer: (signature: string) => void = () => {};
    const { result, rerender, api, executeCalls } = await confirmWith(
      (call) =>
        new Promise((resolve) => {
          answer = (signature) => resolve({ jsonrpc: "2.0", id: call.body?.id, result: signature });
        }),
    );
    for (let i = 0; i < 10 && !api.calls.some((call) => call.body?.method); i++) await advance(0);
    expect(result.current.status).toBe("signing");

    act(() => {
      expect(result.current.cancelSign()).toBe(true);
    });
    rerender({ authorized: true, settlement: "public", paused: true });
    await advance(0);
    act(() => result.current.requestQuote(nextAmount()));
    await advance(PAST_DEBOUNCE_MS);
    expect(result.current.status).toBe("quoted");
    const replacementAmount = result.current.quotedFromAmount;
    expect(replacementAmount).toBeTruthy();

    act(() => answer(SIGNATURE));
    await advance(0);
    await advance(0);

    expect(executeCalls()).toHaveLength(0);
    expect(result.current.status).toBe("quoted");
    expect(result.current.quotedFromAmount).toBe(replacementAmount);
  });

  it("invalidates WalletConnect step two when route authority changes", async () => {
    const { result, rerender, executeCalls } = await confirmWith(
      (call) => ({ jsonrpc: "2.0", id: call.body?.id, result: SIGNATURE }),
      { stepwise: true, withPull: true },
    );
    for (let i = 0; i < 10 && !result.current.awaitingPull; i++) await advance(0);
    expect(result.current.status).toBe("signing");
    expect(result.current.awaitingPull).toBe(true);
    expect(executeCalls()).toHaveLength(0);

    rerender({ authorized: false, settlement: "public", paused: false });
    await advance(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.quote).toBeNull();
    expect(result.current.awaitingPull).toBe(false);

    rerender({ authorized: true, settlement: "stealth", paused: false });
    await advance(0);
    act(() => result.current.signPull());
    await advance(0);
    expect(executeCalls()).toHaveLength(0);
  });

  it("is refused once the execute is out", async () => {
    const { result, executeCalls } = await confirmWith((call) => ({
      jsonrpc: "2.0",
      id: call.body?.id,
      result: SIGNATURE,
    }));
    for (let i = 0; i < 10 && executeCalls().length === 0; i++) await advance(0);
    expect(executeCalls()).toHaveLength(1);
    expect(result.current.status).not.toBe("signing");

    let took = true;
    act(() => {
      took = result.current.cancelSign();
    });
    expect(took).toBe(false);
    expect(executeCalls()).toHaveLength(1);
  });
});
