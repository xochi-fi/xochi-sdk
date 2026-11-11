/**
 * One wait budget for every render suite, because there were eleven and they
 * disagreed.
 *
 * WHAT WENT WRONG. Seven files carried `vi.setConfig({ testTimeout: 20_000 })`
 * and the rest took vitest's 5000ms default, while individual waits inside them
 * ranged from RTL's 1000ms default through 3000, 10_000 and 12_000. Two
 * consequences, both observed under `vitest run src --maxWorkers=20`:
 *
 * - A file whose inner budgets SUM past its outer ceiling can never report
 *   which wait stalled. `legInvalidation` held 54s of inner budget against a
 *   20s ceiling, so the outer timeout always won and every slow run failed as
 *   `Test timed out in 20000ms` with no assertion at all.
 * - A wait left on the 1000ms default is thin for a state change gated on
 *   useIntent's 500ms quote debounce, so it fails first and its file's generous
 *   outer ceiling never gets a say.
 *
 * A timeout is not slack. `waitFor` returns the moment its condition holds and
 * a test ends the moment it passes, so none of these numbers are spent on a
 * green run -- their only job is to exceed the slowest legitimate work on a
 * contended machine, and to let the FAILING assertion be the thing that
 * reports. Sizing them is therefore about being readable when red, not about
 * being permissive.
 *
 * WHAT THESE NUMBERS ARE NOT. They are not a fix for a test that races. A
 * `waitFor` on real timers polls until a condition holds; if the condition can
 * flicker, more wall clock widens the window rather than closing it. Nothing
 * here is a substitute for anchoring on a positive condition before asserting
 * an absence (see the comment in `legInvalidation.test.tsx`).
 */

/** One wait's ceiling. Observed worst legitimate wait is ~1s on a loaded box. */
export const STEP_MS = 8_000;

/**
 * Poll rate, over RTL's 50ms default.
 *
 * Most waits in these suites are role queries with regex names, and every poll
 * recomputes an accessible name for every matching element in the tree --
 * expensive in jsdom. At 50ms an 8s wait burns up to 160 of those, competing
 * for CPU with the render it is waiting for. Measured back-to-back on one
 * machine over `legInvalidation`: 47.2s -> 32.7s loaded, 14.2s -> 8.5s quieter.
 * Costs at most one extra interval of latency when the condition does hold.
 */
export const POLL_MS = 250;

/** Every `waitFor`/`findBy` in a render suite takes these. */
export const WAIT = { timeout: STEP_MS, interval: POLL_MS } as const;

/**
 * One `renderTrade`, plus whatever it kicks off (wagmi connect, the capability
 * read, a first quote cycle). 0.3-4s unloaded depending on the tree.
 */
export const RENDER_MS = 8_000;

/**
 * A file's `testTimeout`, DERIVED from its longest single test rather than
 * chosen next to it -- which is what let the two drift apart.
 *
 * Count the longest path, not the loudest one: include waits reached through
 * helpers, and count a test that renders twice as two renders. Over-counting is
 * free, because an unspent budget costs a green run nothing.
 */
export const testBudget = ({ renders, waits }: { renders: number; waits: number }): number =>
  renders * RENDER_MS + waits * STEP_MS;
