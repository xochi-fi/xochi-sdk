import { expect } from "vitest";
import type { RampPreview } from "@xochi/client";
import type { PeerExtensionSdk, PeerMetadataMessage } from "@zkp2p/sdk";
import { buildRampIntent } from "../ramp/availability/model.js";
import { peerConfiguration, fetchPeerCapabilities } from "../ramp/peer/discovery.js";
import { digest } from "../ramp/peer/normalization.js";
import {
  createPeerOnrampProvider,
  type PeerBuyerDriver,
  type PeerResumeBinding,
} from "../ramp/peer/onramp.js";
import recorded from "../ramp/peer/fixtures/usd-best-by-platform.json";
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const ACCOUNT = "0x1111111111111111111111111111111111111111";
/** In-memory extension transport. No network, browser windows, or credentials. */
export class MemoryExtension implements PeerExtensionSdk {
  state: "needs_install" | "needs_connection" | "ready" = "ready";
  version = "0.7.6";
  opens = 0;
  callbacks = new Set<(message: PeerMetadataMessage) => void>();
  async requestConnection() {
    this.state = "ready";
    return true;
  }
  async checkConnectionStatus() {
    return "connected" as const;
  }
  async getVersion() {
    return this.version;
  }
  async getState() {
    return this.state;
  }
  isAvailable() {
    return this.state !== "needs_install";
  }
  openInstallPage() {}
  authenticate() {
    this.opens++;
  }
  onMetadataMessage(callback: (message: PeerMetadataMessage) => void) {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
  deliver(message: PeerMetadataMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}
export async function buyerHarness(now = NOW, account: string = ACCOUNT) {
  const clock = { now };
  const extension = new MemoryExtension();
  const config = peerConfiguration();
  const intent = buildRampIntent({
    direction: "onramp",
    amount: "25000000",
    currency: "USD",
    recipient: account,
    settlement: config.settlement,
  });
  const raw = structuredClone(recorded);
  raw.responseObject.quoteExpiresAt = new Date(now + 20_000).toISOString();
  for (const row of raw.responseObject.platformQuotes)
    if (row.bestQuote) row.bestQuote.intent.toAddress = account;
  const reads = { bestByPlatform: async () => raw, quote: async () => raw };
  const result = await fetchPeerCapabilities(intent, { reads, now: () => clock.now });
  const offer = result.offers.find((row) => row.rail.id === "wise")!;
  const economics = result.estimates.find((row) => row.offerId === offer.offer_id)!;
  let signals = 0,
    fulfills = 0;
  let payout: Awaited<ReturnType<PeerBuyerDriver["status"]>> = "pending";
  let signalError: unknown;
  // In-memory "chain": what a reload can re-find by read-only lookup.
  const chain = { signaled: false, fulfilled: false, findable: true };
  let resumes = 0;
  const lookups: PeerResumeBinding[] = [];
  const privateRecipient = crypto.randomUUID();
  const privateMaterial = crypto.randomUUID();
  const privateHash = crypto.randomUUID();
  const preview: RampPreview = {
    contract_version: "ramp/1",
    kind: "preview",
    operation_id: crypto.randomUUID(),
    quote_id: crypto.randomUUID(),
    offer_id: offer.offer_id,
    capability_revision: offer.capability_revision,
    request_digest: digest(intent),
    pay: economics.pay,
    receive: economics.receive,
    fees: [...economics.fees],
    expires_at: new Date(now + 20_000).toISOString(),
    leg_order: ["peer"],
    disclosures: offer.disclosures,
  };
  const driver: PeerBuyerDriver = {
    async quote() {
      return {
        preview,
        paymentRecipient: privateRecipient,
        async signal() {
          signals++;
          chain.signaled = true;
          if (signalError) throw signalError;
          return { intentHash: privateHash, expiresAt: now + 120_000 };
        },
      };
    },
    async fulfill(hash, proof) {
      expect(hash).toBe(privateHash);
      expect(proof.encryptedSessionMaterial).toBe(privateMaterial);
      fulfills++;
      chain.fulfilled = true;
    },
    async status() {
      return payout;
    },
    async resume(binding) {
      resumes++;
      lookups.push(binding);
      if (!chain.findable || !chain.signaled) return undefined;
      if (chain.fulfilled) return { kind: "fulfilled", intentHash: privateHash };
      return {
        kind: "active",
        intentHash: privateHash,
        expiresAt: now + 120_000,
        signaledAt: now,
        paymentRecipient: privateRecipient,
      };
    },
  };
  /** A fresh provider runtime over the same chain: what a page reload produces. */
  const createRuntime = (user?: string) =>
    createPeerOnrampProvider({
      extension,
      driver,
      desktop: true,
      reads,
      now: () => clock.now,
      ...(user ? { user } : {}),
    });
  const runtime = createRuntime();
  const params = { selection: crypto.randomUUID() };
  function capture(): PeerMetadataMessage {
    return {
      platform: "wise",
      requestId: crypto.randomUUID(),
      expiresAt: now + 60_000,
      metadata: [
        {
          date: new Date(clock.now).toISOString(),
          amount: "25.1",
          currency: "USD",
          recipient: privateRecipient,
          hidden: false,
          originalIndex: 0,
          params,
        },
      ],
      buyerTeeCapture: { encryptedSessionMaterial: privateMaterial, params: [params] },
    };
  }
  // Derive the exact amount without any JS monetary number.
  const goodCapture = () => {
    const message = capture();
    const atomic = preview.pay.atomic.padStart(7, "0");
    message.metadata[0].amount = `${atomic.slice(0, -6)}.${atomic.slice(-6)}`;
    return message;
  };
  return {
    runtime,
    clock,
    extension,
    intent,
    offer,
    preview,
    privateRecipient,
    privateMaterial,
    privateHash,
    goodCapture,
    counts: () => ({ signals, fulfills }),
    chain,
    createRuntime,
    resumes: () => resumes,
    lookups,
    setPayout: (value: typeof payout) => {
      payout = value;
    },
    setSignalError: (value: unknown) => {
      signalError = value;
    },
  };
}
