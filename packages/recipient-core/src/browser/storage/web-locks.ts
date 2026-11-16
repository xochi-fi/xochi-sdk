import type { LockHolder, LockLease, LockManager } from "../../ports.js";

/**
 * Exclusive locks across tabs and workers of one origin via the Web Locks API. A granted lock is
 * held by a pending callback until `release()`; the browser drops it when the holder's tab or
 * worker goes away, so a dead holder never wedges the lock. A lock another context steals
 * (`steal: true`) aborts the lease's `lost` signal with the browser's AbortError.
 */
export class WebLocksManager implements LockManager {
  async tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null> {
    const granted = Promise.withResolvers<boolean>();
    const held = Promise.withResolvers<void>();
    const lost = new AbortController();
    let isGranted = false;
    const request = navigator.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        isGranted = lock !== null;
        granted.resolve(isGranted);
        if (lock !== null) await held.promise;
      },
    );
    request.catch((error: unknown) => {
      if (isGranted) lost.abort(error);
      else granted.reject(error);
    });
    if (!(await granted.promise)) return null;
    return {
      name,
      holder,
      lost: lost.signal,
      release: async () => {
        held.resolve();
        try {
          await request;
        } catch (error) {
          // A stolen lock is already gone; `lost` carries that rejection.
          if (error !== lost.signal.reason) throw error;
        }
      },
    };
  }
}
