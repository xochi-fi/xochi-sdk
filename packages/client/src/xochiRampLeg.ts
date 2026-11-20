// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import {
  atomic,
  RampLegSnapshotSchema,
  RampMoneySchema,
  rampOutcome,
  type RampLegSnapshot,
  type RampMoney,
  type RampSnapshot,
} from "./ramp.js";
import type { XochiRampLeg } from "./rampProvider.js";
import { immutable, type RampOperationStore } from "./rampOperationStore.js";

/** A projection of the independently validated Swap quote; no signing material. */
export interface XochiRampPreview {
  readonly quoteId: string;
  readonly expiresAt: string;
  readonly pay: RampMoney;
  readonly receive: RampMoney;
  readonly recipient: string;
  readonly settlement: "public" | "stealth";
}

/**
 * Trusted bridge to the existing Xochi quote/sign/execute/poll machine.
 * quote must fetch fresh and validate the exact route with the existing signer;
 * execute must use that held quote and the user's wallet approval. Only a
 * provably unsubmitted or returned route may report a recoverable failure.
 */
export interface XochiRampDriver {
  quote(): Promise<XochiRampPreview>;
  execute(quoteId: string): Promise<RampLegSnapshot>;
  poll(): Promise<RampLegSnapshot>;
}

export interface PreparedXochiRampLeg extends XochiRampLeg {
  preview(operationId: string): XochiRampPreview | undefined;
}

/** Independent route leg: onramp follows released Peer delivery; offramp precedes Peer. */
export function createXochiRampLeg(options: {
  readonly store: RampOperationStore;
  readonly driver: XochiRampDriver;
  readonly delivered: RampMoney;
  /** Offramp prerequisites pay the source asset and receive public Base USDC. */
  readonly direction?: "onramp" | "offramp";
  readonly now?: () => number;
}): PreparedXochiRampLeg {
  const { store, driver } = options;
  const now = options.now ?? Date.now;
  const offramp = options.direction === "offramp";
  const delivered = immutable(RampMoneySchema.parse(options.delivered));
  if (
    delivered.asset.kind !== "crypto" ||
    (!offramp &&
      (delivered.asset.chain_id !== "eip155:8453" ||
        delivered.asset.asset_id.split(":").at(-1)?.toLowerCase() !==
          "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
        delivered.asset.decimals !== 6)) ||
    BigInt(delivered.atomic) === 0n
  )
    throw new Error("invalid_request");
  const quotes = new Map<string, XochiRampPreview>();
  const submitted = new Set<string>();
  const generations = new Map<string, number>();
  async function current(id: string): Promise<RampSnapshot> {
    const snapshot = (await store.get(id))?.snapshot;
    if (
      !snapshot ||
      snapshot.direction !== (offramp ? "offramp" : "onramp") ||
      snapshot.peer.state !== (offramp ? "not_started" : "completed") ||
      snapshot.peer.payout_state === "held" ||
      !snapshot.xochi
    )
      throw new Error("invalid_request");
    return snapshot;
  }
  function withLeg(snapshot: RampSnapshot, leg: RampLegSnapshot): RampSnapshot {
    const next = { ...snapshot, xochi: { ...leg, name: "xochi" as const }, allowed_actions: [] };
    return { ...next, terminal: rampOutcome(next).terminal };
  }
  const failed = (code: "quote_expired" | "route_failed" | "quote_changed"): RampLegSnapshot => ({
    name: "xochi",
    state: "failed",
    recoverable: true,
    failure_code: code,
  });
  const doubt = (): RampLegSnapshot => ({
    name: "xochi",
    state: "in_doubt",
    recoverable: true,
    failure_code: "xochi_in_doubt",
  });
  function safeLeg(value: RampLegSnapshot): RampLegSnapshot {
    const leg = RampLegSnapshotSchema.parse(value);
    if (
      leg.name !== "xochi" ||
      leg.payout_state !== undefined ||
      !["processing", "in_doubt", "completed", "failed", "refunded"].includes(leg.state)
    )
      throw new Error("invalid_request");
    if (leg.state === "failed" && !leg.recoverable) return doubt();
    if (leg.state === "refunded") return failed("route_failed");
    return leg;
  }
  async function prepare(id: string): Promise<RampSnapshot> {
    const snapshot = await current(id);
    if (submitted.has(id)) return withLeg(snapshot, doubt());
    quotes.delete(id);
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    try {
      const quote = await driver.quote();
      const pay = RampMoneySchema.parse(quote.pay);
      const receive = RampMoneySchema.parse(quote.receive);
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(quote.quoteId) ||
        !Number.isFinite(Date.parse(quote.expiresAt)) ||
        Date.parse(quote.expiresAt) <= now() ||
        pay.asset.kind !== "crypto" ||
        (!offramp &&
          (pay.asset.chain_id !== "eip155:8453" ||
            pay.asset.asset_id.split(":").at(-1)?.toLowerCase() !==
              "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
            pay.asset.decimals !== 6)) ||
        pay.atomic !== delivered.atomic ||
        JSON.stringify(pay.asset) !== JSON.stringify(delivered.asset) ||
        BigInt(atomic(pay.atomic)) === 0n ||
        receive.asset.kind !== "crypto" ||
        (offramp &&
          (receive.asset.chain_id !== "eip155:8453" ||
            receive.asset.asset_id.split(":").at(-1)?.toLowerCase() !==
              "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
            receive.asset.decimals !== 6 ||
            BigInt(receive.atomic) === 0n ||
            quote.settlement !== "public")) ||
        !quote.recipient ||
        !["public", "stealth"].includes(quote.settlement)
      )
        throw new Error("invalid_request");
      // Recheck completion after the asynchronous quote boundary as well.
      const latest = await current(id);
      if (generations.get(id) !== generation) return withLeg(latest, failed("quote_changed"));
      quotes.set(
        id,
        immutable({
          quoteId: quote.quoteId,
          expiresAt: quote.expiresAt,
          pay,
          receive,
          recipient: quote.recipient,
          settlement: quote.settlement,
        }),
      );
      return withLeg(latest, { name: "xochi", state: "action_required", recoverable: false });
    } catch {
      return withLeg(snapshot, failed("route_failed"));
    }
  }
  return {
    preview: (id) => quotes.get(id),
    approve: (id) => prepare(id),
    async quoteId(id) {
      await current(id);
      const quote = quotes.get(id);
      if (!quote || submitted.has(id)) throw new Error("quote_changed");
      return quote.quoteId;
    },
    async execute(id, quoteId) {
      const snapshot = await current(id);
      if (submitted.has(id)) return withLeg(snapshot, doubt());
      const quote = quotes.get(id);
      if (!quote || quote.quoteId !== quoteId) return withLeg(snapshot, failed("quote_changed"));
      if (Date.parse(quote.expiresAt) <= now()) return withLeg(snapshot, failed("quote_expired"));
      // Reserve before wallet/API work. An exception or missing answer cannot permit a retry.
      submitted.add(id);
      try {
        const leg = safeLeg(await driver.execute(quoteId));
        if (leg.state === "failed" && leg.recoverable) submitted.delete(id);
        return withLeg(snapshot, leg);
      } catch {
        return withLeg(snapshot, doubt());
      }
    },
    async status(id) {
      const snapshot = await current(id);
      try {
        const leg = safeLeg(await driver.poll());
        if (leg.state === "failed" && leg.recoverable) submitted.delete(id);
        return withLeg(snapshot, leg);
      } catch {
        return withLeg(snapshot, doubt());
      }
    },
    async recover(id, action) {
      const snapshot = await current(id);
      if (action !== "recover_route" || snapshot.xochi?.state !== "in_doubt") {
        // S4 reserves in_doubt before invoking this port. Direct callers cannot reset a live route.
        throw new Error("invalid_request");
      }
      return prepare(id);
    },
  };
}
