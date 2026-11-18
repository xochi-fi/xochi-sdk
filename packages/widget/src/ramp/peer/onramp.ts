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
  /**
   * Re-find an intent this wallet already signaled, after the transient runtime was
   * lost (reload). Read-only: must never sign, signal or submit. `undefined` means
   * the outcome cannot be established, which the caller treats as in doubt.
   */
  resume?(binding: PeerResumeBinding): Promise<PeerResumeResult | undefined>;
}
/** Public, sanitized facts from the local summary; no provider handle is persisted. */
export interface PeerResumeBinding {
  readonly operationId?: string;
  readonly wallet: string;
  readonly rail: string;
  readonly currency: string;
  readonly payAtomic: string;
  readonly receiveAtomic: string;
  /** The wallet approval happened at or after this time (ms). */
  readonly approvedAfter: number;
}
export type PeerResumeResult =
  | {
      kind: "active";
      intentHash: string;
      expiresAt: number;
      signaledAt: number;
      /** Absent when Peer cannot return it; the payment step then cannot be captured. */
      paymentRecipient?: string;
    }
  | { kind: "fulfilled"; intentHash: string }
  | { kind: "expired" };
export interface PeerBuyerOptions extends PeerDiscoveryOptions {
  extension: PeerExtensionSdk;
  driver: PeerBuyerDriver;
  /** Injection for deterministic environment tests; true can only narrow the real mobile gate. */
  desktop?: boolean;
}
interface Operation {
  intent: Pick<RampIntent, "recipient" | "fiat">;
  rail: string;
  quoteId?: string;
  quoteExpiresAt: string;
  payAtomic: string;
  receiveAtomic: string;
  paymentRecipient: string;
  /** Absent on a resumed operation: a lost runtime can never signal a second intent. */
  signal?: () => Promise<{
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
  fulfillAttempted?: boolean;
  failure?: "quote_expired";
  /** Public facts to re-find a lost runtime's intent; never a provider handle. */
  resumeBinding?: PeerResumeBinding;
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
        ...(op.failure ? { failure_code: op.failure } : {}),
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
      !op.paymentRecipient ||
      message.platform !== op.rail ||
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
      return parseUnits(row.amount, op.intent.fiat.decimals).toString() === op.payAtomic;
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
      actionPlatform: op.rail,
      actionType: `transfer_${op.rail}`,
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
        intent,
        rail: offer.rail.id,
        quoteId: quote.preview.quote_id,
        quoteExpiresAt: quote.preview.expires_at,
        payAtomic: quote.preview.pay.atomic,
        receiveAtomic: quote.preview.receive.atomic,
        paymentRecipient: quote.paymentRecipient,
        signal: quote.signal,
        state: "quoted",
        phase: "review",
        submitted: false,
      });
      return quote.preview;
    },
    async approve(preview) {
      const op = operation(preview.operation_id);
      if (op.submitted || !op.signal) return snapshot(preview.operation_id);
      if (preview.quote_id !== op.quoteId || Date.parse(op.quoteExpiresAt) <= now())
        throw new Error("quote_expired");
      setup = await checkReadiness(op.rail);
      if (setup) {
        op.state = "failed";
        return snapshot(preview.operation_id);
      }
      // Set before wallet/network boundary; never automatically signal a second time.
      op.submitted = true;
      const approvedAfter = now();
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
        } else {
          // The wallet transaction may have landed: reconcile by read-only lookup only.
          op.resumeBinding = {
            operationId: preview.operation_id,
            wallet: op.intent.recipient,
            rail: op.rail,
            currency: op.intent.fiat.currency,
            payAtomic: op.payAtomic,
            receiveAtomic: op.receiveAtomic,
            approvedAfter,
          };
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
        op.fulfillAttempted = true;
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
      if (!op.intentHash && op.resumeBinding && op.state === "in_doubt") await rebind(op);
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
      } else if (
        state === "pending" &&
        op.paymentRecipient &&
        !op.fulfillAttempted &&
        !op.capture &&
        !op.proof &&
        op.expiresAt !== undefined &&
        op.expiresAt > now()
      ) {
        // Signaled but never fulfilled (an interrupted capture or a reload): the
        // same intent goes back to its payment step. Nothing is signaled again.
        op.state = "action_required";
        op.phase = "payment";
      } else if (op.state !== "action_required") {
        op.state = state === "unknown" ? "in_doubt" : "processing";
      }
      return snapshot(id);
    },
    recover: (id) => provider.status(id),
  };
  /**
   * Rebind a persisted operation to this runtime after a reload or a lost runtime.
   * Uses only public summary facts; never signals, signs or submits. An unknown
   * outcome stays in doubt and allows status reconciliation only.
   */
  async function resume(
    id: string,
    summary: {
      wallet: string;
      rail: string;
      pay: RampPreview["pay"];
      receive: RampPreview["receive"];
      quoteExpiresAt: string;
      approvedAfter: number;
    },
  ): Promise<void> {
    const existing = operations.get(id);
    if (existing?.submitted) return;
    // An operation bound to another wallet can never continue in this runtime.
    if (
      summary.pay.asset.kind !== "fiat" ||
      (options.user && options.user.toLowerCase() !== summary.wallet.toLowerCase())
    )
      throw new Error("invalid_request");
    const fiat = summary.pay.asset;
    const op: Operation = {
      intent: {
        recipient: summary.wallet,
        fiat: { kind: "fiat", currency: fiat.currency, decimals: fiat.decimals },
      },
      rail: summary.rail,
      quoteExpiresAt: summary.quoteExpiresAt,
      payAtomic: summary.pay.atomic,
      receiveAtomic: summary.receive.atomic,
      paymentRecipient: "",
      state: "in_doubt",
      phase: "processing",
      submitted: true,
    };
    op.resumeBinding = {
      operationId: id,
      wallet: summary.wallet,
      rail: summary.rail,
      currency: fiat.currency,
      payAtomic: summary.pay.atomic,
      receiveAtomic: summary.receive.atomic,
      approvedAfter: summary.approvedAfter,
    };
    operations.set(id, op);
    await rebind(op);
  }
  /** Read-only lookup; an unestablished outcome leaves the operation in doubt. */
  async function rebind(op: Operation): Promise<void> {
    let found: PeerResumeResult | undefined;
    try {
      found = op.resumeBinding && (await options.driver.resume?.(op.resumeBinding));
    } catch {
      found = undefined;
    }
    if (found?.kind === "active" && found.paymentRecipient) {
      op.intentHash = found.intentHash;
      op.expiresAt = found.expiresAt;
      op.signaledAt = found.signaledAt;
      op.paymentRecipient = found.paymentRecipient;
      if (found.expiresAt > now()) {
        op.state = "action_required";
        op.phase = "payment";
      }
    } else if (found?.kind === "fulfilled") {
      op.intentHash = found.intentHash;
      op.fulfillAttempted = true;
      op.state = "processing";
    } else if (found?.kind === "expired") {
      op.state = "failed";
      op.failure = "quote_expired";
    }
  }

  return {
    provider,
    resume,
    checkReadiness,
    setupRequired: () => setup,
    setupAvailability: () =>
      setup ? { state: "setup_required" as const, requirement_codes: [setup] } : undefined,
    phase: (id: string) => operations.get(id)?.phase,
    rail: (id: string) => operations.get(id)?.rail,
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
        readiness.platform !== op.rail ||
        !op.paymentRecipient ||
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
          platform: op.rail,
          actionType: `transfer_${op.rail}`,
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
