// Durable private file writes, as the CLI has always made them: a fsynced temporary file, then an
// atomic rename (replace) or link (create, never overwriting), then a fsync of the directory.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Atomically replaces `path` with `bytes` (mode 0600) and durably publishes it. */
export function writePrivateFileAtomic(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  syncDirectory(dirname(path));
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a private file without overwrite and durably publishes its directory entry. */
export function writePrivateFileExclusive(path: string, bytes: Uint8Array): void {
  const finalPath = resolve(path);
  const parent = dirname(finalPath);
  const temporary = join(parent, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  let published = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, finalPath);
    published = true;
    syncDirectory(parent);
  } catch (error) {
    if (published) {
      unlinkSync(finalPath);
      syncDirectory(parent);
    }
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Creates both backup copies as one application-level operation. Final paths appear only after
 * each complete temp file is fsynced. If either final link fails, the other is rolled back, so a
 * retry cannot be mistaken for a successful two-copy backup.
 */
export function writeBackupCopies(bytes: Uint8Array, firstPath: string, secondPath: string): void {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (first === second) throw new Error("backup paths must identify two different files");
  if (existsSync(first) || existsSync(second)) {
    throw new Error("backup refuses to overwrite an existing copy");
  }

  const nonce = randomUUID();
  const firstTmp = join(dirname(first), `.${basename(first)}.${nonce}.tmp`);
  const secondTmp = join(dirname(second), `.${basename(second)}.${nonce}.tmp`);
  const createdFinals: string[] = [];

  try {
    for (const temporary of [firstTmp, secondTmp]) {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    linkSync(firstTmp, first);
    createdFinals.push(first);
    linkSync(secondTmp, second);
    createdFinals.push(second);
    for (const parent of new Set([dirname(first), dirname(second)])) {
      syncDirectory(parent);
    }
  } catch (error) {
    for (const finalPath of createdFinals) {
      try {
        unlinkSync(finalPath);
      } catch {
        // Preserve the original failure; a remaining final path is visible and never overwritten.
      }
    }
    for (const parent of new Set(createdFinals.map(dirname))) {
      try {
        syncDirectory(parent);
      } catch {
        // Preserve the publication failure; the retry still refuses any surviving final path.
      }
    }
    throw error;
  } finally {
    for (const temporary of [firstTmp, secondTmp]) {
      try {
        unlinkSync(temporary);
      } catch {
        // The final path, not a best-effort temp cleanup, determines operation success.
      }
    }
  }
}
