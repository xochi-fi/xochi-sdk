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

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function assertKey(key: string): void {
  if (key.length > 512 || !key.split("/").every((segment) => SEGMENT.test(segment))) {
    throw new Error(`invalid key: ${key}`);
  }
}

export type KvEvent = { op: "create" | "put" | "delete"; key: string; value?: string };

export class MemoryKeyValueStore implements KeyValueStore {
  readonly entries = new Map<string, Uint8Array>();
  /** Every completed write, in order: what was durable when. */
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
    this.events.push({ op: "create", key, value: new TextDecoder().decode(value) });
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    this.entries.set(key, value.slice());
    this.events.push({ op: "put", key, value: new TextDecoder().decode(value) });
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    this.entries.delete(key);
    this.events.push({ op: "delete", key });
  }

  async list(prefix: string): Promise<string[]> {
    if (!prefix.endsWith("/")) throw new Error(`prefix must end with "/": ${prefix}`);
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  text(key: string): string | null {
    const value = this.entries.get(key);
    return value === undefined ? null : new TextDecoder().decode(value);
  }

  json(key: string): unknown {
    const text = this.text(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  }

  setJson(key: string, value: unknown): void {
    this.entries.set(key, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
  }
}

/** Web Locks semantics: a name is held until its lease is released (a closed tab releases). */
export class MemoryLockManager implements LockManager {
  readonly held = new Map<string, LockHolder>();

  async tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null> {
    if (this.held.has(name)) return null;
    this.held.set(name, holder);
    const held = this.held;
    let released = false;
    return {
      name,
      holder,
      async release() {
        if (released) return;
        released = true;
        held.delete(name);
      },
    };
  }
}

export class FixedClock implements Clock {
  constructor(public ms = Date.parse("2026-11-08T12:00:00.000Z")) {}
  nowMs(): number {
    return this.ms;
  }
}
