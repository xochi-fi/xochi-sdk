// @vitest-environment jsdom

/**
 * The execute read token (xochi#563) is served on a 200 and on a failed
 * execute that may have moved funds. Under SPEC §5.1 (0.11.0) it reveals
 * nothing past the status-only view, so this frame keeps no copy: it is never
 * stored, never sent as `X-Xochi-Read-Token`, and never surfaced by the hook.
 *
 * Only `fetch` is stubbed (src/test/intentHarness.tsx), plus the wallet's
 * `eth_signTypedData_v4`, which wagmi's mock connector sends through the same
 * `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import { STATUS_POLL_MS } from "@xochi/client";
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

const INTENT_ID = "33333333-3333-3333-3333-333333333333";
const SIGNATURE = `0x${"11".repeat(65)}`;
const PAST_DEBOUNCE_MS = 600;
const READ_TOKEN = `${"Ab3-_".repeat(8)}xyz`;

beforeEach(() => {
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

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const signableQuote = (request: Record<string, unknown>) =>
  quoteWire({
    intent_id: INTENT_ID,
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
        settlementPreference: "public",
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Quote and Confirm; the execute POST is answered by `execute`. */
async function confirmWith(execute: () => Response) {
  const config = createTestWagmiConfig();
  const api = stubApi((call: ApiCall) => {
    if (call.body?.method === "eth_signTypedData_v4") {
      return { jsonrpc: "2.0", id: call.body.id, result: SIGNATURE };
    }
    if (call.url.endsWith("/api/intent/quote")) return signableQuote(call.body ?? {});
    if (call.url.endsWith("/api/intent/execute")) return execute();
    if (call.url.endsWith("/status")) {
      return statusWire({ intent_id: INTENT_ID, status: "executing", legs_withheld: true });
    }
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const { result } = renderHook(
    () =>
      useIntent({
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        settlementPreference: "public",
        settlementAuthorized: true,
      }),
    { wrapper: testWrapper(config) },
  );
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
  });
  act(() => result.current.requestQuote(nextAmount()));
  await advance(PAST_DEBOUNCE_MS);
  expect(result.current.status).toBe("quoted");

  const executeCalls = () => api.calls.filter((c) => c.url.endsWith("/api/intent/execute"));
  act(() => result.current.sign());
  for (let i = 0; i < 10 && executeCalls().length === 0; i++) await advance(0);
  expect(executeCalls()).toHaveLength(1);
  await advance(STATUS_POLL_MS);
  return { result, api };
}

const dump = (storage: Storage): string =>
  Array.from({ length: storage.length }, (_, i) => {
    const key = storage.key(i) ?? "";
    return `${key}=${storage.getItem(key) ?? ""}`;
  }).join("\n");
const storedEverywhere = (): string => `${dump(localStorage)}\n${dump(sessionStorage)}`;

describe("execute read token", () => {
  it.each([
    [
      "a 200",
      () =>
        json(
          { success: true, intent_id: INTENT_ID, status: "executing", read_token: READ_TOKEN },
          200,
        ),
    ],
    [
      "a 502 that may have moved funds",
      () =>
        json(
          {
            success: false,
            intent_id: INTENT_ID,
            status: "executing",
            error: "solver",
            read_token: READ_TOKEN,
          },
          502,
        ),
    ],
  ])("is neither kept nor sent when %s carries it", async (_label, execute) => {
    const { result, api } = await confirmWith(execute);

    expect(result.current.status).toBe("executing");
    expect(api.statusPolls.length).toBeGreaterThan(0);
    for (const poll of api.statusPolls) {
      expect(poll.headers).not.toHaveProperty("x-xochi-read-token");
      expect(poll.url).not.toContain(READ_TOKEN);
    }
    expect(JSON.stringify(result.current)).not.toContain(READ_TOKEN);
    expect(storedEverywhere()).not.toContain(READ_TOKEN);
    // The status-only view is tolerated: the legs are reported withheld.
    expect(result.current.legsWithheld).toBe(true);
  });
});
