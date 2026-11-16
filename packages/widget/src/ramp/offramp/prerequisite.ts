import {
  createMemoryRampOperationStore,
  createXochiRampLeg,
  type RampMoney,
  type RampSnapshot,
  type XochiRampDriver,
} from "@xochi/client";

/** Independent prerequisite receipt; Peer never mutates or re-executes this leg. */
export function createOfframpPrerequisite(options: {
  source: RampMoney;
  driver: XochiRampDriver;
  wallet: string;
  spendable(wallet: string): Promise<bigint>;
  now?: () => number;
  id?: string;
}) {
  const id = options.id ?? crypto.randomUUID();
  const store = createMemoryRampOperationStore();
  let snapshot: RampSnapshot = {
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
    delivered: options.source,
    direction: "offramp",
    now: options.now,
  });
  let busy = false;
  async function save(next: RampSnapshot) {
    snapshot = next;
    await store.transact(id, () => ({ record: { snapshot, receipts: {} }, result: undefined }));
  }
  const ready = save(snapshot);
  async function act(action: "quote" | "execute" | "check") {
    if (busy) return snapshot;
    busy = true;
    try {
      await ready;
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
    act,
    snapshot: () => snapshot,
    preview: () => leg.preview(id),
    /** Recheck immediately before Peer approval, including after prior success. */
    async funded(amount: string) {
      if (snapshot.xochi?.state !== "completed" || !/^[1-9][0-9]*$/.test(amount)) return false;
      const quote = leg.preview(id);
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
