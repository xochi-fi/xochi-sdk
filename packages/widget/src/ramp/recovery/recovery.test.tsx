// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createBrowserRampOperationStore, type RampOperationStore } from "@xochi/client";
import { BuyOnramp } from "../peer/BuyOnramp.js";
import { formatRampTime } from "../availability/model.js";
import { buyerHarness } from "../../test/buyerPort.js";
import type { PeerOnrampRuntime } from "../peer/onramp.js";
import { ResumeOnramp } from "./ResumeOnramp.js";
import {
  getRampSummary,
  listRampSummaries,
  markRampOperationLive,
  PEER_HOLD_MS,
  upsertRampSummary,
  type RampOperationSummary,
} from "./summaries.js";
import { RampActivityList } from "../../components/RampActivityList.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const runtimes: PeerOnrampRuntime[] = [];
/** Real S4 browser store over jsdom localStorage; this lock runs each callback alone. */
function browserStore(): RampOperationStore {
  let queue = Promise.resolve();
  const locks = {
    request: (_name: string, callback: () => unknown) => {
      const run = queue.then(callback);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  } as unknown as Pick<LockManager, "request">;
  return createBrowserRampOperationStore({ storage: window.localStorage, locks });
}
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function approved(h: Awaited<ReturnType<typeof buyerHarness>>, store: RampOperationStore) {
  runtimes.push(h.runtime);
  render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} store={store} />);
  fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
}
/** Simulate a reload: the page and its in-memory provider are gone; storage remains. */
function reload(h: Awaited<ReturnType<typeof buyerHarness>>, store: RampOperationStore) {
  cleanup();
  const id = listRampSummaries()[0].operation_id;
  markRampOperationLive(id, false);
  const runtime = h.createRuntime(ACCOUNT);
  runtimes.push(runtime);
  render(
    <ResumeOnramp
      summary={getRampSummary(id)!}
      connected={ACCOUNT}
      runtime={runtime}
      store={store}
    />,
  );
  return id;
}
/** Nothing that can retrieve or prove the flow may reach browser storage. */
function expectNoSecretsStored(h: Awaited<ReturnType<typeof buyerHarness>>) {
  const dump = Object.keys(window.localStorage)
    .map((key) => `${key}=${window.localStorage.getItem(key)}`)
    .join("\n");
  expect(dump.length).toBeGreaterThan(0);
  for (const secret of [h.privateRecipient, h.privateMaterial, h.privateHash])
    expect(dump).not.toContain(secret);
  expect(dump).not.toMatch(
    /intent_?hash|payment_?recipient|session|proof|offchain|bearer|https?:/i,
  );
}

it("resumes after intent signaling without a second intent", async () => {
  const h = await buyerHarness(Date.now());
  const store = browserStore();
  await approved(h, store);
  await screen.findByRole("button", { name: "Open Peer extension to capture my payment" });
  expect(getRampSummary(listRampSummaries()[0].operation_id)).toMatchObject({
    submitted: true,
    state: "action_required",
  });

  reload(h, store);
  const open = await screen.findByRole("button", {
    name: "Open Peer extension to capture my payment",
  });
  expect(screen.getByText(/If you already paid for it, do not pay again/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /signal Peer purchase/ })).toBeNull();
  expect(h.lookups[0]).toMatchObject({ wallet: ACCOUNT, rail: "wise", currency: "USD" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Step 2: pay and capture"));

  fireEvent.click(open);
  await act(async () => h.extension.deliver(h.goodCapture()));
  h.setPayout("released");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Confirm payment",
    }),
  );
  await screen.findByText("Confirmed Base USDC received.");
  expect(h.counts()).toEqual({ signals: 1, fulfills: 1 });
  expectNoSecretsStored(h);
});

it("resumes after payment capture by re-capturing, never paying or signaling again", async () => {
  const h = await buyerHarness(Date.now());
  const store = browserStore();
  await approved(h, store);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Peer extension to capture my payment" }),
  );
  await act(async () => h.extension.deliver(h.goodCapture()));
  await screen.findByRole("button", {
    name: "Confirm payment",
  });

  // The captured proof lived only in provider memory; the reload drops it.
  reload(h, store);
  const reopen = await screen.findByRole("button", {
    name: "Open Peer extension to capture my payment",
  });
  expect(screen.getByText(/If you already paid for it, do not pay again/)).toBeTruthy();
  fireEvent.click(reopen);
  expect(h.extension.opens).toBe(2);
  await act(async () => h.extension.deliver(h.goodCapture()));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Confirm payment",
    }),
  );
  await screen.findByText(/Waiting for Peer to update this purchase|Confirmed Base USDC received/);
  expect(h.counts()).toEqual({ signals: 1, fulfills: 1 });
  expectNoSecretsStored(h);
});

it("keeps an in-doubt submission to status reconciliation only, then reconciles it", async () => {
  const h = await buyerHarness(Date.now());
  const store = browserStore();
  h.setSignalError(new Error("receipt_unknown"));
  h.chain.findable = false;
  await approved(h, store);
  await screen.findByText(/Do not start another transfer and do not pay again/);
  const buttons = () => screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons()).toEqual(["Check existing purchase status"]);

  // Reload while still unknown: resume reconciles by status and stays in doubt.
  reload(h, store);
  await screen.findByText(/Do not start another transfer and do not pay again/);
  expect(buttons()).toEqual(["Check existing purchase status"]);
  expect(getRampSummary(listRampSummaries()[0].operation_id)?.state).toBe("in_doubt");

  // The intent becomes visible on chain: reconciliation finds it, nothing is re-signaled.
  h.chain.findable = true;
  fireEvent.click(screen.getByRole("button", { name: "Check existing purchase status" }));
  await screen.findByRole("button", { name: "Open Peer extension to capture my payment" });
  expect(h.counts()).toEqual({ signals: 1, fulfills: 0 });
  expectNoSecretsStored(h);
});

it("resumes a fulfilled purchase whose payout is held, with an estimate and no guarantee", async () => {
  const h = await buyerHarness(Date.now());
  const store = browserStore();
  await approved(h, store);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Peer extension to capture my payment" }),
  );
  await act(async () => h.extension.deliver(h.goodCapture()));
  h.setPayout("held");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Confirm payment",
    }),
  );
  await screen.findByText(/Peer is holding this payout/);
  const held = getRampSummary(listRampSummaries()[0].operation_id)!;
  expect(held).toMatchObject({ payout_state: "held", state: "processing", terminal: false });
  const release = formatRampTime(Date.parse(held.held_since!) + PEER_HOLD_MS, true);

  reload(h, store);
  const status = await screen.findByText(/Peer is holding this payout/);
  expect(status.textContent).toContain(`Estimated release around ${release}`);
  expect(status.textContent).toContain("this is an estimate, not a guarantee");
  expect(screen.queryByText("Confirmed Base USDC received.")).toBeNull();
  h.setPayout("released");
  fireEvent.click(screen.getByRole("button", { name: "Check existing purchase status" }));
  await screen.findByText("Confirmed Base USDC received.");
  expect(h.counts()).toEqual({ signals: 1, fulfills: 1 });
});

function summary(overrides: Partial<RampOperationSummary> = {}): RampOperationSummary {
  const at = new Date().toISOString();
  return {
    operation_id: "op_w3",
    direction: "onramp",
    wallet: ACCOUNT,
    rail: { id: "wise", label: "Wise" },
    pay: { asset: { kind: "fiat", currency: "USD", decimals: 6 }, atomic: "25996971" as never },
    receive: {
      asset: {
        kind: "crypto",
        chain_id: "eip155:8453",
        asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        decimals: 6,
      },
      atomic: "25000000" as never,
    },
    quote_expires_at: new Date(Date.now() + 20_000).toISOString(),
    submitted: false,
    state: "quoted",
    terminal: false,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

it("requires the original wallet, offering abandonment only for an unsubmitted flow", async () => {
  const h = await buyerHarness(Date.now());
  upsertRampSummary(summary());
  const view = render(
    <ResumeOnramp summary={getRampSummary("op_w3")!} connected={OTHER} runtime={h.runtime} />,
  );
  expect(screen.getByRole("alert").textContent).toContain("bound to wallet 0x1111…1111");
  expect(screen.getByText("No transfer was submitted for it.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Abandon this unsubmitted purchase" }));
  expect(getRampSummary("op_w3")?.abandoned).toBe(true);

  upsertRampSummary(summary({ operation_id: "op_w3b", submitted: true, state: "in_doubt" }));
  view.rerender(
    <ResumeOnramp summary={getRampSummary("op_w3b")!} connected={OTHER} runtime={h.runtime} />,
  );
  expect(screen.queryByRole("button", { name: /Abandon/ })).toBeNull();
  expect(screen.getByText(/Do not start another transfer for it/)).toBeTruthy();
  expect(h.resumes()).toBe(0);
  expect(h.counts()).toEqual({ signals: 0, fulfills: 0 });
});

it("disables a live purchase's actions after the wallet changes", async () => {
  const h = await buyerHarness(Date.now());
  const store = browserStore();
  runtimes.push(h.runtime);
  const view = render(
    <BuyOnramp
      intent={h.intent}
      offer={h.offer}
      runtime={h.runtime}
      store={store}
      connected={ACCOUNT}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
  await screen.findByRole("button", { name: "Open Peer extension to capture my payment" });
  view.rerender(
    <BuyOnramp
      intent={h.intent}
      offer={h.offer}
      runtime={h.runtime}
      store={store}
      connected={OTHER}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("bound to wallet 0x1111…1111");
  const open = screen.getByRole<HTMLButtonElement>("button", {
    name: "Open Peer extension to capture my payment",
  });
  expect(open.disabled).toBe(true);
  fireEvent.click(open);
  expect(h.extension.opens).toBe(0);
});

it("says no transfer was submitted when a reloaded quote expired before submission", () => {
  upsertRampSummary(summary({ quote_expires_at: new Date(Date.now() - 1).toISOString() }));
  render(<ResumeOnramp summary={getRampSummary("op_w3")!} connected={ACCOUNT} />);
  expect(screen.getByRole("status").textContent).toContain(
    "The quote expired before submission. No transfer was submitted.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss and review a new quote" }));
  expect(getRampSummary("op_w3")?.abandoned).toBe(true);
});

it("lists only the connected wallet's sanitized purchases in Activity", () => {
  upsertRampSummary(summary({ submitted: true, state: "in_doubt" }));
  upsertRampSummary(summary({ operation_id: "op_other", wallet: OTHER }));
  render(<RampActivityList ramps={listRampSummaries()} wallet={ACCOUNT} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain("25 USDC");
  expect(rows[0].textContent).toContain("Status uncertain, check before any new transfer");
});
