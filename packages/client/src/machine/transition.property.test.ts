/**
 * Property-based tests for applyStatusTransition over random state machines.
 *
 * Generates an arbitrary transition table, previous state, target, and updates,
 * then checks the reducer contract from angles independent of its body:
 *   1. Guarded: a disallowed move returns the SAME object (reference) untouched.
 *   2. Accepted: an allowed move sets status=to and merges only the updates.
 *   3. Validity: result.status is always either `to` or the prior status.
 *   4. Purity: prev is never mutated; repeated calls are deep-equal.
 *
 * Seed fixed for reproducible CI.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyStatusTransition } from "./transition.js";

const SEED = 0x57a7;
const FC_SETTINGS = { seed: SEED, numRuns: 300 } as const;

const STATUSES = ["a", "b", "c", "d"] as const;

const tableArb = fc.record({
  a: fc.subarray([...STATUSES]),
  b: fc.subarray([...STATUSES]),
  c: fc.subarray([...STATUSES]),
  d: fc.subarray([...STATUSES]),
});
const prevArb = fc.record({
  status: fc.constantFrom(...STATUSES),
  n: fc.integer(),
  tag: fc.string(),
});
const updatesArb = fc.record({ n: fc.integer(), tag: fc.string() }, { requiredKeys: [] });
const toArb = fc.constantFrom(...STATUSES);

describe("applyStatusTransition properties", () => {
  it("guards, accepts, validates, and stays pure for any machine", () => {
    fc.assert(
      fc.property(tableArb, prevArb, toArb, updatesArb, (table, prev, to, updates) => {
        const can = (from: string, t: string): boolean =>
          (table as Record<string, string[]>)[from]?.includes(t) ?? false;
        const snapshot = JSON.stringify(prev);

        const result = applyStatusTransition(prev, to, can, updates);

        // 4. purity: prev untouched
        expect(JSON.stringify(prev)).toBe(snapshot);
        // 3. validity: status is either the target or unchanged
        expect([to, prev.status]).toContain(result.status);

        if (can(prev.status, to)) {
          // 2. accepted
          expect(result.status).toBe(to);
          expect(result.n).toBe("n" in updates ? updates.n : prev.n);
          expect(result.tag).toBe("tag" in updates ? updates.tag : prev.tag);
        } else {
          // 1. guarded: same reference, no merge
          expect(result).toBe(prev);
        }

        // 4. determinism
        const again = applyStatusTransition(prev, to, can, updates);
        expect(again).toEqual(result);
      }),
      FC_SETTINGS,
    );
  });
});
