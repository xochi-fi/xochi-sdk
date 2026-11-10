/**
 * Counterfactual SimpleAccount derivation -- opt-in RPC integration test.
 *
 * `computeCounterfactualAddress` derives the address via an on-chain `eth_call`
 * to the factory's `getAddress` (byte-exact parity with Riddler, which does the
 * same). That makes it inherently non-deterministic offline, and repo policy
 * forbids mocks, so this suite is SKIPPED unless a real RPC endpoint is provided:
 *
 *   STEALTH_RPC_URL=https://... npx vitest run src/lib/counterfactual-address.integration.test.ts
 *
 * Optional parity check against a Riddler-computed golden:
 *   STEALTH_RPC_URL=... \
 *   STEALTH_CF_OWNER=0x<stealth owner EOA> \
 *   STEALTH_CF_EXPECTED=0x<address Riddler computed for that owner, salt 0> \
 *   npx vitest run src/lib/counterfactual-address.integration.test.ts
 *
 * When STEALTH_CF_EXPECTED is set the test asserts exact equality with Riddler.
 * Without it, it asserts a valid, deterministic address is returned.
 */
import { createPublicClient, http, isAddress, type Hex } from "viem";
import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { computeCounterfactualAddress } from "./stealth.js";

const RPC_URL = process.env.STEALTH_RPC_URL;
const FACTORY =
  (process.env.STEALTH_CF_FACTORY as Hex | undefined) ?? (SIMPLE_ACCOUNT_FACTORY as Hex);
// A deterministic non-zero owner to derive against when no golden owner is given.
const OWNER =
  (process.env.STEALTH_CF_OWNER as Hex | undefined) ?? "0x000000000000000000000000000000000000dEaD";
const EXPECTED = process.env.STEALTH_CF_EXPECTED as Hex | undefined;

// Lazy: only build a client inside a running (non-skipped) test, so importing
// this suite without STEALTH_RPC_URL never touches the transport.
const makeClient = () => createPublicClient({ transport: http(RPC_URL) });

/**
 * Set by the nightly `stealth-cf-parity-live` job, and by nothing else, to
 * declare "this suite is not optional here".
 *
 * It cannot be `process.env.CI`: this file is part of the default suite, so the
 * ordinary `test` job (which has no RPC endpoint, by design) would fail on the
 * guards below. It has to be a signal only the dedicated job sends.
 */
const PARITY_REQUIRED = process.env.STEALTH_PARITY_REQUIRED === "1";

// Skipping locally is the point of an opt-in suite. Skipping in the job whose
// whole purpose is this check is a silent failure: `vitest run` exits 0 on a
// fully-skipped describe, so the job reports SUCCESS for an assertion that never
// executed. That is exactly what happened -- `STEALTH_RPC_URL` was never set as
// a repo secret, so the nightly "Stealth counterfactual parity (live RPC)" check
// printed "skipping" and went green every night while the derivation was never
// once compared against the chain.
//
// These guards live OUTSIDE the skipIf so they always run when the job declares
// the suite required. Absent input now looks different from a passing check,
// which is the only way the next person to drop the endpoint finds out from CI
// rather than from a mis-derived payout address.
describe("live parity preconditions", () => {
  it.runIf(PARITY_REQUIRED)("has an RPC endpoint configured", () => {
    expect(
      RPC_URL,
      "STEALTH_RPC_URL is unset while STEALTH_PARITY_REQUIRED=1, so the parity " +
        "assertions below would silently skip and still report success. Restore the " +
        "endpoint in .github/workflows/ci.yml (or set the secret).",
    ).toBeTruthy();
  });

  // The golden is what makes this a PARITY check rather than a "some address came
  // back" check: without it the second test skips and the suite still passes.
  it.runIf(PARITY_REQUIRED)("has the Riddler golden pinned", () => {
    expect(
      EXPECTED,
      "STEALTH_CF_EXPECTED is unset while STEALTH_PARITY_REQUIRED=1, so the Riddler " +
        "parity assertion would skip and the check would prove nothing.",
    ).toBeTruthy();
  });
});

describe.skipIf(!RPC_URL)("computeCounterfactualAddress (on-chain RPC)", () => {
  it("returns a valid, deterministic counterfactual address", async () => {
    const client = makeClient();
    const a = await computeCounterfactualAddress({
      owner: OWNER,
      client,
      factory: FACTORY,
      chainId: 1,
    });
    const b = await computeCounterfactualAddress({
      owner: OWNER,
      client,
      factory: FACTORY,
      chainId: 1,
    });

    expect(isAddress(a)).toBe(true);
    expect(a.toLowerCase()).toBe(b.toLowerCase());
    // Two live eth_calls. viem's own transport budget (10s per request, 3
    // retries, and it honours a Retry-After verbatim) is longer than vitest's
    // 5000ms default, so without this a rate-limited endpoint reports "Test
    // timed out" instead of the HTTP error, and the nightly reds on endpoint
    // availability rather than on factory drift -- which is how the skip this
    // PR removes came to be written. Matches packages/shared/src/eip712.test.ts.
  }, 30_000);

  it.skipIf(!EXPECTED)(
    "matches the Riddler-computed golden address",
    async () => {
      const client = makeClient();
      const derived = await computeCounterfactualAddress({
        owner: OWNER,
        client,
        factory: FACTORY,
        chainId: 1,
      });
      expect(derived.toLowerCase()).toBe((EXPECTED as Hex).toLowerCase());
    },
    30_000,
  );
});
