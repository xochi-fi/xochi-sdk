import {
  createMemoryRampOperationStore,
  RampMoneySchema,
  RampSnapshotSchema,
  type XochiRampPreview,
  createXochiRampLeg,
  type RampMoney,
  type RampSnapshot,
  type XochiRampDriver,
} from "@xochi/client";

import { z } from "zod";

type CheckpointStorage = Pick<Storage, "getItem" | "setItem">;
const checkpointSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  source: RampMoneySchema,
  snapshot: RampSnapshotSchema,
  preview: z
    .object({
      quoteId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      expiresAt: z.string().datetime(),
      pay: RampMoneySchema,
      receive: RampMoneySchema,
      recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      settlement: z.literal("public"),
    })
    .optional(),
});
const checkpointKey = (wallet: string) => `xochi:w6:1:${wallet.toLowerCase()}`;
function browserStorage(): CheckpointStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
/** One sanitized wallet-scoped index; invalid or inaccessible storage fails closed. */
export function readOfframpPrerequisite(wallet: string, storage = browserStorage()) {
  if (!storage) return;
  const raw = storage.getItem(checkpointKey(wallet));
  if (raw === null) return;
  const value = checkpointSchema.parse(JSON.parse(raw));
  if (
    value.wallet.toLowerCase() !== wallet.toLowerCase() ||
    value.snapshot.direction !== "offramp" ||
    value.snapshot.peer.state !== "not_started" ||
    !value.snapshot.xochi ||
    (value.preview &&
      (value.preview.recipient.toLowerCase() !== wallet.toLowerCase() ||
        JSON.stringify(value.source) !== JSON.stringify(value.preview.pay)))
  )
    throw new Error("invalid_checkpoint");
  return value;
}

/** UI reads distinguish an empty index from storage that cannot be trusted. */
export function inspectOfframpPrerequisite(wallet: string) {
  try {
    return readOfframpPrerequisite(wallet);
  } catch {
    return null;
  }
}

/** Independent prerequisite receipt; Peer never mutates or re-executes this leg. */
export function createOfframpPrerequisite(options: {
  source: RampMoney;
  driver: XochiRampDriver;
  wallet: string;
  spendable(wallet: string): Promise<bigint>;
  now?: () => number;
  id?: string;
  storage?: CheckpointStorage;
}) {
  const storage = options.storage ?? browserStorage();
  const restored = readOfframpPrerequisite(options.wallet, storage);
  const id = restored?.snapshot.operation_id ?? options.id ?? crypto.randomUUID();
  let receiptPreview: XochiRampPreview | undefined = restored?.preview;
  const store = createMemoryRampOperationStore();
  let snapshot: RampSnapshot = restored?.snapshot ?? {
    contract_version: "ramp/1",
    kind: "snapshot",
    operation_id: id,
    revision: "0",
    direction: "offramp",
    leg_order: ["xochi", "peer"],
    peer: { name: "peer", state: "not_started", recoverable: false },
    xochi: { name: "xochi", state: "not_started", recoverable: false },
    allowed_actions: [],
    updated_at: new Date((options.now ?? Date.now)()).toISOString(),
    terminal: false,
  };
  const leg = createXochiRampLeg({
    store,
    driver: options.driver,
    delivered: restored?.source ?? options.source,
    direction: "offramp",
    now: options.now,
  });
  let busy = false;
  let durable = !!restored;
  async function save(next: RampSnapshot) {
    const clean = checkpointSchema.parse({
      wallet: options.wallet,
      source: restored?.source ?? options.source,
      snapshot: next,
      preview: leg.preview(id) ?? receiptPreview,
    });
    if (durable) storage?.setItem(checkpointKey(options.wallet), JSON.stringify(clean));
    receiptPreview = clean.preview;
    snapshot = next;
    await store.transact(id, () => ({ record: { snapshot, receipts: {} }, result: undefined }));
  }

  async function run(action: "quote" | "execute" | "check") {
    if (busy) return snapshot;
    busy = true;
    try {
      const latest = readOfframpPrerequisite(options.wallet, storage);
      if (latest && latest.snapshot.operation_id !== id) throw new Error("checkpoint_changed");
      if (latest) {
        snapshot = latest.snapshot;
        receiptPreview = latest.preview;
      }
      await store.transact(id, () => ({ record: { snapshot, receipts: {} }, result: undefined }));
      const state = snapshot.xochi!.state;
      if (state === "completed") return snapshot;
      if (action === "quote") {
        if (!["not_started", "failed", "action_required"].includes(state)) return snapshot;
        await save(
          await leg.approve(id, {
            expected_revision: snapshot.revision,
            idempotency_key: crypto.randomUUID(),
          }),
        );
      } else if (action === "execute") {
        if (state !== "action_required") return snapshot;
        const quote = leg.preview(id);
        if (!quote || quote.recipient.toLowerCase() !== options.wallet.toLowerCase())
          throw new Error("invalid_request");
        // Reserve before any wallet work so concurrent clicks cannot repeat the route.
        durable = true;
        await save({ ...snapshot, xochi: { name: "xochi", state: "in_doubt", recoverable: true } });
        await save(
          await leg.execute(id, quote.quoteId, {
            expected_revision: snapshot.revision,
            idempotency_key: crypto.randomUUID(),
          }),
        );
      } else if (["processing", "in_doubt"].includes(state)) await save(await leg.status(id));
      return snapshot;
    } finally {
      busy = false;
    }
  }
  return {
    act(action: "quote" | "execute" | "check") {
      if (typeof window !== "undefined") {
        if (!navigator.locks) return Promise.reject(new Error("checkpoint_lock_unavailable"));
        return navigator.locks.request(checkpointKey(options.wallet), () => run(action));
      }
      return run(action);
    },
    snapshot: () => snapshot,
    preview: () => receiptPreview,
    /** Recheck immediately before Peer approval, including after prior success. */
    async funded(amount: string) {
      if (snapshot.xochi?.state !== "completed" || !/^[1-9][0-9]*$/.test(amount)) return false;
      const quote = leg.preview(id) ?? receiptPreview;
      if (!quote || BigInt(amount) > BigInt(quote.receive.atomic)) return false;
      try {
        return (await options.spendable(options.wallet)) >= BigInt(amount);
      } catch {
        return false;
      }
    },
  };
}
export type OfframpPrerequisite = ReturnType<typeof createOfframpPrerequisite>;
