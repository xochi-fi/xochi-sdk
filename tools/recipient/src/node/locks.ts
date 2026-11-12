// `LockManager` for the CLI: the journal's holder locks (`holderLockName`, `...:holder:<pid>`)
// are held by the process with that pid for exactly as long as it runs, as the CLI has always
// judged receipt runs and release claimants (`process.kill(pid, 0)`; the hostname is recorded for
// the operator, never compared: it can change under a live run). Cross-process exclusivity of
// the operation lock itself is `active.lock` (`NodeKeyValueStore.create`, an atomic link).

import type { LockHolder, LockLease, LockManager } from "../core/ports.js";

const HOLDER_LOCK = /:holder:([1-9][0-9]*)$/;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class NodePidLockManager implements LockManager {
  async tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null> {
    const pid = HOLDER_LOCK.exec(name)?.[1];
    if (pid === undefined) {
      throw new Error(`the CLI lock manager holds only journal holder locks: ${name}`);
    }
    if (processAlive(Number(pid))) return null;
    // A dead pid's lock is free; nothing outlives this process to release.
    return { name, holder, release: async () => undefined };
  }
}
