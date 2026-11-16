// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { apiStub, renderTrade, TEST_ACCOUNT } from "../../pages/trade/harness.js";
import { memoryOfframpPort } from "../../test/offrampPort.js";
import { useOfframp } from "./useOfframp.js";
import { buildRampIntent } from "../availability/model.js";
import { clearWalletSession } from "../../lib/walletSession.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearWalletSession();
  vi.unstubAllGlobals();
});
it("rechecks spendability at Peer approval and preserves the review on failure", async () => {
  vi.stubGlobal("fetch", apiStub({}));
  const port = memoryOfframpPort({ account: TEST_ACCOUNT });
  let balance = 0n;
  const reads: string[] = [];
  let flow: ReturnType<typeof useOfframp>;
  const funding = async (amount: string) => {
    reads.push(amount);
    return balance >= BigInt(amount);
  };
  function Probe() {
    flow = useOfframp(port, TEST_ACCOUNT, true, funding);
    return null;
  }
  await renderTrade(<Probe />, { connected: true });
  await waitFor(() => expect(flow.runtime).toBeDefined());
  const runtime = flow!.runtime!;
  const intent = buildRampIntent({
    direction: "offramp",
    amount: "25000000",
    currency: "USD",
    recipient: TEST_ACCOUNT,
    settlement: port.settlement()!,
  });
  const offers = runtime.provider.normalizeCapabilities(
    await runtime.provider.capabilities(intent),
    intent,
  );
  const offer = offers.find((o) => o.availability.state === "available")!;
  await act(() => flow.estimate(offer, intent));
  await act(() => flow.confirm("synthetic-own-account"));
  expect(flow!.view.kind).toBe("review");
  expect(flow!.notice).toMatch(/Peer has not started/);
  expect(port.maker.registeredAccounts).toEqual([]);
  expect(port.signed).toEqual([]);
  balance = 25_000_000n;
  await act(() => flow.confirm("synthetic-own-account"));
  expect(flow!.view.kind).toBe("order");
  expect(reads).toEqual(["25000000", "25000000"]);
  expect(port.maker.deposits).toBe(0);
});
