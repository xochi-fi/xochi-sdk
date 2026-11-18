import { afterEach, describe, expect, it } from "vitest";
import { createBrowserRampOperationStore, createRampClient, parseRamp } from "@xochi/client";
import { createRampEmitter } from "../../lib/rampLifecycle.js";
import {
  createPeerOnrampProvider,
  PeerSigningSetupRequired,
  peerRequiresLinkedSession,
  peerVersionSupported,
  type PeerBuyerDriver,
} from "./onramp.js";
import { buyerHarness as buildHarness } from "../../test/buyerPort.js";
const runtimes: ReturnType<typeof createPeerOnrampProvider>[] = [];
async function buyerHarness(now?: number) {
  const h = await buildHarness(now);
  runtimes.push(h.runtime);
  return h;
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
const context = (revision = "0") => ({
  expected_revision: revision,
  idempotency_key: crypto.randomUUID(),
});

// Harness exports are also used by the rendered Buy tests.
describe("Peer buyer provider", () => {
  it("uses extension getState and platform minimum versions; mobile never signals", async () => {
    const h = await buyerHarness();
    h.extension.state = "needs_install";
    expect(await h.runtime.checkReadiness("wise")).toBe("peer_extension_install");
    h.extension.state = "needs_connection";
    expect(await h.runtime.checkReadiness("wise")).toBe("peer_extension_connection");
    h.extension.state = "ready";
    h.extension.version = "0.6.3";
    expect(await h.runtime.checkReadiness("wise")).toBeUndefined();
    expect(await h.runtime.checkReadiness("alipay")).toBe("peer_extension_update");
    for (const [rail, version] of [
      ["alipay", "0.6.7"],
      ["upi", "0.6.8"],
      ["monobank", "0.7.2"],
      ["xmoney", "0.7.6"],
    ])
      expect(peerVersionSupported(version, rail)).toBe(true);
    expect(peerVersionSupported("0.7.6-beta", "wise")).toBe(false);
    const mobile = createPeerOnrampProvider({
      extension: h.extension,
      driver: {} as PeerBuyerDriver,
      desktop: false,
    });
    expect(await mobile.checkReadiness("wise")).toBe("peer_desktop_extension_or_app");
    expect(h.counts().signals).toBe(0);
  });
  it("opens only from gesture and rejects mismatched capture before fulfillment", async () => {
    const h = await buyerHarness();
    await h.runtime.provider.preview(h.intent, h.offer);
    await h.runtime.provider.approve(h.preview, context());
    expect(h.extension.opens).toBe(0);
    expect(h.runtime.openFromGesture(h.preview.operation_id)).toBe(true);
    const pending = h.runtime.provider.interact(h.preview.operation_id, context());
    for (const field of ["platform", "recipient", "amount", "currency"]) {
      const bad = h.goodCapture();
      if (field === "platform") bad.platform = "venmo";
      else bad.metadata[0][field] = "mismatch";
      h.extension.deliver(bad);
      expect(h.runtime.phase(h.preview.operation_id)).toBe("capture");
      expect(h.counts().fulfills).toBe(0);
    }
    h.extension.deliver(h.goodCapture());
    expect((await pending).peer.state).toBe("action_required");
    expect(h.runtime.phase(h.preview.operation_id)).toBe("finalize");
    expect(h.counts().fulfills).toBe(0);
    h.setPayout("held");
    const held = await h.runtime.provider.interact(h.preview.operation_id, context());
    expect(held.peer).toMatchObject({ state: "processing", payout_state: "held" });
    expect(held.terminal).toBe(false);
    h.setPayout("released");
    expect((await h.runtime.provider.status(h.preview.operation_id)).peer).toMatchObject({
      state: "completed",
      payout_state: "released",
    });
    expect(h.counts()).toEqual({ signals: 1, fulfills: 1 });
  });
  it("does not signal expired quotes or reopen expired intents", async () => {
    const h = await buyerHarness();
    await h.runtime.provider.preview(h.intent, h.offer);
    h.clock.now += 21_000;
    await expect(h.runtime.provider.approve(h.preview, context())).rejects.toThrow("quote_expired");
    expect(h.counts().signals).toBe(0);
  });
  it("maps Privy signing requirements to bounded setup without forwarding upstream errors", async () => {
    const h = await buyerHarness();
    h.setSignalError(new PeerSigningSetupRequired());
    await h.runtime.provider.preview(h.intent, h.offer);
    const snapshot = await h.runtime.provider.approve(h.preview, context());
    expect(peerRequiresLinkedSession({ status: 401 })).toBe(true);
    expect(snapshot.peer.state).toBe("failed");
    expect(h.runtime.setupRequired()).toBe("peer_wallet_linked_session");
    expect(
      peerRequiresLinkedSession({ message: "A Privy session linked to the wallet is required" }),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("Privy");
    await h.runtime.provider.approve(h.preview, context());
    expect(h.counts().signals).toBe(1);
  });
  it("keeps a recovered intent without payment instructions in doubt after a status check", async () => {
    const h = await buyerHarness();
    const runtime = createPeerOnrampProvider({
      extension: h.extension,
      now: () => h.clock.now,
      driver: {
        async quote() {
          throw new Error("unexpected quote");
        },
        async fulfill() {
          throw new Error("unexpected fulfillment");
        },
        async status() {
          return "pending";
        },
        async resume() {
          return {
            kind: "active",
            intentHash: "synthetic-intent",
            signaledAt: h.clock.now,
            expiresAt: h.clock.now + 60_000,
          };
        },
      },
    });
    runtimes.push(runtime);
    const id = h.preview.operation_id;
    await runtime.resume(id, {
      wallet: h.intent.recipient,
      rail: h.offer.rail.id,
      pay: h.preview.pay,
      receive: h.preview.receive,
      quoteExpiresAt: h.preview.expires_at,
      approvedAfter: h.clock.now,
    });
    expect((await runtime.provider.status(id)).peer.state).toBe("in_doubt");
    expect(runtime.phase(id)).toBe("processing");
    expect(runtime.paymentRecipient(id)).toBe("");
  });
  it("runs S4 with persisted sanitized records and frame-minted lifecycle events", async () => {
    // S4 uses the real clock for quote validation; keep the fixture comfortably fresh.
    const h = await buyerHarness(Date.now());
    const saved = new Map<string, string>();
    const store = createBrowserRampOperationStore({
      storage: {
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => {
          saved.set(key, value);
        },
      },
      locks: {
        request: (async (_name: string, callback: () => unknown) =>
          callback()) as LockManager["request"],
      },
    });
    const client = createRampClient({ peer: h.runtime.provider, store });
    const events: unknown[] = [];
    const emitter = createRampEmitter("onramp", {
      emit: (event) => {
        events.push(event);
      },
    });
    const quote = await client.preview(h.intent, h.offer.offer_id, h.offer.capability_revision);
    let snapshot = await client.approve(
      quote.operation_id,
      quote.quote_id,
      [
        ...quote.disclosures.public_state,
        ...quote.disclosures.identity_visible_to,
        ...quote.disclosures.liveness_dependencies,
      ],
      context(),
    );
    emitter.status(snapshot.peer.state);
    expect(snapshot.peer.state).toBe("action_required");
    expect(h.runtime.openFromGesture(quote.operation_id)).toBe(true);
    const capture = client.interact(quote.operation_id, {}, context(snapshot.revision));
    h.extension.deliver(h.goodCapture());
    snapshot = await capture;
    h.setPayout("paid");
    snapshot = await client.interact(quote.operation_id, {}, context(snapshot.revision));
    emitter.status(snapshot.peer.state);
    emitter.terminal(snapshot.peer.state);
    expect(snapshot.peer.state).toBe("completed");
    expect(parseRamp(snapshot).ok).toBe(true);
    const output = JSON.stringify([events, [...saved.values()]]);
    for (const forbidden of [
      h.privateHash,
      h.privateRecipient,
      h.privateMaterial,
      "encryptedSessionMaterial",
      "paymentRecipient",
      "buyerTeeCapture",
      "requestId",
      "params",
      "authorization",
      "cookie",
      "credential",
      "proof",
      "signature",
    ])
      expect(output).not.toContain(forbidden);
    for (const event of events as Record<string, unknown>[]) {
      expect(
        Object.keys(event).every((key) => ["name", "rampRef", "direction", "peer"].includes(key)),
      ).toBe(true);
      expect(event.rampRef).toBe(emitter.rampRef);
    }
  });
});
