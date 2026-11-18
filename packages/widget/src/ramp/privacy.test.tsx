// @vitest-environment jsdom

/**
 * Release privacy inspection (xochi-sdk#180): each flow driven through the
 * real widget surface inside a scripted host frame, with every channel that
 * leaves the component recorded:
 *
 *   - postMessage: every message the frame posts to the host, as wire JSON;
 *   - storage: every localStorage and sessionStorage key and value;
 *   - console: every console.log/info/warn/error/debug argument;
 *   - telemetry: every request to the Xochi API (`/api/report` and the rest),
 *     except the quote request a flow needs by design.
 *
 * What must stay true: none of them carries Peer cookies or OAuth codes,
 * payee handles, identity data, proof or proof-session material, provider
 * order / deposit / intent ids, bearer URLs, raw provider errors, keys or
 * signatures, or a recipient meta-address. Each flow plants unique sentinels
 * where that material lives (the in-memory Peer, extension and maker) and
 * asserts no channel ever saw one. The host gate's fail-closed refusal is
 * exercised here too, since it depends on the same scripted frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createBrowserRampOperationStore, type RampOperationStore } from "@xochi/client";
import { startHostBridge, type HostBridgeLease } from "../lib/hostBridge.js";
import { apiStub, renderTrade, TEST_ACCOUNT } from "../pages/trade/harness.js";
import { Trade } from "../pages/Trade.js";
import { FULL_LOOK } from "../pages/trade/embedParams.js";
import { clearWalletSession } from "../lib/walletSession.js";
import { intentAPI } from "../lib/intentAPI.js";
import { quoteWire } from "../test/intentHarness.js";
import { WAIT, testBudget } from "../test/waitBudget.js";
import { BuyOnramp } from "./peer/BuyOnramp.js";
import { PeerSigningSetupRequired, type PeerOnrampRuntime } from "./peer/onramp.js";
import { buyerHarness } from "../test/buyerPort.js";
import { OfframpPortContext } from "./offramp/port.js";
import { memoryOfframpPort, SYNTHETIC_DEPOSIT_ID } from "../test/offrampPort.js";
import { listLocalOfframps } from "./offramp/localOfframps.js";
import { ResumeOnramp } from "./recovery/ResumeOnramp.js";
import { getRampSummary, listRampSummaries, markRampOperationLive } from "./recovery/summaries.js";
import { RampDiscoveryContext } from "./availability/useRampDiscovery.js";
import { recordedPort, RECORDED_AT } from "../test/rampPort.js";
import vectors from "../lib/reverse-stealth-vectors.json";

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 16 }) });

/** One wallet step: an enabled prompt, one signature, and the prompt settled. */
async function approveInWallet(port: { signed: readonly unknown[] }, count: number) {
  if (count === 2)
    await screen.findByText(/Next wallet step: Create the cash-out deposit/, {}, WAIT);
  const button = await screen.findByRole("button", { name: "Approve in wallet" }, WAIT);
  await waitFor(() => expect(button).toHaveProperty("disabled", false), WAIT);
  fireEvent.click(button);
  await waitFor(() => expect(port.signed).toHaveLength(count), WAIT);
  await waitFor(
    () => expect(screen.queryByRole("button", { name: "Waiting for wallet..." })).toBeNull(),
    WAIT,
  );
}

const HOST = "https://host.example";

/** A frame window whose parent records what the frame posts, as wire JSON. */
class ScriptedFrame {
  posted: string[] = [];
  readonly parent = {
    postMessage: (message: unknown) => {
      this.posted.push(JSON.stringify(message));
    },
  };
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly window = {
    parent: this.parent,
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") this.listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") this.listeners.delete(listener);
    },
  } as unknown as Window;
  receive(data: unknown): void {
    const event = { data, origin: HOST, source: this.parent } as unknown as MessageEvent;
    act(() => {
      for (const listener of [...this.listeners]) listener(event);
    });
  }
  /** A host on the current widget protocol answers the handshake. */
  pinCurrent(): void {
    this.receive({
      type: "xochi:provider",
      protocolVersion: 1,
      handshakeId: 1,
      available: false,
      autoConnect: false,
      walletUi: "widget",
    });
  }
  /** A pre-v1 loader answers without a protocol version. */
  pinLegacy(): void {
    this.receive({ type: "xochi:provider", available: false });
  }
}

interface Channels {
  frame: ScriptedFrame;
  console: string[];
  telemetry: string[];
}

let lease: HostBridgeLease | undefined;
let channels: Channels;
const runtimes: PeerOnrampRuntime[] = [];

function frameWidget(): ScriptedFrame {
  const frame = new ScriptedFrame();
  lease = startHostBridge({ window: frame.window });
  return frame;
}

/** The platform boundary: Xochi API and wallet RPC, recorded except the RPC itself. */
function recordFetch(routes: Parameters<typeof apiStub>[0] = {}): void {
  const stub = apiStub(routes);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "http://harness.invalid/rpc" && !url.includes("/api/intent/quote"))
      channels.telemetry.push(`${url} ${typeof init?.body === "string" ? init.body : ""}`);
    return stub(input, init);
  });
}

function storageDump(): string {
  const dump = (store: Storage) =>
    Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ""}`);
  return [...dump(window.localStorage), ...dump(window.sessionStorage)].join("\n");
}

/** Every outward channel, as one text per channel. */
function outward(): Record<string, string> {
  return {
    postMessage: channels.frame.posted.join("\n"),
    storage: storageDump(),
    console: channels.console.join("\n"),
    telemetry: channels.telemetry.join("\n"),
  };
}

/** Material that identifies, authorizes or retrieves a flow, by shape. */
const FORBIDDEN_SHAPES =
  /intent_?hash|payment_?recipient|encrypted_?session|session_?material|proof_?session|deposit_?id|payee|bearer|authorization|cookie|oauth|privy|signature|private_?key|spending_?pub|viewing_?pub|st:eth:0x/i;

function expectClean(sentinels: readonly string[], shapes = true): void {
  const all = outward();
  for (const [channel, text] of Object.entries(all)) {
    for (const secret of sentinels)
      expect(text, `${channel} carries ${secret}`).not.toContain(secret);
    if (shapes && channel !== "console")
      expect(text, `${channel} matches a forbidden shape`).not.toMatch(FORBIDDEN_SHAPES);
  }
}

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

beforeEach(() => {
  clearWalletSession();
  window.localStorage.clear();
  window.sessionStorage.clear();
  intentAPI.clearQuoteCache();
  channels = { frame: new ScriptedFrame(), console: [], telemetry: [] };
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      channels.console.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
      );
    });
  recordFetch();
});
afterEach(() => {
  cleanup();
  lease?.stop();
  lease = undefined;
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Buy (onramp) through a current host", () => {
  async function review(h: Awaited<ReturnType<typeof buyerHarness>>) {
    runtimes.push(h.runtime);
    render(
      <BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} store={browserStore()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve wallet: signal Peer purchase on Base" }),
    );
  }

  it("completes a purchase and leaks nothing Peer or the payer holds", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const h = await buyerHarness(Date.now());
    await review(h);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Peer extension to capture my payment" }),
    );
    const capture = h.goodCapture();
    await act(async () => {
      h.extension.deliver(capture);
    });
    h.setPayout("released");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Approve wallet: verify payment and fulfill Peer intent",
      }),
    );
    await screen.findByText("Confirmed Base USDC received.", {}, WAIT);

    const events = channels.frame.posted.filter((m) => m.includes('"ramp:'));
    expect(events.length).toBeGreaterThan(0);
    // Exactly one lifecycle, one terminal, and only public fields on the wire.
    expect(events.filter((m) => m.includes("ramp:started"))).toHaveLength(1);
    expect(events.filter((m) => m.includes("ramp:terminal"))).toHaveLength(1);
    for (const message of events) {
      const event = (JSON.parse(message) as { event: Record<string, unknown> }).event;
      expect(Object.keys(event).sort()).toEqual(expect.arrayContaining(["name", "rampRef"].sort()));
      for (const key of Object.keys(event))
        expect(["name", "rampRef", "direction", "peer", "xochi", "leg", "code"]).toContain(key);
    }
    expectClean([
      h.privateRecipient,
      h.privateMaterial,
      h.privateHash,
      capture.requestId,
      h.preview.quote_id,
    ]);
  });

  it("presents a Peer sign-in requirement as setup, with no raw error anywhere", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const h = await buyerHarness(Date.now());
    h.setSignalError(new PeerSigningSetupRequired());
    await review(h);
    const status = await screen.findByText(/Setup required:/, {}, WAIT);
    expect(status.textContent).toMatch(/session linked to this wallet/);
    expect(status.textContent).toMatch(/cannot sign you in to Peer/);
    expect(document.body.textContent).not.toMatch(/coming soon|could not validate/i);
    expectClean([h.privateRecipient, h.privateMaterial, h.privateHash]);
  });

  it("keeps a raw provider error off screen and off every channel", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const h = await buyerHarness(Date.now());
    const raw = `upstream 500 cookie=peer_sid_${crypto.randomUUID()}`;
    h.setSignalError(new Error(raw));
    await review(h);
    await waitFor(
      () =>
        expect(
          screen.queryByRole("button", { name: "Approve wallet: signal Peer purchase on Base" }),
        ).toBeNull(),
      WAIT,
    );
    expect(document.body.textContent).not.toContain(raw);
    expectClean([raw, h.privateRecipient, h.privateHash]);
  });
});

describe("Send to a payment app through a current host", () => {
  it("cashes out, partly fills, delivers and withdraws with nothing leaking", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const payee = `own-handle-${crypto.randomUUID().slice(0, 8)}`;
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} embed={{ initialTab: "send", sendDestinations: ["payment_app"] }} />
      </OfframpPortContext>,
      { connected: true },
    );
    fireEvent.change(await screen.findByLabelText("USDC to cash out", {}, WAIT), {
      target: { value: "25" },
    });
    await screen.findByRole("group", { name: "Available now" }, WAIT);
    fireEvent.click(screen.getByLabelText(/Wise/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("region", { name: "Review cash-out" }, WAIT);
    const form = within(screen.getByRole("form", { name: "Payout account" }));
    fireEvent.change(form.getByLabelText(/Your own .* account/), { target: { value: payee } });
    fireEvent.click(form.getByLabelText(/belongs to me/));
    fireEvent.click(form.getByRole("button", { name: "Use this account" }));
    fireEvent.click(screen.getByLabelText(/I understand the payout is an estimate/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
    for (const count of [1, 2]) {
      await approveInWallet(port, count);
    }
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);

    const check = async (headline: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await screen.findByText(headline, { selector: "strong" }, WAIT);
    };
    Object.assign(port.maker.facts, {
      remaining: "15000000",
      unmatched: "10000000",
      filled: "10000000",
      activeIntents: 1,
    });
    await check("Partly paid out");
    Object.assign(port.maker.facts, {
      remaining: "0",
      unmatched: "0",
      filled: "25000000",
      activeIntents: 0,
      closed: true,
    });
    await check("Payout delivered");

    expect(channels.frame.posted.some((m) => m.includes("ramp:started"))).toBe(true);
    expectClean([
      payee,
      SYNTHETIC_DEPOSIT_ID,
      "synthetic_payee_hash",
      ...port.signed.map((s) => s.data),
    ]);
    // The payee was typed once and shown masked; it is nowhere in the DOM whole.
    expect(document.body.textContent).not.toContain(payee);
  });
});

describe("Send privately to someone else", () => {
  it("keeps the recipient's meta-address out of storage, messages, logs and reports", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const recipient = vectors[0];
    const META = `st:eth:0x${recipient.spending_pub.slice(2)}${recipient.viewing_pub.slice(2)}`;
    recordFetch({
      "/api/intent/quote": {
        answer: () =>
          quoteWire({ can_solve: false, error: "No fill", error_category: "no_liquidity" }),
      },
    });
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true, tokenBalance: 10_000_000n });
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Widget sections" })).getByRole("tab", {
        name: /^Send/,
      }),
    );
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Send to" })).getByRole("tab", {
        name: "Stealth",
      }),
    );
    const panel = within(
      document.getElementById(
        within(screen.getByRole("tablist", { name: "Send to" }))
          .getByRole("tab", { name: "Stealth" })
          .getAttribute("aria-controls") ?? "",
      )!,
    );
    fireEvent.change(panel.getByLabelText("From network"), { target: { value: "8453" } });
    await panel.findByLabelText("Arrives on", {}, WAIT);
    fireEvent.click(panel.getByLabelText("Someone else"));
    fireEvent.change(panel.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.change(panel.getByLabelText("Recipient stealth meta-address"), {
      target: { value: META },
    });
    fireEvent.click(panel.getByRole("button", { name: "Review Stealth send" }));
    const review = screen.getByRole("region", { name: "Review Stealth send" });
    expect(review.textContent).toMatch(/Xochi sees the recipient's meta-address/);
    fireEvent.click(within(review).getByRole("button", { name: "Continue to Stealth swap" }));
    const card = document.querySelector(".trade-card") as HTMLElement;
    await within(card).findByRole("region", { name: "Stealth recipient" }, WAIT);

    expectClean([
      META,
      recipient.spending_pub.slice(2),
      recipient.viewing_pub.slice(2),
      META.toLowerCase(),
    ]);
  });
});

describe("production fails closed on the host", () => {
  const openBuy = async () => {
    const clock = { t: RECORDED_AT };
    const port = recordedPort({ account: TEST_ACCOUNT, clock });
    await renderTrade(
      <RampDiscoveryContext value={port}>
        <Trade look={FULL_LOOK} embed={{ initialTab: "trade", initialMode: "onramp" }} />
      </RampDiscoveryContext>,
      { connected: true },
    );
    return port;
  };

  it("offers no rail until a current host pins the frame", async () => {
    const frame = frameWidget();
    const port = await openBuy();
    expect(screen.getAllByText(/Waiting for the page hosting this widget/).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByLabelText("USDC to receive")).toBeNull();
    frame.pinCurrent();
    fireEvent.change(await screen.findByLabelText("USDC to receive", {}, WAIT), {
      target: { value: "25" },
    });
    await screen.findByRole("group", { name: "Available now" }, WAIT);
    expect(port.calls).toEqual(["25000000"]);
  });

  it("refuses Buy and payment_app for a legacy host, honestly and for good", async () => {
    const frame = frameWidget();
    const port = await openBuy();
    frame.pinLegacy();
    const refusal = await screen.findAllByText(/older Xochi embed that cannot carry Peer payments/);
    expect(refusal.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/coming soon/i);
    expect(screen.queryByLabelText("USDC to receive")).toBeNull();
    // A later current-shaped message cannot upgrade a pinned legacy host.
    frame.pinCurrent();
    expect(screen.queryByLabelText("USDC to receive")).toBeNull();
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Widget sections" })).getByRole("tab", {
        name: /^Send/,
      }),
    );
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Send to" })).getByRole("tab", {
        name: "Payment app",
      }),
    );
    expect(screen.queryByLabelText("USDC to cash out")).toBeNull();
    expect(port.calls).toEqual([]);
  });
});

/** Ramp events the host received, parsed. */
function rampEvents(frame: ScriptedFrame): Record<string, unknown>[] {
  return frame.posted
    .filter((m) => m.includes('"ramp:'))
    .map((m) => (JSON.parse(m) as { event: Record<string, unknown> }).event);
}

describe("interruptions keep one lifecycle and leak nothing", () => {
  it("resumes an in-doubt purchase after a reload under the same reference", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const h = await buyerHarness(Date.now());
    const store = browserStore();
    h.setSignalError(new Error("receipt_unknown"));
    h.chain.findable = false;
    runtimes.push(h.runtime);
    render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve wallet: signal Peer purchase on Base" }),
    );
    await screen.findByText(/Do not start another transfer and do not pay again/, {}, WAIT);

    // The reload: page and provider gone, storage and the host's frame remain.
    cleanup();
    const id = listRampSummaries()[0].operation_id;
    markRampOperationLive(id, false);
    const runtime = h.createRuntime(TEST_ACCOUNT);
    runtimes.push(runtime);
    render(
      <ResumeOnramp
        summary={getRampSummary(id)!}
        connected={TEST_ACCOUNT}
        runtime={runtime}
        store={store}
      />,
    );
    await screen.findByText(/Do not start another transfer and do not pay again/, {}, WAIT);
    h.chain.findable = true;
    fireEvent.click(screen.getByRole("button", { name: "Check existing purchase status" }));
    await screen.findByRole("button", { name: "Open Peer extension to capture my payment" }, WAIT);

    const events = rampEvents(channels.frame);
    expect(events.filter((e) => e.name === "ramp:started")).toHaveLength(1);
    expect(new Set(events.map((e) => e.rampRef)).size).toBe(1);
    // The in-doubt fact reached the host once before the reload, and the
    // resumed view's move out of doubt reached it too.
    expect(events.some((e) => e.name === "ramp:recovery-required" && e.leg === "peer")).toBe(true);
    expect(events.some((e) => e.name === "ramp:status" && e.peer === "action_required")).toBe(true);
    expectClean([h.privateRecipient, h.privateMaterial, h.privateHash, "receipt_unknown"]);
  });

  async function cashOut(port: ReturnType<typeof memoryOfframpPort>, payee: string) {
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} embed={{ initialTab: "send", sendDestinations: ["payment_app"] }} />
      </OfframpPortContext>,
      { connected: true },
    );
    fireEvent.change(await screen.findByLabelText("USDC to cash out", {}, WAIT), {
      target: { value: "25" },
    });
    await screen.findByRole("group", { name: "Available now" }, WAIT);
    fireEvent.click(screen.getByLabelText(/Wise/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("region", { name: "Review cash-out" }, WAIT);
    const form = within(screen.getByRole("form", { name: "Payout account" }));
    fireEvent.change(form.getByLabelText(/Your own .* account/), { target: { value: payee } });
    fireEvent.click(form.getByLabelText(/belongs to me/));
    fireEvent.click(form.getByRole("button", { name: "Use this account" }));
    fireEvent.click(screen.getByLabelText(/I understand the payout is an estimate/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
  }

  it("reconciles a lost deposit hash after a reload, one lifecycle, nothing leaked", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const payee = `own-handle-${crypto.randomUUID().slice(0, 8)}`;
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    port.maker.hasAllowance = true;
    await cashOut(port, payee);
    port.walletAnswer = "lost";
    const button = await screen.findByRole("button", { name: "Approve in wallet" }, WAIT);
    await waitFor(() => expect(button).toHaveProperty("disabled", false), WAIT);
    fireEvent.click(button);
    await screen.findByText(/did not confirm whether it sent/, {}, WAIT);
    cleanup();

    port.reload();
    port.walletAnswer = "approve";
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} embed={{ initialTab: "send", sendDestinations: ["payment_app"] }} />
      </OfframpPortContext>,
      { connected: true },
    );
    await screen.findByText("Checking with Base", { selector: "strong" }, WAIT);
    const form = within(screen.getByRole("form", { name: "Attach transaction" }));
    fireEvent.change(form.getByLabelText(/^Transaction hash from your wallet/), {
      target: { value: port.lastHash },
    });
    fireEvent.click(form.getByRole("button", { name: "Attach and check" }));
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);

    const events = rampEvents(channels.frame);
    expect(events.filter((e) => e.name === "ramp:started")).toHaveLength(1);
    expect(new Set(events.map((e) => e.rampRef)).size).toBe(1);
    expectClean([payee, SYNTHETIC_DEPOSIT_ID, "synthetic_payee_hash", "connection lost"]);
  });

  it("ends a mixed fill-and-return cash-out with one terminal and only totals stored", async () => {
    channels.frame = frameWidget();
    channels.frame.pinCurrent();
    const payee = `own-handle-${crypto.randomUUID().slice(0, 8)}`;
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await cashOut(port, payee);
    for (const count of [1, 2]) {
      await approveInWallet(port, count);
    }
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    const check = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(
        () => expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull(),
        WAIT,
      );
    };
    Object.assign(port.maker.facts, {
      remaining: "10000000",
      unmatched: "10000000",
      filled: "15000000",
    });
    await check();
    const form = within(screen.getByRole("form", { name: "Withdraw unmatched USDC" }));
    fireEvent.change(form.getByLabelText(/^USDC to withdraw/), { target: { value: "10" } });
    fireEvent.click(form.getByRole("button", { name: "Prepare withdrawal" }));
    await screen.findByText(/Next wallet step: Withdraw unmatched USDC/, {}, WAIT);
    await approveInWallet(port, 3);
    Object.assign(port.maker.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "10000000",
      closed: true,
    });
    await check();
    await waitFor(() => expect(listLocalOfframps(TEST_ACCOUNT)[0].status).toBe("mixed"), WAIT);

    const events = rampEvents(channels.frame);
    expect(events.filter((e) => e.name === "ramp:started")).toHaveLength(1);
    expect(events.filter((e) => e.name === "ramp:terminal")).toHaveLength(1);
    // Totals are public amounts the user saw; nothing provider-side is stored.
    expect(listLocalOfframps(TEST_ACCOUNT)[0].totals).toEqual({
      filled: "15000000",
      returned: "10000000",
    });
    expectClean([
      payee,
      SYNTHETIC_DEPOSIT_ID,
      "synthetic_payee_hash",
      ...port.signed.map((s) => s.data),
    ]);
  });
});
