import type { LockHolder, LockLease, LockManager } from "../../ports.js";

/**
 * Exclusive locks across tabs and workers of one origin via the Web Locks API. A granted lock is
 * held by a pending callback until `release()`; the browser drops it when the holder's tab or
 * worker goes away, so a dead holder never wedges the lock.
 */
export class WebLocksManager implements LockManager {
  async tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null> {
    const granted = Promise.withResolvers<boolean>();
    const held = Promise.withResolvers<void>();
    const request = navigator.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        granted.resolve(lock !== null);
        if (lock !== null) await held.promise;
      },
    );
    request.catch(granted.reject);
    if (!(await granted.promise)) return null;
    return {
      name,
      holder,
      release: async () => {
        held.resolve();
        await request;
      },
    };
  }
}
