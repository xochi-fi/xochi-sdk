// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import {
  checkRampCommand,
  parseRamp,
  rampOutcome,
  RAMP_CONTRACT_VERSION,
  type RampAction,
  type RampCommand,
  type RampCommandContext,
  type RampIntent,
  type RampLegName,
  type RampLegSnapshot,
  type RampOffer,
  type RampPreview,
  type RampSnapshot,
} from "./ramp.js";
import {
  immutable,
  type RampOperationStore,
  type RampOperationRecord,
} from "./rampOperationStore.js";
import type { RampProvider, XochiRampLeg } from "./rampProvider.js";

export interface RampClient {
  discover(intent: RampIntent, signal?: AbortSignal): Promise<readonly RampOffer[]>;
  preview(
    intent: RampIntent,
    offerId: string,
    capabilityRevision: string,
    signal?: AbortSignal,
  ): Promise<RampPreview>;
  approve(
    operationId: string,
    quoteId: string,
    acceptedDisclosureCodes: readonly string[],
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
  interact(
    operationId: string,
    options: {
      readonly presentation?: "inline" | "popup" | "same-window";
      readonly signal?: AbortSignal;
    },
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
  get(operationId: string): Promise<RampSnapshot>;
  recover(
    operationId: string,
    leg: RampLegName,
    action: RampAction,
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
}

function wire<K extends "intent" | "offer" | "preview" | "snapshot" | "command">(
  value: unknown,
  kind: K,
): Extract<import("./ramp.js").RampWire, { kind: K }> {
  const result = parseRamp(value);
  if (!result.ok || result.value.kind !== kind) throw new Error("invalid_request");
  return immutable(result.value) as Extract<import("./ramp.js").RampWire, { kind: K }>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function hash(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
function ended(leg: RampLegSnapshot): boolean {
  return (
    ["completed", "refunded", "skipped"].includes(leg.state) ||
    (leg.state === "failed" && !leg.recoverable)
  );
}
function active(snapshot: RampSnapshot): RampLegName | undefined {
  for (const name of snapshot.leg_order) {
    const leg = snapshot[name]!;
    if (!ended(leg)) return name;
    if (leg.state !== "completed") return undefined;
  }
  return undefined;
}
function actions(snapshot: RampSnapshot): RampAction[] {
  if (rampOutcome(snapshot).terminal) return [];
  if ([snapshot.peer.state, snapshot.xochi?.state].includes("in_doubt")) return ["check_status"];
  const name = active(snapshot);
  if (!name) return [];
  const leg = snapshot[name]!;
  switch (leg.state) {
    case "not_started":
    case "quoted":
    case "approval_required":
      return name === "peer"
        ? ["approve"]
        : snapshot.direction === "onramp"
          ? ["approve_route", "skip_route"]
          : ["approve_route"];
    case "action_required":
      return name === "peer"
        ? ["interact", "check_status"]
        : snapshot.direction === "onramp"
          ? ["execute_route", "skip_route"]
          : ["execute_route"];
    case "processing":
      return ["check_status"];
    case "failed":
      return leg.recoverable
        ? [name === "peer" ? "recover_peer" : "recover_route", "check_status"]
        : [];
    default:
      return [];
  }
}
function derive(snapshot: RampSnapshot): RampSnapshot {
  const first = snapshot.leg_order[0];
  const last = snapshot.leg_order[1];
  if (
    last &&
    ended(snapshot[first]!) &&
    snapshot[first]!.state !== "completed" &&
    ["quoted", "not_started", "approval_required"].includes(snapshot[last]!.state)
  ) {
    snapshot = { ...snapshot, [last]: { name: last, state: "skipped", recoverable: false } };
  }
  return wire(
    { ...snapshot, terminal: rampOutcome(snapshot).terminal, allowed_actions: actions(snapshot) },
    "snapshot",
  );
}
function doubt(snapshot: RampSnapshot, leg: RampLegName): RampSnapshot {
  return derive({
    ...snapshot,
    [leg]: {
      name: leg,
      state: "in_doubt",
      recoverable: true,
      failure_code: leg === "peer" ? "peer_in_doubt" : "xochi_in_doubt",
    },
  });
}

/** The store owns atomic reservation; adapters own private provider handles and wallet boundaries. */
export function createRampClient(options: {
  readonly peer: RampProvider;
  readonly xochi?: XochiRampLeg;
  readonly store: RampOperationStore;
  /** Unknown results after this deadline are reconciled, never resubmitted. */
  readonly commandTimeoutMs?: number;
}): RampClient {
  const { peer, xochi, store } = options;
  const timeoutMs = options.commandTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_request");
  async function external<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("provider_timeout")), timeoutMs);
          abort = () => reject(new Error("provider_timeout"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
        Promise.resolve().then(() => {
          if (signal?.aborted) throw new Error("provider_timeout");
          return call();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  const quotes = new Map<string, { intent: RampIntent; offer: RampOffer; preview: RampPreview }>();
  async function current(id: string): Promise<RampOperationRecord> {
    const record = await store.get(id);
    if (!record) throw new Error("invalid_request");
    return record;
  }
  async function discover(input: RampIntent, signal?: AbortSignal): Promise<readonly RampOffer[]> {
    const intent = wire(input, "intent");
    try {
      const raw = await external(() => peer.capabilities(intent, signal), signal);
      return immutable(
        peer.normalizeCapabilities(raw, intent).map((offer) => wire(offer, "offer")),
      );
    } catch {
      throw new Error("capabilities_unavailable");
    }
  }
  function selectable(offer: RampOffer, intent: RampIntent): boolean {
    const { availability } = offer;
    if (availability.state !== "available" || Date.parse(availability.valid_until) <= Date.now())
      return false;
    if (
      offer.direction !== intent.direction ||
      canonical(offer.fiat) !== canonical(intent.fiat) ||
      canonical(offer.crypto) !== canonical(intent.crypto)
    )
      return false;
    if (offer.bounds.measured_in !== intent.exact.side) return true; // Adapter validates conversion-side bounds at preview.
    const amount = BigInt(intent.exact.money.atomic);
    return (
      amount >= BigInt(offer.bounds.minimum.atomic) && amount <= BigInt(offer.bounds.maximum.atomic)
    );
  }
  async function command(input: RampCommand, signal?: AbortSignal): Promise<RampSnapshot> {
    const cmd = wire(input, "command");
    const [key, fingerprint] = await Promise.all([
      hash(cmd.context.idempotency_key),
      hash(canonical(cmd)),
    ]);
    const quote = quotes.get(cmd.operation_id);
    const reservation = await store.transact<{
      run: boolean;
      snapshot: RampSnapshot;
      original?: RampSnapshot;
    }>(cmd.operation_id, (record) => {
      if (!record) throw new Error("invalid_request");
      const receipt = record.receipts[key];
      if (receipt)
        return {
          record,
          result: {
            run: false,
            snapshot: receipt.fingerprint === fingerprint ? receipt.snapshot : record.snapshot,
          },
        };
      const s = record.snapshot;
      if (
        checkRampCommand(s, cmd) !== "accepted" ||
        (cmd.action !== "check_status" && active(s) !== cmd.leg)
      )
        return { record, result: { run: false, snapshot: s } };
      if (
        cmd.action === "check_status" &&
        s[cmd.leg]?.state !== "in_doubt" &&
        active(s) !== cmd.leg
      )
        return { record, result: { run: false, snapshot: s } };
      if (cmd.action === "approve") {
        const required = quote
          ? [
              ...quote.preview.disclosures.public_state,
              ...quote.preview.disclosures.identity_visible_to,
              ...quote.preview.disclosures.liveness_dependencies,
            ]
          : [];
        if (
          !quote ||
          (cmd.quote_id !== undefined && cmd.quote_id !== quote.preview.quote_id) ||
          (cmd.action === "approve" &&
            !required.every((code) => cmd.accepted_disclosure_codes?.includes(code)))
        )
          return { record, result: { run: false, snapshot: s } };
      }
      // Persist uncertainty BEFORE crossing any external boundary. A crash resumes via status only.
      const reserved = doubt(
        {
          ...s,
          revision: (BigInt(s.revision) + 1n).toString(),
          updated_at: new Date().toISOString(),
        },
        cmd.leg,
      );
      return {
        record: {
          snapshot: reserved,
          receipts: {
            ...record.receipts,
            [key]: {
              fingerprint,
              snapshot: reserved,
              ...(cmd.action === "execute_route" && cmd.quote_id ? { quote_id: cmd.quote_id } : {}),
            },
          },
        },
        result: { run: true, snapshot: reserved, original: s },
      };
    });
    if (!reservation.run) return reservation.snapshot;
    const reserved = reservation.snapshot;
    let result = reserved;
    const before = reservation.original!;
    let crossedBoundary = false;
    let localFailure: "quote_expired" | "quote_changed" | undefined;
    // After a provider boundary, exceptions and malformed responses mean uncertainty.
    try {
      let response: RampSnapshot;
      if (signal?.aborted) throw new Error("provider_timeout");
      if (cmd.action === "approve") {
        if (!quote) throw new Error("quote_changed");
        if (Date.parse(quote.preview.expires_at) <= Date.now()) {
          localFailure = "quote_expired";
          throw new Error("quote_expired");
        }
        // Once either leg submitted, provider/corridor identity stays pinned; a fresh
        // response may invalidate only a leg which has not yet crossed its boundary.
        if (cmd.action === "approve") {
          const offers = await discover(quote.intent);
          if (
            !offers.some(
              (offer) =>
                offer.offer_id === quote.offer.offer_id &&
                offer.capability_revision === quote.offer.capability_revision &&
                selectable(offer, quote.intent) &&
                canonical({
                  ...offer,
                  observed_at: quote.offer.observed_at,
                  availability: quote.offer.availability,
                }) === canonical(quote.offer),
            )
          ) {
            localFailure = "quote_changed";
            throw new Error("quote_changed");
          }
        }
      }
      if (quote && cmd.action === "approve" && Date.parse(quote.preview.expires_at) <= Date.now()) {
        localFailure = "quote_expired";
        throw new Error("quote_expired");
      }
      // A concurrent reconciliation may have resolved the reservation while live
      // capabilities were being checked. Never submit against that newer revision.
      if ((await current(cmd.operation_id)).snapshot.revision !== reserved.revision)
        throw new Error("session_conflict");
      crossedBoundary = true;
      if (cmd.action === "skip_route")
        response = derive({
          ...reserved,
          xochi: { name: "xochi", state: "skipped", recoverable: false },
        });
      else if (cmd.action === "check_status")
        response =
          cmd.leg === "peer"
            ? await external(() => peer.status(cmd.operation_id))
            : await external(() => xochi!.status(cmd.operation_id));
      else if (cmd.leg === "peer") {
        if (cmd.action === "approve")
          response = await external(() => peer.approve(quote!.preview, cmd.context));
        else if (cmd.action === "interact")
          response = await external(() => peer.interact(cmd.operation_id, cmd.context), signal);
        else
          response = await external(() => peer.recover(cmd.operation_id, cmd.action, cmd.context));
      } else {
        if (!xochi) throw new Error("invalid_request");
        if (cmd.action === "approve_route")
          response = await external(() => xochi!.approve(cmd.operation_id, cmd.context));
        else if (cmd.action === "execute_route")
          response = await external(() =>
            xochi!.execute(cmd.operation_id, cmd.quote_id!, cmd.context),
          );
        else
          response = await external(() =>
            xochi!.recover(cmd.operation_id, cmd.action, cmd.context),
          );
      }
      const safe = wire(response, "snapshot");
      if (
        safe.operation_id !== cmd.operation_id ||
        safe.direction !== reserved.direction ||
        canonical(safe.leg_order) !== canonical(reserved.leg_order)
      )
        throw new Error("invalid_request");
      const next = safe[cmd.leg];
      if (!next || ["not_started", "quoted", "approval_required"].includes(next.state))
        throw new Error("invalid_request");
      if (
        cmd.action === "check_status" &&
        ["processing", "in_doubt"].includes(before[cmd.leg]!.state) &&
        !["processing", "completed", "failed", "refunded", "in_doubt"].includes(next.state) &&
        // An offramp can resolve an uncertain ERC-20 approval before asking the wallet
        // to create its deposit. A processing deposit still cannot regress to execution.
        !(
          reserved.direction === "offramp" &&
          cmd.leg === "peer" &&
          before.peer.state === "in_doubt" &&
          next.state === "action_required"
        )
      )
        throw new Error("invalid_request");
      if (cmd.action === "execute_route" && next.state === "action_required")
        throw new Error("invalid_request");
      // A provider controls only its targeted leg, never a previously successful leg.
      result = derive({ ...reserved, [cmd.leg]: next });
    } catch {
      result = crossedBoundary
        ? doubt(reserved, cmd.leg)
        : localFailure
          ? derive({
              ...reserved,
              [cmd.leg]: {
                name: cmd.leg,
                state: "failed",
                recoverable: false,
                failure_code: localFailure,
              },
            })
          : derive({ ...before, revision: reserved.revision });
    }
    return store.transact(cmd.operation_id, (record) => {
      if (!record) throw new Error("invalid_request");
      // A concurrent reconciliation can supersede this response; never overwrite it.
      if (record.snapshot.revision !== reserved.revision)
        return { record, result: record.snapshot };
      const snapshot = derive({
        ...result,
        revision: (BigInt(reserved.revision) + 1n).toString(),
        updated_at: new Date().toISOString(),
      });
      return {
        record: {
          snapshot,
          receipts: {
            ...record.receipts,
            [key]: {
              fingerprint,
              snapshot,
              ...(cmd.action === "execute_route" && cmd.quote_id ? { quote_id: cmd.quote_id } : {}),
            },
          },
        },
        result: snapshot,
      };
    });
  }
  function make(
    id: string,
    leg: RampLegName,
    action: RampAction,
    context: RampCommandContext,
    extra: Partial<RampCommand> = {},
  ): RampCommand {
    return {
      contract_version: RAMP_CONTRACT_VERSION,
      kind: "command",
      operation_id: id,
      leg,
      action,
      context,
      ...extra,
    };
  }
  return {
    discover,
    async preview(input, offerId, revision, signal) {
      const intent = wire(input, "intent");
      const offers = await discover(intent, signal);
      const offer = offers.find(
        (o) =>
          o.offer_id === offerId && o.capability_revision === revision && selectable(o, intent),
      );
      if (!offer) throw new Error("capability_unavailable");
      let preview: RampPreview;
      try {
        preview = wire(
          await external(() => peer.preview(intent, offer, signal), signal),
          "preview",
        );
      } catch {
        throw new Error("invalid_request");
      }
      const order = intent.route
        ? intent.direction === "onramp"
          ? ["peer", "xochi"]
          : ["xochi", "peer"]
        : ["peer"];
      if (
        preview.offer_id !== offerId ||
        preview.capability_revision !== revision ||
        canonical(preview.leg_order) !== canonical(order) ||
        (intent.route && !xochi) ||
        Date.parse(preview.expires_at) <= Date.now()
      )
        throw new Error("quote_changed");
      const snapshot = derive({
        contract_version: RAMP_CONTRACT_VERSION,
        kind: "snapshot",
        operation_id: preview.operation_id,
        revision: "0",
        direction: intent.direction,
        leg_order: preview.leg_order,
        peer: { name: "peer", state: "quoted", recoverable: false },
        ...(intent.route
          ? { xochi: { name: "xochi" as const, state: "quoted" as const, recoverable: false } }
          : {}),
        allowed_actions: [],
        terminal: false,
        updated_at: new Date().toISOString(),
      });
      await store.transact(preview.operation_id, (record) => {
        if (record) throw new Error("session_conflict");
        return { record: { snapshot, receipts: {} }, result: undefined };
      });
      quotes.set(preview.operation_id, { intent, offer, preview });
      return preview;
    },
    async get(id) {
      return (await current(id)).snapshot;
    },
    approve(id, quoteId, codes, context) {
      return command(
        make(id, "peer", "approve", context, {
          quote_id: quoteId,
          accepted_disclosure_codes: [...codes],
        }),
      );
    },
    interact(id, settings, context) {
      return command(make(id, "peer", "interact", context), settings.signal);
    },
    async recover(id, leg, action, context) {
      let quoteId: string | undefined;
      if (action === "execute_route") {
        const record = await current(id);
        const receipt = record.receipts[await hash(context.idempotency_key)];
        quoteId = receipt?.quote_id;
        if (!quoteId) {
          if (!xochi) return record.snapshot;
          try {
            quoteId = await external(() => xochi.quoteId(id));
          } catch {
            return record.snapshot;
          }
        }
      }
      return command(make(id, leg, action, context, quoteId ? { quote_id: quoteId } : {}));
    },
  };
}
