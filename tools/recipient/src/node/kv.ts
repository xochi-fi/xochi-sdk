// `KeyValueStore` over the data directory, key for key onto the paths the CLI has always used:
// `operations/<id>.json`, `operations/active.lock`, `operations/released-*.lock`,
// `receipts/<intentId>.json`, `exits/<txHash>.json`, `state.json`. Files are 0600 in 0700
// directories. `put` is writePrivateJson's fsynced temp file + rename; `create` is the fsynced
// temp file + link that never overwrites (an existing key is `KeyExistsError`); every write and
// delete fsyncs the directory before it resolves.

import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { KeyExistsError, type KeyValueStore } from "../core/ports.js";
import { syncDirectory, writePrivateFileAtomic, writePrivateFileExclusive } from "./files.js";

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export class NodeKeyValueStore implements KeyValueStore {
  constructor(readonly root: string) {}

  /** The file a key names. Refuses keys outside the port's grammar (no `..`, no absolute paths). */
  pathOf(key: string): string {
    const segments = key.split("/");
    if (key.length > 512 || !segments.every((segment) => SEGMENT.test(segment))) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return join(this.root, ...segments);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return readFileSync(this.pathOf(key));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async create(key: string, value: Uint8Array): Promise<void> {
    const path = this.pathOf(key);
    this.privateParent(path);
    try {
      writePrivateFileExclusive(path, value);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new KeyExistsError(key);
      throw error;
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const path = this.pathOf(key);
    this.privateParent(path);
    writePrivateFileAtomic(path, value);
  }

  async delete(key: string): Promise<void> {
    const path = this.pathOf(key);
    unlinkSync(path);
    syncDirectory(dirname(path));
  }

  async list(prefix: string): Promise<string[]> {
    if (!prefix.endsWith("/")) throw new Error(`storage prefix must end with "/": ${prefix}`);
    let entries;
    try {
      entries = readdirSync(this.pathOf(prefix.slice(0, -1)), { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && SEGMENT.test(entry.name))
      .map((entry) => `${prefix}${entry.name}`)
      .sort();
  }

  private privateParent(path: string): void {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
}
