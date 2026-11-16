// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { parseRamp, RampCommandSchema, type RampSnapshot } from "./ramp.js";

export interface RampStoredReceipt {
  readonly fingerprint: string;
  readonly quote_id?: string;
  readonly snapshot: RampSnapshot;
}
/** Deliberately contains no intent, quote, recipient or adapter-private handles. */
export interface RampOperationRecord {
  readonly snapshot: RampSnapshot;
  readonly receipts: Readonly<Record<string, RampStoredReceipt>>;
}

/** Implementations must serialize transactions across all clients sharing their storage. */
export interface RampOperationStore {
  get(operationId: string): Promise<RampOperationRecord | undefined>;
  transact<T>(
    operationId: string,
    update: (current: RampOperationRecord | undefined) => {
      record: RampOperationRecord;
      result: T;
    },
  ): Promise<T>;
}

export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function cleanSnapshot(value: unknown): RampSnapshot {
  const parsed = parseRamp(value);
  if (!parsed.ok || parsed.value.kind !== "snapshot") throw new Error("invalid_request");
  return immutable(parsed.value);
}

/** Explicit projection on every storage boundary, including data read from localStorage. */
function cleanRecord(value: RampOperationRecord): RampOperationRecord {
  const snapshot = cleanSnapshot(value.snapshot);
  const receipts: Record<string, RampStoredReceipt> = Object.create(null);
  for (const [key, receipt] of Object.entries(value.receipts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))
      throw new Error("invalid_request");
    const stored = cleanSnapshot(receipt.snapshot);
    if (stored.operation_id !== snapshot.operation_id) throw new Error("invalid_request");
    const quote = RampCommandSchema.shape.quote_id.safeParse(receipt.quote_id);
    if (!quote.success) throw new Error("invalid_request");
    receipts[key] = {
      fingerprint: receipt.fingerprint,
      snapshot: stored,
      ...(quote.data ? { quote_id: quote.data } : {}),
    };
  }
  return immutable({ snapshot, receipts });
}

export function createMemoryRampOperationStore(): RampOperationStore {
  const records = new Map<string, RampOperationRecord>();
  return {
    async get(id) {
      return records.get(id);
    },
    async transact(id, update) {
      // No await between read and write: atomic within this JavaScript runtime.
      const next = update(records.get(id));
      const record = cleanRecord(next.record);
      if (record.snapshot.operation_id !== id) throw new Error("invalid_request");
      records.set(id, record);
      return next.result;
    },
  };
}

/** Web Locks are required: localStorage alone cannot provide atomic compare-and-reserve. */
export function createBrowserRampOperationStore(options: {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly locks: Pick<LockManager, "request">;
  readonly namespace?: string;
}): RampOperationStore {
  const prefix = options.namespace ?? "xochi:ramp/1:";
  const key = (id: string) => prefix + encodeURIComponent(id);
  function read(id: string): RampOperationRecord | undefined {
    const raw = options.storage.getItem(key(id));
    if (raw === null) return undefined;
    try {
      const record = cleanRecord(JSON.parse(raw));
      if (record.snapshot.operation_id !== id) throw new Error();
      return record;
    } catch {
      throw new Error("invalid_request");
    }
  }
  return {
    async get(id) {
      return options.locks.request(key(id), () => read(id));
    },
    async transact(id, update) {
      return options.locks.request(key(id), () => {
        const next = update(read(id));
        const record = cleanRecord(next.record);
        if (record.snapshot.operation_id !== id) throw new Error("invalid_request");
        options.storage.setItem(key(id), JSON.stringify(record));
        return next.result;
      });
    },
  };
}
