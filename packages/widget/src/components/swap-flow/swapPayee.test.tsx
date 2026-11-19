// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Config } from "wagmi";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Trade } from "../../pages/Trade.js";
import { findTokenBySymbol } from "../../pages/trade/config.js";
import { FULL_LOOK } from "../../pages/trade/embedParams.js";
import { apiStub, renderTrade, TEST_ACCOUNT } from "../../pages/trade/harness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { upsertLocalSwap } from "../../lib/localActivity.js";
import { upsertLocalSend } from "../../lib/localSends.js";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { testBudget, WAIT } from "../../test/waitBudget.js";
import { SwapResult } from "./SwapResult.js";
import type { SwapActivityItem } from "../../types/activity.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 5 }) });

const name = "alice.eth";
const address = "0x2222222222222222222222222222222222222222";
const fromToken = findTokenBySymbol(8453, "USDC")!.address;
const toToken = findTokenBySymbol(42161, "USDC")!.address;
const amount = "5000001";
const recipientLookup = (config: Config) => {
  const resolve = vi.fn();
  for (const chain of config.chains) {
    const client = config.getClient({ chainId: chain.id });
    const request = client.request;
    vi.spyOn(client, "request").mockImplementation((args, options) => {
      const { method, params } = args as {
        method: string;
        params?: [{ to?: string; data?: string }];
      };
      if (method === "eth_getCode") return Promise.resolve("0x");
      const call = method === "eth_call" ? params?.[0] : undefined;
      const target = call?.to?.toLowerCase();
      if (
        target === mainnet.contracts.ensUniversalResolver.address.toLowerCase() ||
        target === "0x64969fb44091a7e5fa1213d30d7a7e8488edf693"
      ) {
        const isAddress = call?.data?.includes("3b3b57de");
        if (isAddress) resolve();
        const answer = isAddress
          ? encodeAbiParameters(parseAbiParameters("address"), [address])
          : "0x";
        return Promise.resolve(
          encodeAbiParameters(parseAbiParameters("bytes, address"), [answer, address]),
        );
      }
      return request(args, options);
    });
  }
  return resolve;
};
const trade = (initialTab: "trade" | "activity" = "activity") => (
  <Trade look={FULL_LOOK} hostConnection={null} embed={{ initialTab }} />
);
const order = (data: Partial<SwapActivityItem["data"]> = {}): SwapActivityItem => ({
  id: "fixture-swap",
  type: "swap",
  timestamp: Date.now(),
  status: "failed",
  intentStatus: "failed",
  data: {
    fromChainId: 8453,
    toChainId: 42161,
    fromToken,
    toToken,
    fromAmount: amount,
    toAmount: "4990000",
    settlementType: "public",
    isCrossChain: true,
    txHash: null,
    tier: "Standard",
    feeRate: 0.22,
    substatus: "not_executed",
    ...data,
  },
});
const quotes = vi.fn((body) =>
  quoteWire({
    to_amount: "4990000",
    min_to_amount: "4990000",
    recipient_address: body.recipient_address,
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: body.from_chain_id },
      types: { XochiIntent: [{ name: "recipient", type: "address" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: TEST_ACCOUNT,
        fromChainId: body.from_chain_id,
        toChainId: body.to_chain_id,
        fromToken: body.from_token,
        toToken: body.to_token,
        fromAmount: body.from_amount,
        toAmount: "4990000",
        recipient: body.recipient_address ?? TEST_ACCOUNT,
        settlementPreference: "public",
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  }),
);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  intentAPI.clearQuoteCache();
  quotes.mockClear();
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": { answer: quotes },
      "/status": {
        body: statusWire({ intent_id: "fixture-swap", status: "failed", terminal: true }),
      },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

async function retry(label: string | RegExp) {
  const action = await screen.findByText(label, { selector: ".activity-action" }, WAIT);
  fireEvent.click(action.closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
}

it.each([true, false])("reviews a restored swap (other recipient: %s)", async (other) => {
  upsertLocalSwap(
    TEST_ACCOUNT,
    order(
      other
        ? {
            swapRecipientLabel: name,
            swapRecipientRetryInput: name,
          }
        : {},
    ),
  );
  const { config } = await renderTrade(trade(), {
    connected: true,
    walletChainId: 8453,
    tokenBalance: 10_000_000n,
  });
  const lookup = recipientLookup(config);

  await retry(other ? "Swap · to alice.eth" : "Swap");
  const payout = other ? "alice.eth receives" : "Receive";
  await screen.findByText(`${payout} 4.99 USDC, paid as quoted or fully refunded.`, {}, WAIT);
  expect(lookup).toHaveBeenCalledTimes(other ? 1 : 0);
  expect(quotes.mock.lastCall?.[0].recipient_address).toBe(other ? address : undefined);
  expect(quotes.mock.lastCall?.[0].from_amount).toBe(amount);
  const cta = screen.getByRole("button", { name: other ? "Swap to alice.eth" : "Bridge USDC" });
  fireEvent.click(cta);
  expect(
    await screen.findByRole(
      "dialog",
      { name: other ? "Confirm swap to alice.eth" : "Confirm swap" },
      WAIT,
    ),
  ).toBeTruthy();
});

it("restores a zk.money alias and preserves the Shielded asset", async () => {
  const tag = "memory-rocky";
  const dai = findTokenBySymbol(1, "DAI")!.address;
  upsertLocalSwap(
    TEST_ACCOUNT,
    order({
      toToken: dai,
      toChainId: 1,
      recipientTag: tag,
      swapRecipientLabel: `@${tag}`,
      swapRecipientRetryInput: `@${tag}`,
    }),
  );
  const { config } = await renderTrade(trade(), {
    connected: true,
    walletChainId: 8453,
    tokenBalance: 10_000_000n,
  });
  recipientLookup(config);
  await retry(/Swap · to @memory-rocky/);
  await screen.findByRole("button", { name: "To: memory-rocky.zk.money" }, WAIT);
  expect(screen.getByRole("button", { name: /^Shielded/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByText("Receive changes to DAI on zk.money.")).toBeTruthy();
  expect(screen.getByLabelText("Pay")).toHaveProperty("value", "5.000001");
});

it("asks for a raw Stealth payee again before issuing any quote", async () => {
  upsertLocalSwap(
    TEST_ACCOUNT,
    order({
      settlementType: "stealth",
      stealthPayee: "other",
      swapRecipientLabel: "st:eth:0x0123…4567",
      swapRecipientRetryInput: "st:eth:0x0123",
    }),
  );
  await renderTrade(trade(), { connected: true, walletChainId: 8453, tokenBalance: 10_000_000n });
  await retry(/Swap · to st:eth/);
  const dialog = await screen.findByRole("dialog", { name: "To" }, WAIT);
  expect(within(dialog).getByRole("textbox", { name: "Name or address" })).toHaveProperty(
    "value",
    "",
  );
  expect(screen.getByText("Choose the recipient again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByLabelText("Pay")).toHaveProperty("value", "5.000001");
  expect(quotes).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(quotes).not.toHaveBeenCalled();
});

it.each([true, false])(
  "shows completion and Activity for the original payee (other: %s)",
  async (other) => {
    await renderTrade(trade("trade"), { connected: true });
    const dispatch = order(other ? { swapRecipientLabel: name } : {});
    act(() =>
      upsertLocalSwap(TEST_ACCOUNT, {
        ...dispatch,
        status: "pending",
        intentStatus: "settling",
      }),
    );
    act(() =>
      upsertLocalSwap(TEST_ACCOUNT, {
        ...dispatch,
        status: "completed",
        intentStatus: "completed",
      }),
    );
    expect(
      screen.getByText(other ? "Sent to alice.eth" : "USDC to USDC swap complete"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      await screen.findByText(
        other ? "Swap · to alice.eth" : "Swap",
        {
          selector: ".activity-action",
        },
        WAIT,
      ),
    ).toBeTruthy();
  },
);

it("uses the same payee heading and a mode for every Send row", async () => {
  const hash = `0x${"12".repeat(32)}`;
  upsertLocalSend(TEST_ACCOUNT, {
    id: hash,
    type: "send",
    timestamp: Date.now(),
    status: "completed",
    data: {
      chainId: 8453,
      token: fromToken,
      symbol: "USDC",
      decimals: 6,
      amount,
      recipient: address,
      txHash: hash,
    },
  });
  for (const mode of ["Stealth", "Shielded"] as const) {
    upsertLocalSwap(TEST_ACCOUNT, {
      ...order({ sendRecipientDisplay: { mode, label: mode === "Stealth" ? name : "@alice" } }),
      id: mode,
      status: "completed",
      intentStatus: "completed",
    });
  }
  await renderTrade(trade(), { connected: true });
  for (const [label, mode] of [
    ["Send · to 0x2222", "Public"],
    ["Send · to alice.eth", "Stealth"],
    ["Send · to @alice", "Shielded"],
  ]) {
    const heading = await screen.findByText(new RegExp(label), {}, WAIT);
    const row = heading.closest(".send-activity__row, .activity-row");
    expect(within(row as HTMLElement).getByText(mode)).toBeTruthy();
  }
});

it.each([true, false])("marks only an incoming result with a plus (other: %s)", (other) => {
  render(
    <SwapResult
      variant="success"
      swapRecipientLabel={other ? name : undefined}
      fromChainId={8453}
      toChainId={42161}
      isCrossChain
      txHash={null}
      receivedAmount="4.99"
      toSymbol="USDC"
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("heading", { name: other ? "Sent to alice.eth" : "Swap complete" }),
  ).toBeTruthy();
  expect(screen.getByText(other ? "4.99 USDC" : "+4.99 USDC")).toBeTruthy();
});
