// @vitest-environment jsdom

/**
 * The quote-acceptance gates, exercised on the routes they have to cover.
 *
 * Two of the guards in `executeQuote` are only worth anything where they sit,
 * and both have already been wrong once:
 *
 *   1. The token-contract payout guard (raxol#869) lived INSIDE
 *      `verifyDepositAttestation`, which runs only when the solver returned a
 *      deposit address. That path is gated behind TRON_ORIGIN_LIVE and dark.
 *      The failure it was written for is destination-side, and the Tron
 *      DESTINATION route is live. A correct check that cannot execute is
 *      indistinguishable from no check at all, which is the recurring shape
 *      here: absent input and negative result must not look alike.
 *
 *   2. The deposit-route agreement check. "Is this a deposit route" had two
 *      answers -- what we know from the origin chain, and what the server sent
 *      -- and the fund-safety gate keyed off the server's. An attacker who
 *      omits `deposit_address` then picks which code path applies.
 *
 * This file used to assert LINE POSITIONS in useIntent.ts (`payoutGuard <
 * depositBlock`, matching indentation) because "reaching these branches at
 * runtime needs a rendered hook plus a wallet and an API, which this repo will
 * not fake". It needs a rendered hook, a wallet and a `fetch` stub, all of which
 * are ordinary setup (src/test/intentHarness.tsx). Line positions prove nothing
 * about reachability; a refused quote does. Every guard below is now driven on a
 * LIVE route with a crafted solver response, so "the guard runs where it has to"
 * is the assertion rather than an inference from indentation.
 *
 * Two things the old file asserted are deliberately not ported:
 *   - The #857 refresh-budget rules ("never conditions the increment on
 *     `paused`") were regex assertions over the source. The rule itself is
 *     `shouldRefreshQuote` / `shouldRefreshOnReturn`, unit-tested directly in
 *     intentDecisions.test.ts; what the hook owes is that it does not leak
 *     refresh timers, which the last test here drives for real. The deposit
 *     budget itself cannot be reached from a test without a valid solver
 *     attestation signature, and forging one to reach a counter is not worth a
 *     test that no longer proves the counter is respected.
 *   - "Where the status poll reads its deposit deadline from" moved to
 *     useIntent.statusPoll.test.tsx, where it is asserted by its consequence:
 *     a resumed deposit swap polls for the solver's window, not ten minutes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import { TRON_CHAIN_ID } from "@xochi/client";
import type { Config } from "wagmi";
import { useIntent, type UseIntentParams } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import { STORAGE_KEYS } from "../constants.js";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  quoteWire,
  TEST_WALLET,
  USDC_BASE,
  WETH_ARBITRUM,
  nextAmount,
  type ApiHandler,
} from "../test/intentHarness.js";

const PAST_DEBOUNCE_MS = 600;
/** A Tron destination address, echoed on the live non-EVM DESTINATION route. */
const TRON_RECIPIENT = "TQ5NMqJjHEuBSyqAJqiZKYHRLmVYFvQvsP";

let config: Config;

beforeEach(() => {
  config = createTestWagmiConfig();
  intentAPI.clearQuoteCache();
  sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render with a connected wallet and take one quote. */
async function quoteWith(handler: ApiHandler, params: Partial<UseIntentParams> = {}) {
  const api = stubApi(handler);
  const { result } = renderHook(
    () =>
      useIntent({
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        settlementPreference: "public",
        settlementAuthorized: true,
        ...params,
      }),
    { wrapper: testWrapper(config) },
  );
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
  });
  act(() => result.current.requestQuote(nextAmount()));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
  });
  return { result, api };
}

describe("payout recipient is the destination token (raxol#869)", () => {
  it("refuses on a live EVM->EVM route, which carries no deposit address at all", async () => {
    // raxol#869 settled real funds to a token address, unspendably, and Riddler
    // reported the intent "completed" so the e2e recorded PASS. The guard used
    // to live inside the deposit-attestation path, i.e. only on a route that is
    // dark. This is the route that is live.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await quoteWith(
      // The solver echoes the recipient we asked for, so the echo gate passes:
      // the quote is internally consistent, correctly signed, and pays the token
      // contract. Nothing but this guard stands in front of it.
      () => quoteWire({ recipient_address: WETH_ARBITRUM }),
      { recipientAddress: WETH_ARBITRUM },
    );

    expect(result.current.status).toBe("failed");
    // Discarded, not merely flagged: no deposit or payout data may linger in
    // state for a confirm screen to read.
    expect(result.current.quote).toBeNull();
    expect(result.current.canSign).toBe(false);
    expect(result.current.error).toMatch(/token's own contract/);
    expect(error).toHaveBeenCalled();
  });

  it("accepts the same route when the payout goes somewhere spendable", async () => {
    // The negative control: without it, a guard that refuses everything would
    // pass the test above.
    const { result } = await quoteWith(() => quoteWire({ recipient_address: TRON_RECIPIENT }), {
      recipientAddress: TRON_RECIPIENT,
    });

    expect(result.current.status).toBe("quoted");
    expect(result.current.canSign).toBe(true);
  });

  it("refuses when the wallet itself is the destination token and no recipient was named", async () => {
    // The recipient RESOLVES to the connected wallet when none is given, so the
    // guard has to read the resolved value, not the request field.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await quoteWith(() => quoteWire(), {
      // The mock wallet is 0x1111...1111; make that the destination token.
      toToken: "0x1111111111111111111111111111111111111111",
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.quote).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("deposit-route disagreement", () => {
  it("refuses a deposit address served on an EVM origin", async () => {
    // The gate must not be able to pick its own path from attacker-controlled
    // JSON. An EVM origin is not a deposit route in this client, whatever the
    // response claims, so a served `deposit_address` is a refusal -- not an
    // invitation to run the deposit branch (which would show the user an address
    // to send funds to).
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await quoteWith(() =>
      quoteWire({ deposit_address: "TCwnBmvhtqLpBiKrFEfMzXWCq1YB2sPX8N" }),
    );

    expect(result.current.status).toBe("failed");
    expect(result.current.quote).toBeNull();
    expect(result.current.error).toBe("This route is not available right now.");
    expect(error).toHaveBeenCalled();
  });

  it("refuses a deposit origin whose quote omits the deposit address", async () => {
    // The other direction of the same equality. Silently continuing here would
    // leave a Tron-origin swap with no address to fund and no error.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = stubApi(() => quoteWire());
    const { result } = renderHook(
      () =>
        useIntent({
          fromChainId: TRON_CHAIN_ID,
          toChainId: arbitrum.id,
          fromToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          toToken: WETH_ARBITRUM,
          settlementPreference: "public",
          settlementAuthorized: true,
        }),
      { wrapper: testWrapper(config) },
    );
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "wallet.session.jwt", wallet: TEST_WALLET.toLowerCase() }),
    );
    act(() => result.current.requestQuote(nextAmount()));
    await act(async () => {
      // Deposit origins debounce at 1200ms.
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(api.quotes).toHaveLength(1);
    expect(result.current.status).toBe("failed");
    expect(result.current.quote).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("automatic re-quote plumbing", () => {
  it("never accumulates refresh timers, however many times the tab is left and returned to", async () => {
    // Every armed refresh timer reschedules itself when it fires, so orphaning
    // one and arming a second does not cost one extra request -- it forks a
    // second self-sustaining loop. N tab switches meant N concurrent refresh
    // loops (and, on a deposit origin, N addresses per window). Clearing before
    // arming is what keeps it at one.
    const { result } = await quoteWith(() => quoteWire());
    expect(result.current.status).toBe("quoted");
    const armedAfterFirstQuote = vi.getTimerCount();

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(10);
      });
    }

    // Each return re-quotes (an EVM route costs a request and nothing else) and
    // must leave exactly the same number of timers behind as one quote does.
    expect(vi.getTimerCount()).toBe(armedAfterFirstQuote);
  });
});
