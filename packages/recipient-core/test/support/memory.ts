// Boundary implementations of the storage, lock and clock ports for core tests: a real
// in-memory KeyValueStore (atomic create, sorted list, key grammar), a Web-Locks-like
// LockManager (a name is held until its lease is released) and a settable clock.

import {
  KeyExistsError,
  type Clock,
  type KeyValueStore,
  type LockHolder,
  type LockLease,
  type LockManager,
} from "../../src/ports.js";

const SEGMENT = /^[a-z0-9_][a-z0-9._-]{0,127}$/;

function assertKey(key: string): void {
  if (key.length > 512 || !key.split("/").every((segment) => SEGMENT.test(segment))) {
    throw new Error(`invalid key: ${key}`);
  }
}

export type KvEvent = { op: "create" | "put" | "delete"; key: string; value?: string };

/** Resolves after a later macrotask: every microtask queued before it has run. */
function nextMacrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

/**
 * A write is applied at once (atomic create sees it) but becomes durable only on a later
 * macrotask, and its promise resolves only then, like a disk or IndexedDB commit. Code that
 * drops an `await` on a write runs on before it is durable, and `durable*` shows it.
 */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly entries = new Map<string, Uint8Array>();
  /** What survives a crash right now. */
  readonly durableEntries = new Map<string, Uint8Array>();
  /** Every write once durable, in order: what was durable when. */
  readonly events: KvEvent[] = [];

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const value = this.entries.get(key);
    return value === undefined ? null : value.slice();
  }

  async create(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    if (this.entries.has(key)) throw new KeyExistsError(key);
    this.entries.set(key, value.slice());
    await this.persist({ op: "create", key, value: new TextDecoder().decode(value) }, value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    this.entries.set(key, value.slice());
    await this.persist({ op: "put", key, value: new TextDecoder().decode(value) }, value);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    this.entries.delete(key);
    await this.persist({ op: "delete", key }, null);
  }

  async list(prefix: string): Promise<string[]> {
    if (!prefix.endsWith("/")) throw new Error(`prefix must end with "/": ${prefix}`);
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  private async persist(event: KvEvent, value: Uint8Array | null): Promise<void> {
    await nextMacrotask();
    if (value === null) this.durableEntries.delete(event.key);
    else this.durableEntries.set(event.key, value.slice());
    this.events.push(event);
  }

  text(key: string): string | null {
    const value = this.entries.get(key);
    return value === undefined ? null : new TextDecoder().decode(value);
  }

  json(key: string): unknown {
    const text = this.text(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  }

  /** The record as a crash right now would leave it. */
  durableJson(key: string): unknown {
    const value = this.durableEntries.get(key);
    return value === undefined ? null : (JSON.parse(new TextDecoder().decode(value)) as unknown);
  }

  /** Seeds a record as if written and made durable earlier. */
  setJson(key: string, value: unknown): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
    this.entries.set(key, bytes);
    this.durableEntries.set(key, bytes.slice());
  }
}

/**
 * Web Locks semantics: a name is held until its lease is released (a closed tab releases), or
 * until another context steals it (`steal`), which aborts the holder's `lost` signal.
 */
export class MemoryLockManager implements LockManager {
  readonly held = new Map<string, LockHolder>();
  private readonly losses = new Map<string, AbortController>();

  async tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null> {
    if (this.held.has(name)) return null;
    this.held.set(name, holder);
    const lost = new AbortController();
    this.losses.set(name, lost);
    const { held, losses } = this;
    let released = false;
    return {
      name,
      holder,
      lost: lost.signal,
      async release() {
        if (released) return;
        released = true;
        if (lost.signal.aborted) return;
        held.delete(name);
        losses.delete(name);
      },
    };
  }

  /** Another context takes `name` (Web Locks `steal: true`) and keeps it. */
  steal(name: string, thief: LockHolder = { id: "thief", nonce: "TEST ONLY", kind: "steal" }) {
    this.losses.get(name)?.abort(new Error(`TEST ONLY: ${name} stolen`));
    this.losses.delete(name);
    this.held.set(name, thief);
  }
}

export class FixedClock implements Clock {
  constructor(public ms = Date.parse("2026-11-08T12:00:00.000Z")) {}
  nowMs(): number {
    return this.ms;
  }
}
