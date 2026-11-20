/// <reference lib="esnext.promise" />
// @vitest-environment jsdom

/**
 * The four ways a visitor reaches the trade form, and what each may do.
 *
 * Phase 1 of the trade experience plan (docs/planning/trade-widget-mvp.md)
 * opens /trade to anonymous exploration while keeping execution wallet-gated.
 * That splits entry into four paths with different rights:
 *
 *   1. Anonymous          -- no passkey, no wallet. Read-only preview quotes on
 *                            side-effect-free routes; never signs.
 *   2. Passkey-only       -- Xochi ID, no wallet. Identical quote rights to
 *                            anonymous: an ID cannot fund or settle a trade.
 *   3. Wallet-only        -- connected wallet. EVM quotes need no session;
 *                            Tron-origin allocation also needs a wallet-bound
 *                            session token.
 *   4. Reconnecting       -- a wallet arrives while a preview is on screen; the
 *                            preview upgrades in place to an executable quote.
 *
 * These used to be asserted as SOURCE TEXT: the test read useIntent.ts off disk
 * and matched substrings and line positions in it, on the grounds that "reaching
 * these branches at runtime needs a rendered hook plus a wallet and an API,
 * which this repo will not fake". A substring match is not a test of that
 * wiring: it passes when the hook is wired to nothing, and fails on a rename.
 * Every one of those assertions is gone, replaced by driving the real hook and
 * asserting the two things a caller and the worker actually observe -- the
 * REQUEST that leaves the client, and the rights the hook grants for the quote
 * that comes back. The underlying decisions (`quoteAccessDecision`,
 * `canSignQuote`, `shouldUpgradePreviewQuote`) stay unit-tested in
 * intentDecisions.test.ts; duplicating them here proved nothing about the hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import { useEffect } from "react";
import { STATUS_POLL_MS, TRON_CHAIN_ID } from "@xochi/client";
import {
  assertPullMatchesIntent,
  computeIntentIdHash,
  PERMIT2_ADDRESS,
  PERMIT2_TYPES,
} from "@xochi/signer";
import { useAccount, type Config } from "wagmi";
import { useIntent } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import { STORAGE_KEYS } from "../constants.js";
import { DEPOSIT_ATTESTATION_PIN } from "../config.js";
import depositAttestationVectors from "../lib/deposit-attestation-vectors.json";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  quoteWire,
  statusWire,
  TEST_WALLET,
  USDC_BASE,
  WETH_ARBITRUM,
  nextAmount,
  type StubbedApi,
} from "../test/intentHarness.js";

/** Longer than the 500ms quote debounce. */
const PAST_DEBOUNCE_MS = 600;
const DEPOSIT_VECTOR = depositAttestationVectors.vectors[0];
const DEPOSIT_VECTOR_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

let config: Config;

beforeEach(() => {
  config = createTestWagmiConfig();
  // The singleton client caches quotes for 30s across tests; a cache hit would
  // silently answer the next test's request with this one's quote.
  intentAPI.clearQuoteCache();
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.assign(DEPOSIT_ATTESTATION_PIN, { signer: "" });
  vi.unstubAllGlobals();
});

interface RenderedIntent {
  result: { current: ReturnType<typeof useIntent> };
  /** Status seen on every render, in order: proves what flashed on screen. */
  statuses: string[];
  api: StubbedApi;
}

function renderIntent(
  api: StubbedApi,
  params: Partial<Parameters<typeof useIntent>[0]> = {},
): RenderedIntent {
  const statuses: string[] = [];
  const { result } = renderHook(
    () => {
      const intent = useIntent({
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        settlementPreference: "public",
        settlementAuthorized: true,
        ...params,
      });
      statuses.push(intent.status);
      return intent;
    },
    { wrapper: testWrapper(config) },
  );
  return { result, statuses, api };
}

const quote = async (rendered: RenderedIntent, amount = nextAmount()) => {
  act(() => rendered.result.current.requestQuote(amount));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
  });
};

/**
 * Connect the mock wallet to a MOUNTED tree. wagmi's React state only picks up
 * a connection made through its own store while a provider is subscribed, so
 * connecting before render leaves `useAccount().address` undefined.
 */
const connectWallet = async () => {
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
  });
};

describe("anonymous visitor (no passkey, no wallet)", () => {
  it("quotes a public EVM route as a read-only preview it can never sign", async () => {
    const api = stubApi(() => quoteWire({ preview: true }));
    const rendered = renderIntent(api);
    await quote(rendered);

    // What the worker receives is the contract: no wallet, and the preview
    // marker that tells it to price at Standard tier and strip the signing
    // payload.
    expect(api.quotes).toHaveLength(1);
    expect(api.quotes[0].body?.wallet).toBeUndefined();
    expect(api.quotes[0].body?.preview).toBe(true);

    expect(rendered.result.current.status).toBe("quoted");
    // Solvable AND unsignable: the price is real, the execution boundary holds.
    expect(rendered.result.current.quote?.canSolve).toBe(true);
    expect(rendered.result.current.canSign).toBe(false);
  });

  it("holds for a wallet on a stealth route without asking the solver", async () => {
    // Stealth needs wallet-derived ERC-5564 keys, so an anonymous stealth quote
    // is not a degraded request -- it is no request at all.
    const api = stubApi(() => quoteWire());
    const rendered = renderIntent(api, { settlementPreference: "stealth" });
    await quote(rendered);

    expect(api.quotes).toHaveLength(0);
    expect(rendered.result.current.error).toBe("Connect a wallet to quote this route");
  });

  it("prices a deposit-origin route without allocating a wallet address", async () => {
    const api = stubApi(() => quoteWire({ preview: true, payment_method: "deposit" }));
    const rendered = renderIntent(api, { fromChainId: TRON_CHAIN_ID });
    await act(async () => {
      rendered.result.current.requestQuote(nextAmount());
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(api.quotes).toHaveLength(1);
    expect(api.quotes[0].body?.wallet).toBeUndefined();
    expect(api.quotes[0].body?.preview).toBe(true);
    expect(api.quotes[0].body?.allocation_key).toBeUndefined();
    expect(rendered.result.current.status).toBe("quoted");
    expect(rendered.result.current.canSign).toBe(false);
    expect(rendered.result.current.canAllocateDepositRoute).toBe(false);
  });
});

describe("passkey-only member (Xochi ID, no wallet)", () => {
  it("gets exactly the anonymous rights, session token or not", async () => {
    // A Xochi ID cannot fund or settle a trade, so the wallet -- and only the
    // wallet -- decides the quote mode. This used to be asserted by grepping
    // useIntent.ts for `sessionStorage|getAuthToken`, which says nothing about
    // what the hook does with a session that exists. So: give it one.
    sessionStorage.setItem(STORAGE_KEYS.authToken, "header.payload.signature");
    const api = stubApi(() => quoteWire({ preview: true }));
    const rendered = renderIntent(api);
    await quote(rendered);

    expect(api.quotes).toHaveLength(1);
    // The token rides along as Authorization (every API call does that), but it
    // buys no trading rights: still walletless, still a preview, still unsignable.
    expect(api.quotes[0].body?.wallet).toBeUndefined();
    expect(api.quotes[0].body?.preview).toBe(true);
    expect(rendered.result.current.canSign).toBe(false);
  });
});

describe("wallet-only trader (connected, no passkey)", () => {
  it("quotes executable and signable with no session at all", async () => {
    const api = stubApi(() => quoteWire());
    const rendered = renderIntent(api);
    await connectWallet();
    await quote(rendered);

    expect(sessionStorage.getItem(STORAGE_KEYS.authToken)).toBeNull();
    expect(api.quotes[0].body?.wallet).toBe(TEST_WALLET);
    expect(api.quotes[0].body?.preview).toBe(false);
    expect(rendered.result.current.status).toBe("quoted");
    expect(rendered.result.current.canSign).toBe(true);
  });

  it("keeps input-driven quoting stable when a quote arrives and consent changes", async () => {
    const api = stubApi(() => quoteWire({ payment_method: "permit2" }));
    const amount = nextAmount();
    let inputQuoteRequests = 0;
    const { result, rerender } = renderHook(
      () => {
        const { address } = useAccount();
        const intent = useIntent({
          fromChainId: base.id,
          toChainId: arbitrum.id,
          fromToken: USDC_BASE,
          toToken: WETH_ARBITRUM,
          settlementPreference: "public",
          settlementAuthorized: true,
        });
        // The panel's amount effect depends on requestQuote. An arriving quote
        // must not change that action and masquerade as a new amount edit.
        useEffect(() => {
          if (!address) return;
          inputQuoteRequests += 1;
          intent.requestQuote(amount);
        }, [address, intent.requestQuote]);
        return intent;
      },
      { wrapper: testWrapper(config) },
    );
    await connectWallet();
    const requestQuote = result.current.requestQuote;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    expect(result.current.status).toBe("quoted");
    expect(result.current.requestQuote).toBe(requestQuote);
    expect(inputQuoteRequests).toBe(1);
    expect(api.quotes).toHaveLength(1);

    act(() => result.current.setUnlimitedApproval(true));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    expect(result.current.unlimitedApproval).toBe(true);
    expect(result.current.requestQuote).toBe(requestQuote);
    expect(inputQuoteRequests).toBe(1);
    expect(api.quotes).toHaveLength(1);
  });

  it.each(["requestQuote", "refreshQuote", "reset", "sign"] as const)(
    "clears unused consent on %s without changing the quoting action",
    async (action) => {
      const api = stubApi(() => quoteWire({ payment_method: "permit2" }));
      const rendered = renderIntent(api);
      await connectWallet();
      await quote(rendered);
      const requestQuote = rendered.result.current.requestQuote;
      act(() => rendered.result.current.setUnlimitedApproval(true));
      expect(rendered.result.current.unlimitedApproval).toBe(true);

      act(() => {
        if (action === "requestQuote") rendered.result.current.requestQuote(nextAmount());
        else rendered.result.current[action]();
      });

      expect(rendered.result.current.unlimitedApproval).toBe(false);
      expect(rendered.result.current.requestQuote).toBe(requestQuote);
    },
  );

  it("clears consent when a fresh quote arrives even with the same quote ID", async () => {
    const { promise: freshQuote, resolve: releaseQuote } = Promise.withResolvers<unknown>();
    let quotes = 0;
    const amount = nextAmount();
    const intentId = "11111111-1111-1111-1111-111111111111";
    const spender = "0x3333333333333333333333333333333333333333";
    const executableQuote = () => {
      const deadline = Math.floor(Date.now() / 1_000) + 300;
      const wire = quoteWire({
        payment_method: "permit2",
        eip712: {
          domain: { name: "Xochi", version: "3", chainId: base.id },
          types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
          primaryType: "XochiIntent",
          message: {
            wallet: TEST_WALLET,
            fromChainId: base.id,
            toChainId: arbitrum.id,
            fromToken: USDC_BASE,
            toToken: WETH_ARBITRUM,
            fromAmount: amount,
            toAmount: "500000000000000",
            recipient: TEST_WALLET,
            settlementPreference: "public",
            deadline,
          },
        },
        pull_authorization: {
          domain: { name: "Permit2", chainId: base.id, verifyingContract: PERMIT2_ADDRESS },
          types: PERMIT2_TYPES,
          primaryType: "PermitWitnessTransferFrom",
          message: {
            permitted: { token: USDC_BASE, amount },
            spender,
            nonce: String(quotes),
            deadline,
            witness: { orderId: computeIntentIdHash(intentId) },
          },
        },
      });
      assertPullMatchesIntent(wire, {
        expectedPullRecipients: { [base.id]: { permit2: spender } },
      });
      return wire;
    };
    const api = stubApi(() => {
      quotes += 1;
      return quotes === 1 ? executableQuote() : freshQuote;
    });
    const rendered = renderIntent(api);
    await connectWallet();
    await quote(rendered, amount);
    expect(rendered.result.current.quote?.pullAuthorization).toBeTruthy();
    const previousQuote = rendered.result.current.quote;
    const previousQuoteId = rendered.result.current.quoteId;
    act(() => rendered.result.current.refreshQuote());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    expect(api.quotes).toHaveLength(2);
    act(() => rendered.result.current.setUnlimitedApproval(true));
    expect(rendered.result.current.unlimitedApproval).toBe(true);

    await act(async () => {
      releaseQuote(executableQuote());
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(rendered.result.current.status).toBe("quoted");
    expect(rendered.result.current.quoteId).toBe(previousQuoteId);
    expect(rendered.result.current.quote).not.toBe(previousQuote);
    expect(rendered.result.current.unlimitedApproval).toBe(false);
  });

  it.each(["not_executed", undefined, "pull_failed", "refund_failed"])(
    "uses the SDK's resumed-order poll verdict for substatus=%s, not a later quote refusal",
    async (substatus) => {
      const intentId = "11111111-1111-1111-1111-111111111111";
      const api = stubApi((call) =>
        call.url.endsWith("/status")
          ? statusWire({
              intent_id: intentId,
              status: "failed",
              terminal: true,
              error: "fill failed",
              substatus,
            })
          : quoteWire({
              can_solve: false,
              error: "pair_unsupported",
              error_category: "pair_unsupported",
              settlement_options: [],
            }),
      );
      const rendered = renderIntent(api);
      await connectWallet();
      act(() => rendered.result.current.resume(intentId, "executing", TEST_WALLET));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.statusPolls).toHaveLength(1);
      expect(rendered.result.current.status).toBe("failed");
      expect(rendered.result.current.substatus).toBe(substatus ?? null);
      expect(rendered.result.current.notExecuted).toBe(substatus === "not_executed");
      if (substatus !== "not_executed") {
        expect(rendered.result.current.receipt.phase).toBe("may-have-moved");
        return;
      }

      await quote(rendered);
      expect(api.quotes).toHaveLength(1);
      expect(rendered.result.current.status).toBe("failed");
      expect(rendered.result.current.receipt.phase).toBe("failed");
      expect(rendered.result.current.notExecuted).toBe(false);
      expect(rendered.result.current.substatus).toBeNull();
    },
  );

  it("does not expose a foreign order's failed poll metadata", async () => {
    const intentId = "11111111-1111-1111-1111-111111111111";
    let polls = 0;
    const api = stubApi((call) => {
      if (!call.url.endsWith("/status")) throw new Error(`unexpected request ${call.url}`);
      polls += 1;
      return statusWire({
        intent_id: polls === 1 ? "99999999-9999-9999-9999-999999999999" : intentId,
        status: "failed",
        terminal: true,
        error: "fill failed",
        substatus: polls === 1 ? "not_executed" : "pull_failed",
      });
    });
    const rendered = renderIntent(api);
    await connectWallet();
    act(() => rendered.result.current.resume(intentId, "executing", TEST_WALLET));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.statusPolls).toHaveLength(1);
    expect(rendered.result.current.status).toBe("executing");
    expect(rendered.result.current.substatus).toBeNull();
    expect(rendered.result.current.notExecuted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(rendered.result.current.status).toBe("failed");
    expect(rendered.result.current.substatus).toBe("pull_failed");
    expect(rendered.result.current.receipt.phase).toBe("may-have-moved");
    expect(rendered.result.current.notExecuted).toBe(false);
  });

  it.each([
    ["not_executed", "pull_failed"],
    ["pull_failed", "not_executed"],
  ])(
    "keeps accepted terminal metadata %s when an older %s poll replies late",
    async (accepted, stale) => {
      const intentId = "11111111-1111-1111-1111-111111111111";
      const { promise: olderPoll, resolve: releaseOlderPoll } = Promise.withResolvers<unknown>();
      let polls = 0;
      const api = stubApi((call) => {
        if (!call.url.endsWith("/status")) throw new Error(`unexpected request ${call.url}`);
        polls += 1;
        return polls === 1
          ? olderPoll
          : statusWire({
              intent_id: intentId,
              status: "failed",
              terminal: true,
              error: "fill failed",
              substatus: accepted,
            });
      });
      const rendered = renderIntent(api);
      await connectWallet();
      act(() => rendered.result.current.resume(intentId, "executing", TEST_WALLET));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.statusPolls).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
      });
      expect(api.statusPolls).toHaveLength(2);
      expect(rendered.result.current.status).toBe("failed");
      expect(rendered.result.current.substatus).toBe(accepted);
      expect(rendered.result.current.notExecuted).toBe(accepted === "not_executed");

      await act(async () => {
        releaseOlderPoll(
          statusWire({
            intent_id: intentId,
            status: "failed",
            terminal: true,
            error: "older fill failure",
            substatus: stale,
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(rendered.result.current.substatus).toBe(accepted);
      expect(rendered.result.current.notExecuted).toBe(accepted === "not_executed");
      expect(rendered.result.current.receipt.phase).toBe(
        accepted === "not_executed" ? "failed" : "may-have-moved",
      );
    },
  );

  it("attaches wallet auth only when explicitly allocating a Tron route", async () => {
    vi.setSystemTime(new Date((DEPOSIT_VECTOR.quote.deposit_deadline - 900) * 1_000));
    Object.assign(DEPOSIT_ATTESTATION_PIN, { signer: depositAttestationVectors.signer });
    config = createTestWagmiConfig(DEPOSIT_VECTOR_WALLET);
    const api = stubApi((call) =>
      quoteWire(
        call.body?.preview === true
          ? { preview: true, payment_method: "deposit" }
          : {
              intent_id: DEPOSIT_VECTOR.quote.intent_id,
              quote_id: DEPOSIT_VECTOR.quote.quote_id,
              to_amount: DEPOSIT_VECTOR.quote.to_amount,
              min_to_amount: DEPOSIT_VECTOR.quote.min_to_amount,
              preview: false,
              payment_method: "deposit",
              deposit_address: DEPOSIT_VECTOR.quote.deposit_address,
              deposit_deadline: DEPOSIT_VECTOR.quote.deposit_deadline,
              deposit_attestation: DEPOSIT_VECTOR.deposit_attestation,
              route: { settlement_type: DEPOSIT_VECTOR.quote.settlement_preference },
            },
      ),
    );
    const rendered = renderIntent(api, {
      fromChainId: TRON_CHAIN_ID,
      toChainId: base.id,
      fromToken: DEPOSIT_VECTOR.quote.from_token,
      toToken: USDC_BASE,
    });
    await connectWallet();
    await quote(rendered, DEPOSIT_VECTOR.quote.from_amount);

    expect(api.quotes).toHaveLength(1);
    expect(api.quotes[0].body?.preview).toBe(true);
    expect(api.quotes[0].body?.wallet).toBeUndefined();
    expect(rendered.result.current.canAllocateDepositRoute).toBe(true);

    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({
        token: "wallet.session.jwt",
        wallet: DEPOSIT_VECTOR_WALLET.toLowerCase(),
      }),
    );
    await act(async () => {
      expect(await rendered.result.current.allocateDepositRoute()).toBe(true);
    });

    expect(api.quotes).toHaveLength(2);
    expect(api.quotes[1].body?.wallet).toBe(DEPOSIT_VECTOR_WALLET);
    expect(api.quotes[1].body?.preview).toBe(false);
    expect(api.quotes[1].body?.allocation_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(api.quotes[1].headers.authorization).toBe("Bearer wallet.session.jwt");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(api.quotes).toHaveLength(2);
    expect(rendered.result.current.quote?.depositAddress).toBe(
      DEPOSIT_VECTOR.quote.deposit_address,
    );
  });

  it("refuses to sign a quote the solver cannot fill", async () => {
    const api = stubApi(() => quoteWire({ can_solve: false, error: "unprofitable" }));
    const rendered = renderIntent(api);
    await connectWallet();
    await quote(rendered);

    expect(rendered.result.current.status).toBe("failed");
    // The solver's own reason, not a generic string: ErrorDisplay maps these.
    expect(rendered.result.current.error).toBe("unprofitable");
    expect(rendered.result.current.canSign).toBe(false);
  });
});

describe("reconnecting (preview upgraded in place)", () => {
  it("replaces the preview with a wallet-bound quote without flashing or resetting", async () => {
    let served = 0;
    const api = stubApi((call) => {
      if (!call.url.endsWith("/api/intent/quote")) return quoteWire();
      served += 1;
      // First request is the anonymous preview; the second must be the
      // wallet-bound upgrade.
      return served === 1
        ? quoteWire({ preview: true })
        : quoteWire({ quote_id: "33333333-3333-3333-3333-333333333333" });
    });
    const rendered = renderIntent(api);
    await quote(rendered);
    expect(rendered.result.current.quote?.preview).toBe(true);
    const statusesBeforeConnect = rendered.statuses.length;

    await connectWallet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });

    // The upgrade must be FORCED: a preview is priced at Standard tier and
    // carries no signing material, so serving it from the 30s quote cache as the
    // executable quote would hand the signing path a quote with nothing to sign.
    expect(served).toBe(2);
    expect(rendered.result.current.quote?.preview).toBeFalsy();
    expect(rendered.result.current.quoteId).toBe("33333333-3333-3333-3333-333333333333");
    expect(rendered.result.current.canSign).toBe(true);

    // And SILENT, in both senses. The visible price must not flash back to
    // "quoting", and the account watcher must not treat the arriving wallet as a
    // context change and wipe the panel to idle: every render from the connect
    // onwards still reads "quoted".
    expect(rendered.statuses.slice(statusesBeforeConnect)).not.toContain("quoting");
    expect(rendered.statuses.slice(statusesBeforeConnect)).not.toContain("idle");
    expect(rendered.result.current.status).toBe("quoted");
  });

  it("leaves the preview unbound and the upgrade bound to the wallet", async () => {
    // Two halves of one rule. A preview must never become the wallet-context
    // binding: `quotedAddress` is what the account watcher resets on, and a
    // preview having none is exactly what lets it survive the connect that
    // upgrades it. The upgraded quote must be bound, because that binding is
    // what sign() checks before prompting a wallet.
    let served = 0;
    const api = stubApi(() => {
      served += 1;
      return served === 1 ? quoteWire({ preview: true }) : quoteWire();
    });
    const rendered = renderIntent(api);
    await quote(rendered);
    expect(rendered.result.current.quotedAddress).toBeNull();

    await connectWallet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    expect(rendered.result.current.quotedAddress).toBe(TEST_WALLET);
  });
});
