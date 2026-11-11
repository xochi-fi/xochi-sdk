// @vitest-environment jsdom

/**
 * Recovery and history (trade-widget-mvp.md, Phase 6).
 *
 * Was source text: `readFileSync` of `useSwapPanel.ts`, `Trade.tsx` and
 * `ActivityFeed.tsx`, asserting things like
 * `toContain("Restore the flow modal for a swap this tab lost.")` -- a COMMENT,
 * which would still pass with the effect deleted underneath it.
 *
 * The recovery path is the one flow in this app whose whole purpose is to
 * survive losing the tab (xochi#339: a mobile wallet deep-link backgrounds the
 * page, the OS evicts it, the in-memory intent dies and the user lands on a
 * blank form believing their signature was lost). It is driven entirely by
 * `localStorage` plus the public status read, so it can be exercised for real:
 * seed the record, render, and watch the modal come back.
 *
 * What must stay true:
 *   - an in-flight swap restores the flow modal over the RECORD's pair, not the
 *     form's default pair;
 *   - a resumed order ends as the order it was: a stealth one on the claim step,
 *     a public one on its receipt, from the record and not the panel's toggle;
 *   - closing it is recorded, so a later load never re-imposes it, and the CTA
 *     becomes the way back in;
 *   - Retry restores the settlement mode by name, and a mode that is no longer
 *     selectable falls back to public rather than riding a route that cannot
 *     settle it;
 *   - a terminal row names its next action honestly: a failure the Worker marked
 *     `not_executed` is retried, any other failure offers no retry, an expired
 *     or refunded order gets a NEW quote, and a completed stealth row points at
 *     the claim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderTrade, apiStub, TEST_ACCOUNT } from "./harness.js";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { SwapPanel } from "./SwapPanel.js";
import { ActivityFeed } from "../../components/ActivityFeed.js";
import { STORAGE_KEYS } from "../../constants.js";
import type { SwapActivityItem } from "../../types/activity.js";
import type { IntentStatus } from "../../types/intent.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { DEPOSIT_ATTESTATION_PIN } from "../../config.js";
import { buildDepositAttestationMessage, type DepositAttestationFields } from "@xochi/signer";
import { privateKeyToAccount } from "viem/accounts";
import { truncateAddress } from "../../utils/format.js";

const originalDepositSigner = DEPOSIT_ATTESTATION_PIN.signer;

/**
 * Longest test: "ends an unmarked failure on may-have-moved, and Close frees the
 * panel" -- one render, then a wait for the ending, one for the dialog to go
 * after Close and one for the quote a typed amount sends, so 1R/3W. The two
 * `feed()` tests render twice but never wait, which is cheaper. All five waits
 * that predate it were on RTL's 1000ms default; the thin one was the resume
 * effect painting the flow modal, which has to survive a localStorage read, a
 * provider-stack mount and the status poll re-arming.
 */
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_L1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const RESUMED_ID = "xi_resumed_339";

/**
 * A dispatched swap as the activity log stores it: Base USDC -> Arbitrum USDC,
 * 5 USDC in, the corridor the #339 incident ran on. Deliberately NOT the panel's
 * default pair on the amount, so "the modal reopened over the record" is
 * distinguishable from "the modal reopened over the form".
 */
function record(over: Partial<SwapActivityItem> = {}): SwapActivityItem {
  const intentStatus: IntentStatus = "settling";
  return {
    id: RESUMED_ID,
    type: "swap",
    timestamp: Date.now() - 60_000,
    status: "pending",
    intentStatus,
    data: {
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: USDC_BASE,
      toToken: USDC_ARB,
      fromAmount: "5000000",
      toAmount: "4989000",
      tier: "Standard",
      feeRate: 0.22,
      txHash: null,
      isCrossChain: true,
    },
    ...over,
  };
}

const seed = (...items: SwapActivityItem[]): void => {
  window.localStorage.setItem(
    `${STORAGE_KEYS.localActivityPrefix}${TEST_ACCOUNT.toLowerCase()}`,
    JSON.stringify(items),
  );
};

const dismissed = (): string[] => {
  const raw = window.localStorage.getItem(
    `${STORAGE_KEYS.resumeDismissedPrefix}${TEST_ACCOUNT.toLowerCase()}`,
  );
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

beforeEach(() => {
  window.localStorage.clear();
  // The status poll re-arms on resume and must not advance the swap out from
  // under the assertions: the solver still says settling.
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/status": { body: { success: true, data: { status: "settling", intentId: RESUMED_ID } } },
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Object.assign(DEPOSIT_ATTESTATION_PIN, { signer: originalDepositSigner });
});

describe("an in-flight swap survives losing the tab", () => {
  it("restores the flow modal over the persisted record", async () => {
    seed(record());
    await renderTrade(<SwapPanel />, { connected: true });

    // The real phase, from the record's own status -- not a blank form and not
    // the confirm surface.
    await waitFor(() => expect(document.querySelector(".swap-flow-modal")).toBeTruthy(), WAIT);
    expect(screen.getByRole("heading", { name: "Settling" })).toBeTruthy();

    // Over the RECORD's pair: the modal reads amounts and symbols from the
    // panel, so the legs have to be restored before the intent is adopted or
    // the live status paints over the default pair.
    const payAmount = document.querySelector<HTMLInputElement>("#swap-pay-amount");
    expect(payAmount?.value).toBe("5");
    // The served payout captured at submit time, since a resumed intent carries
    // no quote and none is ever synthesized (xochi#389).
    expect(document.querySelector(".swap-flow-payout")?.textContent).toContain("4.989 USDC");
  });

  it("records the close and turns the CTA into the way back in", async () => {
    seed(record());
    await renderTrade(<SwapPanel />, { connected: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);

    // Closing is "I am done watching this one", recorded per intent id so an
    // unrelated reload does not put the modal back in the user's face.
    expect(dismissed()).toContain(RESUMED_ID);

    // But the order is still in flight, so the panel owes exactly one thing:
    // the way back. The CTA outranks the status label and the connect prompt.
    const cta = document.querySelector(".submit-btn");
    expect(cta?.textContent).toContain("View order progress");
    expect(cta?.hasAttribute("disabled")).toBe(false);

    fireEvent.click(cta as HTMLElement);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not re-impose a modal the user already closed", async () => {
    seed(record());
    window.localStorage.setItem(
      `${STORAGE_KEYS.resumeDismissedPrefix}${TEST_ACCOUNT.toLowerCase()}`,
      JSON.stringify([RESUMED_ID]),
    );
    await renderTrade(<SwapPanel />, { connected: true });
    // Give the resume effect the same window the passing case gets.
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a resumed order ends as the order it was dispatched", () => {
  // To Ethereum L1, the only destination stealth settles on, so the two cases
  // differ in the record's settlement mode alone. The solver reports the swap
  // complete with a public fill receipt, which only the public ending links.
  const resumeToCompletion = async (settlementType: "stealth" | "public"): Promise<void> => {
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/status": {
          body: statusWire({
            intent_id: RESUMED_ID,
            status: "completed",
            terminal: true,
            settlement_tx_hash: `0x${"ab".repeat(32)}`,
            settlement_chain_id: 1,
          }),
        },
      }),
    );
    seed(record({ data: { ...record().data, toChainId: 1, toToken: USDC_L1, settlementType } }));
    await renderTrade(<SwapPanel />, { connected: true });
  };

  it("ends a resumed stealth order on the claim step, with no panel interaction", async () => {
    window.history.replaceState({}, "", "/embed?settlement=public");
    await resumeToCompletion("stealth");
    await waitFor(
      () =>
        expect(screen.getByRole("heading", { name: "Landed at the private address" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByRole("button", { name: "Claim payment" })).toBeTruthy();
    // The settlement hash is privacy-sensitive, so the stealth ending never links it.
    expect(document.querySelector(".swap-result__txlink")).toBeNull();
    // The recorded settlement takes precedence over the host's Public preference.
    expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("still ends a resumed public order on its receipt", async () => {
    await resumeToCompletion("public");
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Swap complete" })).toBeTruthy(),
      WAIT,
    );
    expect(document.querySelector(".swap-result__txlink")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claim payment" })).toBeNull();
  });

  it("shows the stored Tron tag after a reload without requiring a currently advertised route", async () => {
    const tronTagOrder = record({
      data: {
        ...record().data,
        fromChainId: 728126428,
        fromToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        toChainId: 1,
        toToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        toAmount: "4989000000000000000",
        recipientTag: "memory-rocky",
        settlementType: "public",
      },
    });
    seed(tronTagOrder);
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/status": {
          body: statusWire({
            intent_id: RESUMED_ID,
            status: "completed",
            terminal: true,
            settlement_chain_id: 1,
          }),
        },
      }),
    );
    await renderTrade(<SwapPanel />, { connected: true });
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Sent to @memory-rocky" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByRole("link", { name: /Open zk.money/ }).getAttribute("href")).toBe(
      "https://wallet.zk.money/activity",
    );
    expect(screen.queryByRole("button", { name: "Claim payment" })).toBeNull();
  });
});

describe("after an execute, Retry only on the Worker's not_executed", () => {
  /** Resume a dispatched swap whose status poll reads `polled`; counts quote requests. */
  const resumeTo = async (intentStatus: IntentStatus, polled: Record<string, unknown>) => {
    let quotes = 0;
    const stub = apiStub({
      "/status": { body: statusWire({ intent_id: RESUMED_ID, ...polled }) },
      "/api/intent/quote": { body: quoteWire() },
      // Both failure endings auto-report their reference.
      "/api/report": { body: { success: true } },
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/intent/quote")) quotes += 1;
      return stub(input, init);
    });
    seed(record({ intentStatus }));
    await renderTrade(<SwapPanel />, { connected: true });
    return { quotes: () => quotes };
  };

  it("ends an unmarked failure on may-have-moved, and Close frees the panel", async () => {
    const api = await resumeTo("settling", { status: "failed", terminal: true });
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Funds may have moved" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByRole("heading", { name: "Swap did not complete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again|retry|new quote/i })).toBeNull();

    // Terminal: Close resets, as on every other terminal ending. Held instead,
    // the panel would be welded to an intent the machine never quotes past.
    fireEvent.click(document.querySelector(".swap-result__primary") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    fireEvent.change(document.querySelector("#swap-pay-amount") as HTMLInputElement, {
      target: { value: "6" },
    });
    await waitFor(() => expect(api.quotes()).toBeGreaterThan(0), WAIT);
  });

  it("offers Retry on a failure the Worker marked not_executed", async () => {
    await resumeTo("settling", { status: "failed", terminal: true, substatus: "not_executed" });
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Swap failed" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.queryByRole("heading", { name: "Funds may have moved" })).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("holds a not-sent order on Close, with the way back in", async () => {
    // A resumed `executing` that reads `quoted` is unsent: its signed request
    // stays executable until it expires, so Close must not drop it.
    await resumeTo("executing", { status: "quoted" });
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Not sent" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.queryByRole("button", { name: /try again|retry|new quote/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    const cta = document.querySelector(".submit-btn");
    expect(cta?.textContent).toContain("View order progress");
    fireEvent.click(cta as HTMLElement);
    expect(screen.getByRole("heading", { name: "Not sent" })).toBeTruthy();
  });
});

describe("retry restores the settlement mode by name", () => {
  it("brings back a stealth order as stealth", async () => {
    // Ethereum L1 destination, which is the only one stealth can settle on --
    // so the mode survives the selectable-guard rather than being flipped.
    await renderTrade(
      <SwapPanel
        prefill={{
          nonce: 1,
          fromChainId: 8453,
          toChainId: 1,
          fromToken: USDC_BASE,
          toToken: USDC_L1,
          fromAmount: "5000000",
          settlement: "stealth",
        }}
      />,
      { connected: true },
    );
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      WAIT,
    );
    expect(document.querySelector<HTMLInputElement>("#swap-pay-amount")?.value).toBe("5");
  });

  it("blocks an unavailable direct-Aztec retry until the user chooses zk.money", async () => {
    // Historical direct-shielded orders stay blocked (#142). The Shielded
    // shortcut is a different route and changes settlement only on user action.
    await renderTrade(
      <SwapPanel
        prefill={{
          nonce: 1,
          fromChainId: 8453,
          toChainId: 42161,
          fromToken: USDC_BASE,
          toToken: USDC_ARB,
          fromAmount: "5000000",
          settlement: "shielded",
        }}
      />,
      { connected: true },
    );
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Public/ }).getAttribute("aria-pressed")).toBe(
          "false",
        ),
      WAIT,
    );
    expect(document.querySelector<HTMLButtonElement>(".submit-btn")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Shielded/ }));
    expect(screen.getByLabelText("zk.money tag")).toBeTruthy();
    expect(document.querySelector(".settlement-caption[aria-live]")?.textContent).toBe("");
  });
});

describe("terminal rows name the next action", () => {
  const feed = (items: SwapActivityItem[], onClaimNudge?: () => void) =>
    renderTrade(
      <ActivityFeed
        activities={items}
        isLoading={false}
        error={null}
        hasMore={false}
        isConnected
        needsSignIn={false}
        isSigningIn={false}
        onSignIn={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onRetrySwap={() => {}}
        onClaimNudge={onClaimNudge}
      />,
      { connected: true },
    );

  /** Open the strip, then expand the single row inside it. */
  const expandRow = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Toggle activity" }));
    const row = document.querySelector(".activity-row");
    fireEvent.click(row as HTMLElement);
  };

  it.each(["valid", "changed-refund", "foreign-owner", "foreign-intent", "missing-pin"] as const)(
    "names only the independently verified refund target: %s",
    async (binding) => {
      const attester = privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      );
      Object.assign(DEPOSIT_ATTESTATION_PIN, {
        signer: binding === "missing-pin" ? "" : attester.address,
      });
      const refund = "TNaRAoLUyYEV2uF7GUrzSjRQTU8v5ZJ5VR";
      const fields: DepositAttestationFields = {
        intent_id: "11111111-1111-1111-1111-111111111111",
        quote_id: "22222222-2222-2222-2222-222222222222",
        wallet: TEST_ACCOUNT,
        from_chain_id: 728126428,
        from_token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        from_amount: "1000000000",
        deposit_address: "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9",
        deposit_deadline: Math.floor(Date.now() / 1000) + 1800,
        refund_address: refund,
        to_chain_id: 1,
        to_token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        to_amount: "998000000000000000000",
        min_to_amount: "996000000000000000000",
        recipient: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        stealth_spending_pub_key: null,
        stealth_viewing_pub_key: null,
        settlement_preference: "public",
      };
      const attestation = await attester.signMessage({
        message: buildDepositAttestationMessage(fields),
      });
      const attested =
        binding === "changed-refund"
          ? { ...fields, refund_address: fields.deposit_address }
          : fields;
      await feed([
        record({
          id: binding === "foreign-intent" ? fields.quote_id : fields.intent_id,
          ownerWallet:
            binding === "foreign-owner"
              ? "0x2222222222222222222222222222222222222222"
              : TEST_ACCOUNT,
          intentStatus: "refunded",
          status: "failed",
          data: {
            ...record().data,
            fromChainId: 728126428,
            toChainId: 1,
            fromToken: fields.from_token,
            toToken: fields.to_token,
            fromAmount: fields.from_amount,
            toAmount: fields.to_amount,
            deposit: { attested, attestation },
          },
        }),
      ]);
      expandRow();
      const outcome = document.querySelector(".expanded-status--refund");
      expect(outcome).not.toBeNull();
      if (binding === "valid") {
        expect(outcome?.textContent).toContain(truncateAddress(refund));
      } else {
        expect(outcome?.textContent).not.toContain(truncateAddress(refund));
        expect(outcome?.textContent).not.toContain(truncateAddress(fields.deposit_address));
      }
    },
  );

  it("renders Ethereum DAI history with canonical precision", async () => {
    await feed([
      record({
        data: {
          ...record().data,
          fromChainId: 1,
          fromToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          fromAmount: "25000000000000000000",
        },
      }),
    ]);
    expect(document.querySelector(".from-token")?.textContent).toBe("25 DAI");
  });

  it("withholds history amounts for an unknown deployment", async () => {
    await feed([
      record({
        data: {
          ...record().data,
          fromToken: "0x000000000000000000000000000000000000dEaD",
          fromAmount: "25000000000000000000",
        },
      }),
    ]);
    expect(document.querySelector(".from-token")?.textContent).toContain("--");
    expect(document.querySelector(".from-token")?.textContent).not.toContain("25 ");
  });

  it("labels a retry honestly: a nothing-moved failure is retried, the rest re-quote", async () => {
    await feed([
      record({
        id: "xi_failed",
        intentStatus: "failed",
        status: "failed",
        data: { ...record().data, substatus: "not_executed" },
      }),
    ]);
    expandRow();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();

    // A refunded or expired order has no price any more, so "Try again" would
    // promise a repeat of something that cannot repeat.
    await feed([record({ id: "xi_refunded", intentStatus: "refunded", status: "failed" })]);
    expandRow();
    expect(screen.getByRole("button", { name: "New quote" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  // Every row is an order that was sent, so a failure without the marker may
  // have moved funds, and a retry would be a second order beside it.
  it("offers no retry on a failure that may have moved funds", async () => {
    await feed([
      record({
        id: "xi_failed_moved",
        intentStatus: "failed",
        status: "failed",
        data: { ...record().data, substatus: "fill_failed" },
      }),
    ]);
    expandRow();
    expect(screen.queryByRole("button", { name: /try again|new quote/i })).toBeNull();
    cleanup();

    await feed([record({ id: "xi_failed_bare", intentStatus: "failed", status: "failed" })]);
    expandRow();
    expect(screen.queryByRole("button", { name: /try again|new quote/i })).toBeNull();
  });

  it("labels an Aztec stealth route without claiming shielded settlement", async () => {
    await feed([
      record({
        id: "xi_aztec_stealth",
        intentStatus: "completed",
        status: "completed",
        data: {
          ...record().data,
          destinationType: "aztec",
          settlementType: "stealth",
        },
      }),
    ]);
    expandRow();

    const route = document.querySelector(".activity-chain-route")?.textContent ?? "";
    expect(route).toContain("Aztec");
    expect(route).toContain("Stealth");
    expect(screen.getByText("Aztec Network (Stealth)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Shielded");
  });

  it("points a completed stealth row at the claims surface", async () => {
    let nudged = 0;
    await feed(
      [
        record({
          id: "xi_stealth_done",
          intentStatus: "completed",
          status: "completed",
          data: { ...record().data, settlementType: "stealth" },
        }),
      ],
      () => {
        nudged += 1;
      },
    );
    expandRow();
    // The funds sit at a one-time address until claimed, so an explorer link is
    // not the next action -- the claim is.
    fireEvent.click(screen.getByRole("button", { name: "Go to claims" }));
    expect(nudged).toBe(1);
    cleanup();

    // A public completion gets no claims action: offering one would invent work
    // the user does not have.
    await feed(
      [
        record({
          id: "xi_public_done",
          intentStatus: "completed",
          status: "completed",
          data: { ...record().data, settlementType: "public" },
        }),
      ],
      () => {
        nudged += 1;
      },
    );
    expandRow();
    expect(screen.queryByRole("button", { name: "Go to claims" })).toBeNull();
  });
});
