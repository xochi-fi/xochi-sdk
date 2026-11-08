// KeyValueStore on IndexedDB, chosen over OPFS because IndexedDB gives the port's guarantees
// natively. `add()` is an atomic create-if-absent (ConstraintError), and readwrite transactions on
// one object store run one at a time across tabs and workers. `put()` replaces in one transaction.
// With `durability: "strict"` a transaction completes only after its write is flushed to disk, and
// every method resolves on `complete`. OPFS has no create-if-absent (`getFileHandle({ create: true
// })` opens an existing file); main-thread `createWritable()` swaps atomically on `close()` but
// promises no flush; worker-only `createSyncAccessHandle().flush()` is durable but writes in place,
// so a crash mid-write tears the value.
import { KeyExistsError, type KeyValueStore } from "../../ports.js";

const OBJECT_STORE = "kv";
const MAX_KEY_LENGTH = 512;
const KEY = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/;
const PREFIX = /^(?:[a-z0-9][a-z0-9._-]{0,127}\/)+$/;

function assertKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH || !KEY.test(key)) {
    throw new TypeError(`invalid key ${JSON.stringify(key)}`);
  }
}

export class IndexedDbKeyValueStore implements KeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(databaseName: string): Promise<IndexedDbKeyValueStore> {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
    request.onsuccess = () => opened.resolve(request.result);
    request.onerror = () => opened.reject(request.error);
    return new IndexedDbKeyValueStore(await opened.promise);
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const value = await this.transact("readonly", (store) => store.get(key));
    return value === undefined ? null : (value as Uint8Array);
  }

  async create(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    try {
      await this.transact("readwrite", (store) => store.add(value.slice(), key));
    } catch (error) {
      if (error instanceof DOMException && error.name === "ConstraintError") {
        throw new KeyExistsError(key);
      }
      throw error;
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    await this.transact("readwrite", (store) => store.put(value.slice(), key));
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.transact("readwrite", (store) => store.delete(key));
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix.length > MAX_KEY_LENGTH || !PREFIX.test(prefix)) {
      throw new TypeError(`invalid prefix ${JSON.stringify(prefix)}`);
    }
    // Every key starting with "a/" sorts in ["a/", "a0"): "0" is the code unit after "/".
    const range = IDBKeyRange.bound(prefix, `${prefix.slice(0, -1)}0`, false, true);
    const keys = await this.transact("readonly", (store) => store.getAllKeys(range));
    return keys as string[];
  }

  close(): void {
    this.db.close();
  }

  private transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const done = Promise.withResolvers<T>();
    const transaction = this.db.transaction(OBJECT_STORE, mode, { durability: "strict" });
    const request = operation(transaction.objectStore(OBJECT_STORE));
    transaction.oncomplete = () => done.resolve(request.result);
    transaction.onabort = () =>
      done.reject(transaction.error ?? request.error ?? new Error("IndexedDB transaction aborted"));
    return done.promise;
  }
}
