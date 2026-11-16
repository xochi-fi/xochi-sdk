// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RampAction } from "@xochi/client";
import { RampRouteSteps } from "./RampRouteSteps.js";
import { routeHarness, ROUTE_RECEIVED, ROUTE_WALLET } from "../../test/routePort.js";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
let pending = Promise.resolve();
function Route({ h }: { h: Awaited<ReturnType<typeof routeHarness>> }) {
  const [snapshot, setSnapshot] = useState(h.snapshot);
  const [busy, setBusy] = useState(false);
  async function action(action: RampAction) {
    setBusy(true);
    const context = () => ({
      expected_revision: snapshot.revision,
      idempotency_key: crypto.randomUUID(),
    });
    const offered = snapshot.xochi
      ? snapshot
      : await h.client.offerRoute(snapshot.operation_id, context());
    setSnapshot(
      await h.client.recover(offered.operation_id, "xochi", action, {
        ...context(),
        expected_revision: offered.revision,
      }),
    );
    setBusy(false);
  }
  return (
    <RampRouteSteps
      snapshot={snapshot}
      preview={h.leg.preview(snapshot.operation_id)}
      wallet={ROUTE_WALLET}
      received={ROUTE_RECEIVED}
      busy={busy}
      onAction={(a) => {
        pending = action(a);
      }}
    />
  );
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await pending;
  });
};
it("offers only after receipt confirmation and hold release", async () => {
  const h = await routeHarness();
  const props = { wallet: ROUTE_WALLET, received: ROUTE_RECEIVED, onAction: () => {} };
  const view = render(
    <RampRouteSteps
      {...props}
      snapshot={{
        ...h.snapshot,
        peer: { name: "peer", state: "processing", recoverable: false, payout_state: "held" },
      }}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <RampRouteSteps
      {...props}
      snapshot={{ ...h.snapshot, peer: { name: "peer", state: "in_doubt", recoverable: true } }}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<RampRouteSteps {...props} snapshot={h.snapshot} />);
  expect(screen.getByText("Peer purchase complete")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review fresh Xochi quote" })).toBeTruthy();
  expect(h.driver.quotes).toBe(0);
});
it("reviews exact route economics, expiry and recipient before separate wallet approval", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  const h = await routeHarness();
  render(<Route h={h} />);
  await click("Review fresh Xochi quote");
  expect(screen.getByText("24.5 USDT")).toBeTruthy();
  expect(screen.getByText("Receive exactly the quoted amount, or a full refund.")).toBeTruthy();
  expect(screen.getByText("2026-11-16T12:00:30.000Z")).toBeTruthy();
  expect(h.driver.executions).toBe(0);
  await click("Approve wallet: route Base USDC with Xochi");
  expect(screen.getByText(/Xochi route completed/)).toBeTruthy();
  expect(screen.getByText(/Route receipt:/)).toBeTruthy();
  expect(h.driver.executions).toBe(1);
  expect(h.peer.calls).toBe(0);
});
it("shows the confirmed Base USDC location on failure and retries only Xochi", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  const h = await routeHarness();
  h.driver.failQuote = true;
  render(<Route h={h} />);
  await click("Review fresh Xochi quote");
  expect(screen.getByRole("alert").textContent).toContain(
    `Your Base USDC is in ${ROUTE_WALLET} on Base`,
  );
  expect(screen.getByRole("alert").textContent).toContain("partial success");
  h.driver.failQuote = false;
  await click("Retry Xochi route with a fresh quote");
  expect(h.driver.quotes).toBe(2);
  expect(h.peer.calls).toBe(0);
  expect(h.driver.executions).toBe(0);
  await click("Approve wallet: route Base USDC with Xochi");
  expect(h.driver.executions).toBe(1);
});
it("skip leaves Peer completed and Base USDC at the receiving wallet", async () => {
  const h = await routeHarness();
  render(<Route h={h} />);
  await click("Skip route and keep Base USDC");
  expect(screen.getByRole("status").textContent).toContain("Route skipped");
  expect(screen.getByRole("status").textContent).toContain(ROUTE_WALLET);
  expect(screen.getByRole("status").textContent).toContain("Peer remains completed");
  expect(h.driver.quotes + h.driver.executions + h.peer.calls).toBe(0);
});
it("expiry disables route approval, keeps Peer complete, and offers a fresh review", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  const h = await routeHarness();
  render(<Route h={h} />);
  await click("Review fresh Xochi quote");
  await act(async () => {
    vi.advanceTimersByTime(30_001);
    h.driver.now += 30_001;
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Approve wallet: route Base USDC with Xochi",
    }).disabled,
  ).toBe(true);
  expect(screen.getByText(/Route quote expired/)).toBeTruthy();
  await click("Review fresh Xochi quote");
  expect(h.driver.quotes).toBe(2);
  expect(h.driver.executions).toBe(0);
});
it("an in-doubt route offers status only and never claims funds remain on Base", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  const h = await routeHarness();
  h.driver.result = {
    name: "xochi",
    state: "in_doubt",
    recoverable: true,
    failure_code: "xochi_in_doubt",
  };
  render(<Route h={h} />);
  await click("Review fresh Xochi quote");
  await click("Approve wallet: route Base USDC with Xochi");
  expect(screen.getByRole("status").textContent).toContain("Funds may have moved");
  expect(screen.queryByRole("button", { name: /Retry|Skip|Review/ })).toBeNull();
  await click("Check Xochi route status");
  expect(h.driver.polls).toBe(1);
  expect(h.driver.executions).toBe(1);
  expect(h.driver.quotes).toBe(1);
});
