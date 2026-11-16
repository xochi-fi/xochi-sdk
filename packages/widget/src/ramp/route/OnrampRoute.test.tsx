// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { OnrampRoute } from "./OnrampRoute.js";
import { routeHarness, ROUTE_RECEIVED, ROUTE_WALLET } from "../../test/routePort.js";
import { apiStub, renderTrade } from "../../pages/trade/harness.js";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import vectors from "../../lib/reverse-stealth-vectors.json";
import { WAIT } from "../../test/waitBudget.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
});
function Route({ h }: { h: Awaited<ReturnType<typeof routeHarness>> }) {
  const [snapshot, setSnapshot] = useState(h.snapshot);
  return (
    <OnrampRoute
      snapshot={snapshot}
      onSnapshot={setSnapshot}
      store={h.store}
      peer={h.peer}
      received={ROUTE_RECEIVED}
      wallet={ROUTE_WALLET}
    />
  );
}
/** Unsigned response bound to exactly the request; existing Swap signer checks ingest it. */
function quoted(request: Record<string, unknown>, serial: number) {
  return quoteWire({
    quote_id: `route-quote-${serial}`,
    to_amount: "24500000",
    min_to_amount: "24300000",
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
        toAmount: "24500000",
        recipient: request.wallet,
        settlementPreference: request.settlement_preference,
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });
}
it("uses the real Swap quote interpreter, requests fresh on review and sends no Peer facts", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": {
        answer: (body) => {
          const request = body as Record<string, unknown>;
          requests.push(request);
          return quoted(request, requests.length);
        },
      },
    }),
  );
  const h = await routeHarness();
  await renderTrade(<Route h={h} />, { connected: true, walletChainId: 8453 });
  await waitFor(
    () =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Review fresh Xochi quote" })
          .disabled,
      ).toBe(false),
    WAIT,
  );
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Review fresh Xochi quote" }));
  await screen.findByText("Route receives after fees", {}, WAIT);
  expect(requests).toHaveLength(1);
  expect(requests[0].from_amount).toBe("25000000");
  expect(requests[0].from_chain_id).toBe(8453);
  expect(JSON.stringify(requests)).not.toContain(h.snapshot.operation_id);
  expect(JSON.stringify(requests)).not.toContain("peer");
  expect(h.peer.calls).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Review fresh Xochi quote" }));
  await waitFor(() => expect(requests).toHaveLength(2), WAIT);
  await waitFor(
    () =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Approve wallet: route Base USDC with Xochi",
        }).disabled,
      ).toBe(false),
    WAIT,
  );
  expect(h.peer.calls).toBe(0);
});
it("reuses PR 201 meta-address parsing without deriving this wallet's keys", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": {
        answer: (body) => {
          const request = body as Record<string, unknown>;
          requests.push(request);
          return quoted(request, requests.length);
        },
      },
    }),
  );
  const h = await routeHarness();
  await renderTrade(<Route h={h} />, { connected: true, walletChainId: 8453 });
  await waitFor(
    () =>
      expect(
        screen.getByRole<HTMLSelectElement>("combobox", { name: "Receive asset and network" })
          .options.length,
      ).toBeGreaterThan(0),
    WAIT,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Settlement" }), {
    target: { value: "stealth" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Stealth recipient" }), {
    target: { value: "other" },
  });
  expect(screen.queryByRole("button", { name: "Set up my Stealth keys" })).toBeNull();
  const address = `st:eth:0x${vectors[0].spending_pub.replace(/^0x/, "")}${vectors[0].viewing_pub.replace(/^0x/, "")}`;
  fireEvent.change(screen.getByLabelText(/Recipient's Stealth meta-address/), {
    target: { value: address },
  });
  const review = screen.getByRole<HTMLButtonElement>("button", {
    name: "Review fresh Xochi quote",
  });
  await waitFor(() => expect(review.disabled).toBe(false), WAIT);
  fireEvent.click(review);
  await waitFor(() => expect(requests).toHaveLength(1), WAIT);
  expect(requests[0].settlement_preference).toBe("stealth");
  expect(requests[0].stealth_meta_address).toMatchObject({
    spending_pub_key: vectors[0].spending_pub,
    viewing_pub_key: vectors[0].viewing_pub,
  });
  expect(h.peer.calls).toBe(0);
});
