// @vitest-environment jsdom

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { UseIntentReturn } from "../../hooks/useIntent.js";
import { DEFAULT_DESTINATION } from "../../types/intent.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { quoteWire } from "../../test/intentHarness.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { TEST_ACCOUNT, L1_STEALTH_CAPABILITIES, apiStub, renderTrade } from "./harness.js";
import { TOKENS } from "./config.js";
import { SwapPanel } from "./SwapPanel.js";
import { useSwapFlow, type UseSwapFlowResult } from "./useSwapFlow.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 4 }) });

const BASE = 8453;
const ARBITRUM = 42161;
const ETHEREUM = 1;
const noop = (): void => {};

type CapabilityRoute = {
  origin: { chain_id: number; token: string };
  destination: { kind: string; chain_id?: number; token: string };
  privacy_modes: string[];
};

type CapabilityEnvelope = {
  source: "live";
  capabilities: Record<string, unknown> & { routes: CapabilityRoute[] };
};

const liveCapabilities = L1_STEALTH_CAPABILITIES.body as CapabilityEnvelope;
const isSelectedRoute = (route: CapabilityRoute): boolean =>
  route.origin.chain_id === BASE &&
  route.origin.token === "USDC" &&
  route.destination.kind === "chain" &&
  route.destination.chain_id === ARBITRUM &&
  route.destination.token === "USDC";

const revokedCapabilities = (kind: "privacy" | "route"): CapabilityEnvelope => ({
  ...liveCapabilities,
  capabilities: {
    ...liveCapabilities.capabilities,
    routes:
      kind === "route"
        ? liveCapabilities.capabilities.routes.filter((route) => !isSelectedRoute(route))
        : liveCapabilities.capabilities.routes.map((route) =>
            isSelectedRoute(route) ? { ...route, privacy_modes: ["shielded"] } : route,
          ),
  },
});

const stealthOnlyCapabilities: CapabilityEnvelope = {
  ...liveCapabilities,
  capabilities: {
    ...liveCapabilities.capabilities,
    routes: liveCapabilities.capabilities.routes.map((route) =>
      route.origin.chain_id === BASE &&
      route.origin.token === "USDC" &&
      route.destination.kind === "chain" &&
      route.destination.chain_id === ETHEREUM &&
      route.destination.token === "USDC"
        ? { ...route, privacy_modes: ["stealth"] }
        : route,
    ),
  },
};

const signableQuote = (request: Record<string, unknown>) =>
  quoteWire({
    to_amount: "4990000",
    min_to_amount: "4965000",
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: request.from_chain_id },
      types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: request.wallet,
        fromChainId: request.from_chain_id,
        toChainId: request.to_chain_id,
        fromToken: request.from_token,
        toToken: request.to_token,
        fromAmount: request.from_amount,
        toAmount: "4990000",
        recipient: request.wallet,
        settlementPreference: request.settlement_preference,
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

function RefreshCapabilities() {
  const { retry } = useCapabilities();
  return <button onClick={retry}>Refresh capabilities</button>;
}

const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

const submitButton = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>(".submit-btn");
  if (!button) throw new Error("submit button not rendered");
  return button;
};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
});

describe("exact settlement authority", () => {
  it("does not request Public on a stealth-only exact route", async () => {
    let quoteCalls = 0;
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/capabilities": { body: stealthOnlyCapabilities },
        "/api/intent/quote": {
          answer: (request) => {
            quoteCalls += 1;
            return signableQuote(request as Record<string, unknown>);
          },
        },
      }),
    );

    const baseUsdc = TOKENS[BASE].find((token) => token.symbol === "USDC");
    const ethereumUsdc = TOKENS[ETHEREUM].find((token) => token.symbol === "USDC");
    if (!baseUsdc || !ethereumUsdc) throw new Error("USDC fixture missing");
    await renderTrade(
      <SwapPanel
        prefill={{
          nonce: 1,
          fromChainId: BASE,
          toChainId: ETHEREUM,
          fromToken: baseUsdc.address,
          toToken: ethereumUsdc.address,
          fromAmount: "",
          settlement: "public",
        }}
      />,
      {
        connected: true,
        walletChainId: BASE,
        tokenBalance: 10n ** 12n,
      },
    );
    await waitFor(
      () => expect(submitButton().textContent).toBe("Choose another privacy mode"),
      WAIT,
    );

    vi.useFakeTimers();
    fireEvent.change(payAmount(), { target: { value: "5" } });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(quoteCalls).toBe(0);
    expect(submitButton().disabled).toBe(true);
  });

  it.each(["privacy", "route"] as const)(
    "drops an open confirmation when %s authority is revoked",
    async (revocation) => {
      let capabilities = liveCapabilities;
      let executeCalls = 0;
      const walletMethods: string[] = [];
      const rest = apiStub(
        {
          "/api/intent/quote": {
            answer: (request) => signableQuote(request as Record<string, unknown>),
          },
        },
        { onWalletRpc: (method) => walletMethods.push(method) },
      );
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/capabilities")) {
          return Promise.resolve(
            new Response(JSON.stringify(capabilities), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/api/intent/execute")) executeCalls += 1;
        return rest(input, init);
      });

      await renderTrade(
        <>
          <SwapPanel />
          <RefreshCapabilities />
        </>,
        { connected: true, walletChainId: BASE, tokenBalance: 10n ** 12n },
      );
      fireEvent.change(payAmount(), { target: { value: "5" } });
      await waitFor(() => expect(submitButton().textContent).toBe("Swap USDC → USDC"), WAIT);
      fireEvent.click(submitButton());
      await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);

      capabilities = revokedCapabilities(revocation);
      fireEvent.click(screen.getByRole("button", { name: "Refresh capabilities" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
      expect(walletMethods).not.toContain("eth_signTypedData_v4");
      expect(executeCalls).toBe(0);
    },
  );
});

let latestFlow: UseSwapFlowResult | null = null;
let flowOpen = true;
let openAuthorityFlow = noop;
let revokeFlowAuthority = noop;

const flowIntent = (
  status: "quoted" | "executing",
  sign: () => void,
  reset: () => void,
): UseIntentReturn => ({
  status,
  quote: null,
  error: null,
  refundReason: null,
  txHash: null,
  receivingTxHash: null,
  settlementTxHash: null,
  settlementChainId: null,
  substatus: null,
  reconciling: false,
  intentId: "xi_authority",
  quoteId: "xq_authority",
  quotedAddress: TEST_ACCOUNT,
  quotedFromAmount: "5000000",
  attestedDeposit: null,
  pollExhausted: false,
  legsWithheld: null,
  receipt: {
    phase: status === "quoted" ? "confirm" : "submitting",
    quote: { kind: "ready", executable: true, refreshing: false, expiresInSec: 30 },
    payout: { kind: "none" },
    cost: { kind: "none" },
    settlement: {
      mode: "public",
      label: "Public",
      recipient: "visible",
      amount: "visible",
      recipientAction: "none",
    },
    signing: status === "quoted" ? { kind: "ready", signatures: 1 } : { kind: "submitted" },
  },
  isLoading: status === "executing",
  canSign: status === "quoted",
  canAllocateDepositRoute: false,
  feeRate: "0.22",
  tierName: "Standard",
  permitType: "none",
  approval: "none",
  isApproving: false,
  requestQuote: noop,
  allocateDepositRoute: () => Promise.resolve(false),
  sign,
  cancelSign: () => false,
  signPull: noop,
  reset,
  resume: noop,
  awaitingPull: false,
  isSigningPull: false,
  quoteExpiresIn: null,
  refreshQuote: noop,
  raceEvents: [],
  fillMs: null,
});

function FlowAuthorityProbe({
  sign,
  reset,
  status = "quoted",
}: {
  sign: () => void;
  reset: () => void;
  status?: "quoted" | "executing";
}) {
  const [authorized, setAuthorized] = useState(true);
  const [open, setOpen] = useState(false);
  openAuthorityFlow = () => setOpen(true);
  revokeFlowAuthority = () => setAuthorized(false);
  flowOpen = open;
  latestFlow = useSwapFlow({
    prefill: null,
    intent: flowIntent(status, sign, reset),
    isConnected: true,
    address: TEST_ACCOUNT,
    connectedChainId: BASE,
    fromChainId: BASE,
    toChainId: ARBITRUM,
    fromToken: TOKENS[BASE][0],
    toToken: TOKENS[ARBITRUM][0],
    routeCheck: { status: "supported" },
    applyRoute: noop,
    amount: "5",
    amountBigInt: 5_000_000n,
    insufficientBalance: false,
    currentBalance: 5_000_000n,
    excessiveSlippage: false,
    orderOutOfBounds: false,
    setAmount: noop,
    settlement: "public",
    settlementFix: authorized ? null : "route",
    destination: DEFAULT_DESTINATION,
    recipientMissing: false,
    recipientInvalid: false,
    restoreSettlement: noop,
    clearRecipient: noop,
    flowOpen: open,
    setFlowOpen: setOpen,
    resumed: null,
    setResumed: noop,
  });
  return null;
}

describe("confirmation dispatch boundary", () => {
  it("rechecks settlement authority immediately before sign", async () => {
    let signs = 0;
    let resets = 0;
    vi.stubGlobal("fetch", apiStub({}));
    await renderTrade(
      <FlowAuthorityProbe
        sign={() => {
          signs += 1;
        }}
        reset={() => {
          resets += 1;
        }}
      />,
      { connected: true },
    );

    act(() => openAuthorityFlow());
    act(() => revokeFlowAuthority());
    act(() => latestFlow?.handleConfirmSwap());

    expect(flowOpen).toBe(false);
    expect(resets).toBeGreaterThan(0);
    expect(signs).toBe(0);
  });

  it("does not cancel an order after execution may have dispatched", async () => {
    let resets = 0;
    vi.stubGlobal("fetch", apiStub({}));
    await renderTrade(
      <FlowAuthorityProbe
        status="executing"
        sign={noop}
        reset={() => {
          resets += 1;
        }}
      />,
      { connected: true },
    );
    act(() => openAuthorityFlow());

    act(() => revokeFlowAuthority());

    expect(flowOpen).toBe(true);
    expect(resets).toBe(0);
  });
});
