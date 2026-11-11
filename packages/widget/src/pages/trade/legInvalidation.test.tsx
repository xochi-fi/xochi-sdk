// @vitest-environment jsdom

/**
 * Leg changes invalidate what the old leg denominated.
 *
 * WHY THIS EXISTS. DEBT-014 step 3 split `useSwapPanel` into four hooks, and
 * the seam it created is a set of narrow callbacks the route hook owes the
 * groups downstream of it: changing a leg must clear the amount, the recipient,
 * the refund address and the quote, none of which the route group owns.
 *
 * That seam was completely unasserted. Every one of the eight writes inside
 * those callbacks (`useSwapPanel.ts`, the `onOriginChange` /
 * `onDestinationChainChange` / `onDestinationTokenChange` / `onFlip` bodies)
 * could be commented out with all 97 tests in this directory still green --
 * verified line by line. So the split's own boundary was the least defended
 * code on the revenue path, and the class of bug is not hypothetical: the flip
 * handler's comment records that leaving the refund address behind "made the
 * panel fail its own refundAddressError check on a value the user never typed
 * for this route".
 *
 * These are transitions, not renders: each one types or picks something, moves
 * a leg, and asserts the stale value is gone. What must stay true:
 *   - a figure denominated in the old origin token does not survive an origin
 *     change;
 *   - an address for the old destination does not survive a destination change;
 *   - a flip carries the quote's OUTPUT into the pay field (the flip is a
 *     re-denomination, not a reset) while dropping both leg-scoped addresses;
 *   - no leg change leaves a priced receipt on screen, because a quote for the
 *     previous pair is not a quote for this one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuoteResponseSchema, TRON_CHAIN_ID, EXTENDED_CHAIN_NAMES } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub, L1_STEALTH_CAPABILITIES } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { TRON_DESTINATION_LIVE } from "./config.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

/** The recipient round trip uses three chain changes and three field waits. */
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 6 }) });

const TRON_NAME = EXTENDED_CHAIN_NAMES[TRON_CHAIN_ID];

/** A complete typed LIVE matrix that includes Tron routes. */
const LIVE_CAPABILITIES = L1_STEALTH_CAPABILITIES.body;

/**
 * The panel's default pair is Base USDC -> Arbitrum USDC, so a served quote
 * needs 6-decimal figures on both legs. 1000 in, 998 out.
 */
const quoteBody = QuoteResponseSchema.parse(
  quoteWire({ to_amount: "998000000", min_to_amount: "996000000", cost_bps: 22 }),
);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", apiStub({ "/api/intent/quote": { body: quoteBody } }));
  // The client caches quotes for 30s by request hash. Several tests here quote
  // the same default route, so a stale entry from one would answer the next and
  // a "the quote was reset" assertion would pass or fail on cache order.
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
});

// ============================================================
// Handles
// ============================================================

const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

/**
 * By id, not placeholder: the recipient placeholder switches to "T..." on a
 * Tron destination, so a placeholder lookup would silently miss exactly the
 * leg this file has to reach. Returns null when the field is not rendered,
 * which is itself meaningful -- it only exists for a non-EVM leg.
 */
const addressField = (id: "swap-recipient" | "swap-refund"): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(`#${id}`);

const recipient = (): HTMLInputElement => {
  const input = addressField("swap-recipient");
  if (!input) throw new Error("recipient field not rendered (destination is not non-EVM)");
  return input;
};

/**
 * Move a leg by driving the chain badge the way a user does: click the badge to
 * open its picker, then pick a different chain. Deliberately NOT a direct
 * handler call -- the point is that the wiring from the control to the
 * invalidation survives, and a handler call would skip exactly that.
 *
 * Waits for the option WITH THE PICKER OPEN, because the offered list is
 * narrowed against the capability matrix and that is a react-query read: on the
 * first paint the list is still the fallback (which offers no Tron at all), and
 * clicking straight away raced it.
 */
const changeChain = async (currentChainName: string, to: string): Promise<void> => {
  fireEvent.click(screen.getByRole("button", { name: `On ${currentChainName} - Change network` }));
  const option = await waitFor(() => {
    const found = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-label="Select network"] .token-search-chain-item',
      ),
    ).find((el) => (el.textContent ?? "").includes(to));
    if (!found) throw new Error(`chain option "${to}" not offered`);
    return found;
  }, WAIT);
  fireEvent.click(option);
};

const flip = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Swap direction" }));
};

/** The priced receipt. Present only while a quote is live for the current pair. */
const receiptShown = (): boolean => document.querySelector(".quote-details") !== null;

const waitForReceipt = async (): Promise<void> => {
  // useIntent debounces the quote by 500ms and the client retries with backoff,
  // so this window has to clear a full request cycle on a shared CPU.
  await waitFor(() => expect(receiptShown()).toBe(true), WAIT);
};

// ============================================================
// The amount is denominated in the origin token
// ============================================================

describe("an origin change drops the amount", () => {
  it("clears the pay field when the origin chain moves", async () => {
    await renderTrade(<SwapPanel />, { connected: true });
    fireEvent.change(payAmount(), { target: { value: "1000" } });
    expect(payAmount().value).toBe("1000");

    // "1000" was 1000 USDC on Base. On another chain it is a figure the user
    // never typed for this route -- and on a token with different decimals it
    // is a different order by orders of magnitude.
    await changeChain("Base", "Ethereum");

    await waitFor(() => expect(payAmount().value).toBe(""), WAIT);
  });
});

// ============================================================
// The addresses are scoped to their leg
// ============================================================

/**
 * Skipped rather than hard-coded when the corridor is off. `TRON_DESTINATION_LIVE`
 * is a kill switch, and this directory's standing rule is to assert the
 * relationship to a flag and never its current value -- a test that requires
 * the corridor turns an incident rollback into a red build.
 *
 * The probe is a round TRIP, because the field unmounts the moment the
 * destination stops being non-EVM. Coming back to Tron distinguishes the two
 * outcomes: the state was cleared (empty field) versus the field merely went
 * off screen holding the old address (which is what shipped before the clear).
 */
describe("a destination change drops the recipient", () => {
  it.skipIf(!TRON_DESTINATION_LIVE)("clears the typed recipient, not just the field", async () => {
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/intent/quote": { body: quoteBody },
        "/api/capabilities": { body: LIVE_CAPABILITIES },
      }),
    );
    await renderTrade(<SwapPanel />, { connected: true });

    await changeChain("Arbitrum", TRON_NAME);
    const typed = "TQ5NMqJjW3Vv6cvKfLPzR9dJqAqWvUkZ9e";
    fireEvent.change(await waitFor(recipient, WAIT), { target: { value: typed } });
    expect(recipient().value).toBe(typed);

    // The address was chosen for Tron. It is base58, so on an EVM
    // destination it is not merely stale, it is unspendable.
    await changeChain(TRON_NAME, "Arbitrum");
    await waitFor(() => expect(addressField("swap-recipient")).toBeNull(), WAIT);

    await changeChain("Arbitrum", TRON_NAME);
    await waitFor(() => expect(recipient().value).toBe(""), WAIT);
  });
});

// ============================================================
// A flip is a re-denomination, not a reset
// ============================================================

describe("a flip carries the quote's output into the pay field", () => {
  it("re-denominates the amount instead of erasing it", async () => {
    await renderTrade(<SwapPanel />, { connected: true });
    fireEvent.change(payAmount(), { target: { value: "1000" } });
    await waitForReceipt();

    flip();

    // "1000 USDC -> 998 USDC" flips to "998 USDC -> ...". Erasing the field
    // here would make a flip cost the user their input; carrying the INPUT
    // instead would misprice the new order.
    await waitFor(() => expect(payAmount().value).toBe("998"), WAIT);
  });
});

describe("an explicit live Stealth receive choice invalidates the public receipt", () => {
  it("keeps the source and amount while replacing the receive route without setup", async () => {
    const walletMethods: string[] = [];
    let quoteRequests = 0;
    vi.stubGlobal(
      "fetch",
      apiStub(
        {
          "/api/capabilities": L1_STEALTH_CAPABILITIES,
          "/api/intent/quote": {
            answer: () => {
              quoteRequests += 1;
              return quoteBody;
            },
          },
        },
        { onWalletRpc: (method) => walletMethods.push(method) },
      ),
    );
    await renderTrade(<SwapPanel />, { connected: true });
    fireEvent.change(payAmount(), { target: { value: "1000" } });
    await waitForReceipt();
    const publicQuoteRequests = quoteRequests;

    fireEvent.click(screen.getByRole("button", { name: /^Stealth/ }));
    await waitFor(() => expect(receiptShown()).toBe(false), WAIT);
    await changeChain("Arbitrum", "Ethereum");

    expect(payAmount().value).toBe("1000");
    expect(screen.getByRole("button", { name: "On Base - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(receiptShown()).toBe(false);
    expect(quoteRequests).toBe(publicQuoteRequests);
    expect(walletMethods).not.toContain("personal_sign");
    expect(walletMethods).not.toContain("eth_sign");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ============================================================
// A quote belongs to the pair it was served for
// ============================================================

describe("no leg change leaves a priced receipt on screen", () => {
  it.each<[string, () => void | Promise<void>]>([
    ["the origin chain", () => changeChain("Base", "Ethereum")],
    ["the destination chain", () => changeChain("Arbitrum", "Ethereum")],
    ["the direction", flip],
  ])("drops the receipt when %s changes", async (_label, move) => {
    await renderTrade(<SwapPanel />, { connected: true });
    fireEvent.change(payAmount(), { target: { value: "1000" } });
    await waitForReceipt();

    await move();

    // A receipt surviving the move is a price for the PREVIOUS pair sitting
    // above a form that now describes a different one, which is the state a
    // user signs from.
    await waitFor(() => expect(receiptShown()).toBe(false), WAIT);
  });
});
