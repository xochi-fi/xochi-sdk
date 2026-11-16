import {
  parseRamp,
  type RampIntent,
  type RampOffer,
  type RampPreview,
  type RampProvider,
  type RampSnapshot,
} from "@xochi/client";
import type { BuyerTeePaymentProofInput, PeerExtensionSdk, PeerMetadataMessage } from "@zkp2p/sdk";
import { parseUnits } from "viem";
import { fetchPeerCapabilities } from "./discovery.js";
import { isPeerMobileWeb } from "./environment.js";
import type { PeerDiscoveryOptions } from "./types.js";

export const PEER_ATTESTATION_ORIGIN = "https://attestation-service.zkp2p.xyz";
export type PeerSetupCode =
  | "peer_desktop_extension_or_app"
  | "peer_extension_install"
  | "peer_extension_connection"
  | "peer_extension_update"
  | "peer_wallet_linked_session";
export type BuyerPhase =
  | "review"
  | "payment"
  | "capture"
  | "finalize"
  | "processing"
  | "held"
  | "completed";

/** All inputs and outputs of this port are provider-private; never persist or emit them. */
export interface PeerBuyerDriver {
  quote(
    intent: RampIntent,
    offer: RampOffer,
    signal?: AbortSignal,
  ): Promise<{
    preview: RampPreview;
    paymentRecipient: string;
    signal(): Promise<{
      intentHash: string;
      expiresAt: number;
      paymentRecipient?: string;
      signaledAt?: number;
    }>;
  }>;
  /** Must verify on-chain intent identity/amount/recipient before requesting attestation. */
  fulfill(intentHash: string, proof: BuyerTeePaymentProofInput): Promise<void>;
  status(intentHash: string): Promise<"pending" | "held" | "paid" | "released" | "unknown">;
}
export interface PeerBuyerOptions extends PeerDiscoveryOptions {
  extension: PeerExtensionSdk;
  driver: PeerBuyerDriver;
  /** Injection for deterministic environment tests; true can only narrow the real mobile gate. */
  desktop?: boolean;
}
interface Operation {
  intent: RampIntent;
  offer: RampOffer;
  preview: RampPreview;
  paymentRecipient: string;
  signal: () => Promise<{
    intentHash: string;
    expiresAt: number;
    paymentRecipient?: string;
    signaledAt?: number;
  }>;
  intentHash?: string;
  expiresAt?: number;
  signaledAt?: number;
  state: RampSnapshot["peer"]["state"];
  payout?: "held" | "released";
  phase: BuyerPhase;
  submitted: boolean;
  proof?: BuyerTeePaymentProofInput;
  capture?: Promise<boolean>;
  stopCapture?: () => void;
}

function minimumVersion(platform: string): string {
  return (
    (
      { alipay: "0.6.7", upi: "0.6.8", monobank: "0.7.2", xmoney: "0.7.6" } as Record<
        string,
        string
      >
    )[platform] ?? "0.6.3"
  );
}
export function peerVersionSupported(version: string, platform: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const current = version.split(".").map(Number),
    minimum = minimumVersion(platform).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}
export class PeerSigningSetupRequired extends Error {
  constructor() {
    super("peer_wallet_linked_session");
  }
}

/** Inspect a bounded error classification only; never expose the upstream message. */
export function peerRequiresLinkedSession(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  return (
    value.status === 401 ||
    value.status === 403 ||
    value.statusCode === 401 ||
    value.statusCode === 403 ||
    (typeof value.message === "string" &&
      /privy|wallet.{0,32}link|unauthenticated|unauthorized|authentication required/i.test(
        value.message.slice(0, 512),
      ))
  );
}

/** One transient provider runtime. No credentials, proof sessions or provider handles leave this closure. */
export function createPeerOnrampProvider(options: PeerBuyerOptions) {
  const operations = new Map<string, Operation>();
  const now = options.now ?? Date.now;
  let readiness: { platform: string; at: number; code?: PeerSetupCode } | undefined;
  let setup: PeerSetupCode | undefined;
  let capturing: string | undefined;
  const usedCaptures = new Set<string>();
  const extension = options.extension;
  async function checkReadiness(platform: string): Promise<PeerSetupCode | undefined> {
    let code: PeerSetupCode | undefined;
    if (
      options.desktop === false ||
      options.mobileWeb ||
      isPeerMobileWeb() ||
      (options.desktop !== true &&
        (typeof navigator === "undefined" ||
          !/Chrome|Chromium/i.test(navigator.userAgent) ||
          /Edg\/|OPR\//i.test(navigator.userAgent)))
    )
      code = "peer_desktop_extension_or_app";
    else {
      try {
        const state = await extension.getState();
        if (state === "needs_install") code = "peer_extension_install";
        else if (state === "needs_connection") code = "peer_extension_connection";
        else if (state !== "ready" || !peerVersionSupported(await extension.getVersion(), platform))
          code = "peer_extension_update";
      } catch {
        code = "peer_extension_install";
      }
    }
    readiness = { platform, at: now(), code };
    return code;
  }
  function operation(id: string): Operation {
    const op = operations.get(id);
    if (!op) throw new Error("invalid_request");
    return op;
  }
  function snapshot(id: string): RampSnapshot {
    const op = operation(id);
    return {
      contract_version: "ramp/1",
      kind: "snapshot",
      operation_id: id,
      revision: "0",
      direction: "onramp",
      leg_order: ["peer"],
      peer: {
        name: "peer",
        state: op.state,
        recoverable: op.state === "in_doubt",
        ...(op.payout ? { payout_state: op.payout } : {}),
      },
      allowed_actions:
        op.state === "action_required"
          ? ["interact", "check_status"]
          : op.state === "processing" || op.state === "in_doubt"
            ? ["check_status"]
            : [],
      terminal: op.state === "completed" || op.state === "failed",
      updated_at: new Date(now()).toISOString(),
    };
  }
  function paymentMatches(
    message: PeerMetadataMessage,
    op: Operation,
  ): BuyerTeePaymentProofInput | undefined {
    // The extension API cannot carry our operation ID. Bind a single active capture to
    // the selected rail, intent lifetime, exact fiat amount and selected maker recipient.
    if (
      message.platform !== op.offer.rail.id ||
      !message.requestId ||
      usedCaptures.has(message.requestId) ||
      message.errorMessage ||
      !Number.isFinite(message.expiresAt) ||
      message.expiresAt <= now() ||
      !Array.isArray(message.metadata) ||
      message.metadata.length > 100 ||
      !op.expiresAt ||
      op.expiresAt <= now() ||
      !message.buyerTeeCapture?.encryptedSessionMaterial
    )
      return;
    const rows = message.metadata.filter((row) => {
      if (
        row.hidden ||
        row.currency !== op.intent.fiat.currency ||
        row.recipient !== op.paymentRecipient ||
        typeof row.date !== "string" ||
        !Number.isFinite(Date.parse(row.date)) ||
        Date.parse(row.date) < (op.signaledAt ?? now()) ||
        Date.parse(row.date) > now() + 120_000 ||
        typeof row.amount !== "string" ||
        row.amount.length > 80 ||
        !/^(0|[1-9][0-9]*)(?:\.\d{1,6})?$/.test(row.amount) ||
        !row.params
      )
        return false;
      return parseUnits(row.amount, op.intent.fiat.decimals).toString() === op.preview.pay.atomic;
    });
    if (rows.length !== 1) return;
    const params = rows[0].params!;
    if (
      !message.buyerTeeCapture.params?.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(params),
      )
    )
      return;
    usedCaptures.add(message.requestId);
    return {
      proofType: "buyerTee",
      encryptedSessionMaterial: message.buyerTeeCapture.encryptedSessionMaterial,
      params,
      actionPlatform: op.offer.rail.id,
      actionType: `transfer_${op.offer.rail.id}`,
    };
  }
  const provider: RampProvider = {
    id: "peer",
    capabilities: (intent, signal) => fetchPeerCapabilities(intent, { ...options, signal }),
    normalizeCapabilities(raw) {
      const offers = (raw as { offers?: unknown })?.offers;
      if (!Array.isArray(offers)) return [];
      return offers.flatMap((offer) => {
        const parsed = parseRamp(offer);
        return parsed.ok && parsed.value.kind === "offer" && parsed.value.direction === "onramp"
          ? [parsed.value]
          : [];
      });
    },
    async preview(intent, offer, signal) {
      if (intent.direction !== "onramp" || intent.route) throw new Error("invalid_request");
      setup = await checkReadiness(offer.rail.id);
      if (setup) throw new Error("capability_unavailable");
      const quote = await options.driver.quote(intent, offer, signal);
      const parsed = parseRamp(quote.preview);
      if (!parsed.ok || parsed.value.kind !== "preview") throw new Error("invalid_request");
      operations.set(quote.preview.operation_id, {
        ...quote,
        intent,
        offer,
        state: "quoted",
        phase: "review",
        submitted: false,
      });
      return quote.preview;
    },
    async approve(preview) {
      const op = operation(preview.operation_id);
      if (op.submitted) return snapshot(preview.operation_id);
      if (preview.quote_id !== op.preview.quote_id || Date.parse(op.preview.expires_at) <= now())
        throw new Error("quote_expired");
      setup = await checkReadiness(op.offer.rail.id);
      if (setup) {
        op.state = "failed";
        return snapshot(preview.operation_id);
      }
      // Set before wallet/network boundary; never automatically signal a second time.
      op.submitted = true;
      op.state = "in_doubt";
      try {
        const signaled = await op.signal();
        op.paymentRecipient = signaled.paymentRecipient ?? op.paymentRecipient;
        if (!op.paymentRecipient) throw new Error("invalid_request");
        op.intentHash = signaled.intentHash;
        op.expiresAt = signaled.expiresAt;
        op.signaledAt = signaled.signaledAt ?? now();
        op.state = "action_required";
        op.phase = "payment";
      } catch (error) {
        if (error instanceof PeerSigningSetupRequired) {
          setup = "peer_wallet_linked_session";
          op.state = "failed";
        }
      }
      return snapshot(preview.operation_id);
    },
    async interact(id) {
      const op = operation(id);
      if (op.capture) {
        const accepted = await op.capture;
        op.capture = undefined;
        op.state = accepted ? "action_required" : "in_doubt";
        op.phase = accepted ? "finalize" : "processing";
      } else if (op.proof && op.intentHash && op.phase === "finalize") {
        if (!op.expiresAt || op.expiresAt <= now()) {
          op.proof = undefined;
          op.state = "in_doubt";
          return snapshot(id);
        }
        const proof = op.proof;
        op.proof = undefined;
        op.state = "in_doubt";
        op.phase = "processing";
        try {
          await options.driver.fulfill(op.intentHash, proof);
        } catch {
          return snapshot(id);
        }
        return provider.status(id);
      } else throw new Error("invalid_request");
      return snapshot(id);
    },
    async status(id) {
      const op = operation(id);
      if (!op.intentHash || op.state === "completed") return snapshot(id);
      const state = await options.driver.status(op.intentHash);
      if (state === "held") {
        op.state = "processing";
        op.payout = "held";
        op.phase = "held";
      } else if (state === "paid" || state === "released") {
        op.state = "completed";
        op.phase = "completed";
        if (state === "released") op.payout = "released";
        op.proof = undefined;
        op.stopCapture?.();
      } else if (op.state !== "action_required") {
        op.state = state === "unknown" ? "in_doubt" : "processing";
      }
      return snapshot(id);
    },
    recover: (id) => provider.status(id),
  };
  return {
    provider,
    checkReadiness,
    setupRequired: () => setup,
    setupAvailability: () =>
      setup ? { state: "setup_required" as const, requirement_codes: [setup] } : undefined,
    phase: (id: string) => operation(id).phase,
    /** Private rendered provider instructions, never a bridge/snapshot payload. */
    paymentRecipient: (id: string) => operation(id).paymentRecipient,
    expiresAt: (id: string) => operation(id).expiresAt,
    connectFromGesture: () => extension.requestConnection(),
    installFromGesture: () => extension.openInstallPage(),
    /** Call directly in the click handler BEFORE any await or client command. */
    openFromGesture(id: string) {
      const op = operation(id);
      if (
        capturing ||
        op.phase !== "payment" ||
        !op.intentHash ||
        !op.expiresAt ||
        op.expiresAt <= now() ||
        !readiness ||
        readiness.platform !== op.offer.rail.id ||
        readiness.code ||
        now() - readiness.at > 30_000 ||
        isPeerMobileWeb()
      )
        return false;
      capturing = id;
      op.phase = "capture";
      op.capture = new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const unsubscribe = extension.onMetadataMessage((message) => {
          if (capturing !== id) return;
          const proof = paymentMatches(message, op);
          if (!proof) return;
          op.proof = proof;
          stop(true);
        });
        function stop(accepted: boolean) {
          unsubscribe();
          clearTimeout(timer);
          capturing = undefined;
          resolve(accepted);
        }
        timer = setTimeout(() => stop(false), Math.min(120_000, op.expiresAt! - now()));
        op.stopCapture = () => stop(false);
      });
      try {
        extension.authenticate({
          platform: op.offer.rail.id,
          actionType: `transfer_${op.offer.rail.id}`,
          captureMode: "buyerTee",
          attestationServiceUrl: PEER_ATTESTATION_ORIGIN,
          callerAddress: op.intent.recipient,
        });
      } catch {
        op.stopCapture?.();
        return false;
      }
      return true;
    },
    dispose() {
      for (const op of operations.values()) {
        op.stopCapture?.();
        op.proof = undefined;
      }
      operations.clear();
    },
  };
}
export type PeerOnrampRuntime = ReturnType<typeof createPeerOnrampProvider>;
