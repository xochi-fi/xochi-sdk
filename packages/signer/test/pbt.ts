// Shared fast-check budget plumbing. Not a `.test.ts`, so vitest's include
// patterns do not collect it.
//
// This exists because `Number(process.env.PBT_RUNS || 200)` is not a parse: it
// is a coercion that reports failure as a value fast-check accepts.
// `PBT_RUNS=abc` yields `NaN`, `PBT_RUNS=0` yields `0`, and both make a
// property "pass" with zero rounds executed -- silently, and green. The
// stealth properties are the only cross-check of the ERC-5564 derivation
// against an independent oracle, so a run count that quietly becomes zero
// turns the check into a no-op rather than a failure.

// A positive-integer override, or the default.
//
// Absent and empty take the default. EVERYTHING ELSE THROWS -- non-numeric,
// zero, negative, fractional, Infinity. It does not silently fall back, and the
// distinction is the entire point: `Number(process.env.PBT_RUNS || 200)` was
// already a silent fallback, and replacing one silent fallback with another
// would leave `PBT_RUNS=abc` reporting green over a budget nobody asked for.
// A malformed budget is an operator error, so it fails loudly.
//
// The override may only RAISE the budget: a value below the caller's default is
// clamped up, so `PBT_RUNS=1` cannot be used to make a suite look fast.
export function pbtRuns(defaultRuns: number): number {
  // The default is a literal at every call site, so a typo there is the one
  // way a zero budget still reaches fast-check. Checked for the same reason the
  // env var is: a property that runs zero rounds passes.
  if (!Number.isInteger(defaultRuns) || defaultRuns <= 0) {
    throw new Error(
      `pbtRuns default must be a positive integer, got ${JSON.stringify(defaultRuns)}`,
    );
  }
  const raw = process.env.PBT_RUNS;
  if (raw === undefined || raw === "") return defaultRuns;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`PBT_RUNS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Math.max(n, defaultRuns);
}

// Same treatment for the seed, minus the floor: any finite integer is a valid
// seed, and a fixed default keeps the suite deterministic.
export function pbtSeed(defaultSeed = 0x5eed): number {
  const raw = process.env.PBT_SEED;
  if (raw === undefined || raw === "") return defaultSeed;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`PBT_SEED must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// The per-test ceiling for a property case. It is the second line of defence
// behind the run counts: what turns a pathological slowdown into one failed
// test rather than a hung suite. Scoped per-test rather than raised
// workspace-wide so a genuinely hung test still fails fast (see
// vitest.config.ts).
//
// 150ms/round is ~10x the measured 13ms of the heaviest case (an ECDH plus two
// scalar multiplications), and the 30s floor covers process startup on a cold
// runner at small run counts.
//
// CAPPED, because scaling with `runs` alone made it unable to do the one job it
// is described as doing. `pbtRuns` lets `PBT_RUNS` raise the budget without
// limit and this ceiling was derived from the raised value, so the timeout grew
// with the thing it was supposed to bound and could never fire for a runaway
// budget -- only for a per-round slowdown. The cap is what a human waits for
// one test; past it, raise it deliberately at the call site.
const PBT_TIMEOUT_CEILING_MS = 120_000;

export function pbtTimeoutMs(runs: number): number {
  return Math.min(PBT_TIMEOUT_CEILING_MS, Math.max(30_000, runs * 150));
}
