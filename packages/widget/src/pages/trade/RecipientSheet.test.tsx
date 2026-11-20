// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConfig, custom } from "wagmi";
import { connect } from "wagmi/actions";
import { arbitrum, base, mainnet } from "wagmi/chains";
import { RecipientSheet, recipientIssue } from "./RecipientSheet.js";
import { readRecentRecipients, rememberRecipient } from "../../lib/recipient/recent.js";
import { useIntent } from "../../hooks/useIntent.js";
import { intentAPI } from "../../lib/intentAPI.js";
import {
  createTestWagmiConfig,
  nextAmount,
  quoteWire,
  stubApi,
  TEST_WALLET,
  testWrapper,
  USDC_BASE,
  WETH_ARBITRUM,
} from "../../test/intentHarness.js";

const SPENDING = "0378e5ded02b8d6dd3613cce1ae68138aeab4bb41da113e01fc92c5b6a735e7a61";
const VIEWING = "02b41dfecfb89ce7052c0feb6077aab98e5242d98ae1449ac33a39003647e2deef";
const META = `st:eth:0x${SPENDING}${VIEWING}`;
const CUSTOM_RECIPIENT = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  intentAPI.clearQuoteCache();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it("resolves a recent meta-address and selects it for Stealth", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const transport = custom({
    request: async () => {
      throw new Error("Unexpected RPC");
    },
  });
  const config = createConfig({
    chains: [mainnet],
    transports: { [mainnet.id]: transport },
    multiInjectedProviderDiscovery: false,
    storage: null,
  });
  rememberRecipient({ kind: "stealth_meta", input: META });
  render(<RecipientSheet selected={null} mode="stealth" onSelect={onSelect} onClose={onClose} />, {
    wrapper: testWrapper(config),
  });

  expect(screen.getByRole("textbox", { name: "Name or address" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /st:eth/ }));
  expect(screen.getByRole("status").textContent).toBe("Resolving…");
  await advance(250);
  fireEvent.click(screen.getByRole("button", { name: "Use recipient" }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ stealthMetaAddress: META }),
    undefined,
  );
  expect(readRecentRecipients()).toEqual([META]);
  fireEvent.click(screen.getByRole("button", { name: "Use my wallet" }));
  expect(onSelect).toHaveBeenLastCalledWith(null, undefined);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("keeps recipients in their supported settlement modes", () => {
  const alice = {
    kind: "ens",
    input: "alice.eth",
    name: "alice.eth",
    address: CUSTOM_RECIPIENT,
  } as const;
  expect(recipientIssue(alice, "stealth")).toBe("alice.eth hasn't set up stealth receiving");
  expect(recipientIssue(alice, "public")).toBeNull();
  expect(recipientIssue(alice, "shielded")).toBe("Enter a zk.money alias for Shielded.");
});

it.each([
  [CUSTOM_RECIPIENT, CUSTOM_RECIPIENT, true],
  [CUSTOM_RECIPIENT, TEST_WALLET, false],
  [undefined, CUSTOM_RECIPIENT, false],
  [undefined, TEST_WALLET, true],
])(
  "authorizes only the requested Public recipient (%s, served %s)",
  async (requested, served, accepted) => {
    const config = createTestWagmiConfig();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = stubApi(({ body }) =>
      quoteWire({
        recipient_address: requested,
        eip712: {
          domain: { name: "Xochi", version: "3", chainId: base.id },
          types: { XochiIntent: [{ name: "recipient", type: "address" }] },
          primaryType: "XochiIntent",
          message: {
            wallet: TEST_WALLET,
            fromChainId: base.id,
            toChainId: arbitrum.id,
            fromToken: USDC_BASE,
            toToken: WETH_ARBITRUM,
            fromAmount: body?.from_amount,
            toAmount: "500000000000000",
            recipient: served,
            settlementPreference: "public",
            deadline: Math.floor(Date.now() / 1000) + 300,
          },
        },
      }),
    );
    const { result } = renderHook(
      () =>
        useIntent({
          fromChainId: base.id,
          toChainId: arbitrum.id,
          fromToken: USDC_BASE,
          toToken: WETH_ARBITRUM,
          settlementPreference: "public",
          settlementAuthorized: true,
          recipientAddress: requested,
        }),
      { wrapper: testWrapper(config) },
    );

    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    act(() => result.current.requestQuote(nextAmount()));
    await advance(600);
    expect(api.quotes).toHaveLength(1);
    expect(api.quotes[0].body?.recipient_address).toBe(requested);
    expect(result.current.canSign).toBe(accepted);
    expect(result.current.quote?.eip712Data?.message.recipient).toBe(accepted ? served : undefined);
  },
);
