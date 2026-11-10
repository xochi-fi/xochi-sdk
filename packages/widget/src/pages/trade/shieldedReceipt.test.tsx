// @vitest-environment jsdom

/**
 * A shielded payout in the activity feed, from the owner's server history.
 *
 * The Worker holds a shielded order at `settling` with `awaiting_recipient` once
 * the Aztec payout is final; only the recipient's signed receipt completes it.
 * What must stay true, against the real provider stack and the rendered DOM:
 *   - the row is labelled as an Aztec payout with its Shielded tag, and names
 *     the Aztec token it pays;
 *   - it says the payment is made and the recipient's receipt is next, and
 *     never sends the payer to support however long that takes;
 *   - it hands over the recipient's command exactly while receipts are live;
 *   - once the order completes, neither the waiting copy nor the command stays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderTrade, apiStub, TEST_ACCOUNT } from "./harness.js";
import { statusWire } from "../../test/intentHarness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "./embedParams.js";
import { STORAGE_KEYS } from "../../constants.js";
import { RECIPIENT_RECEIPTS_LIVE } from "../../config.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 2 }) });

const INTENT_ID = "xi_shielded_receipt";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Oxide DAI on Aztec (corridor manifest), 18 decimals. */
const OXDAI = "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3";
const COMMAND = `xochi-recipient receipt ${INTENT_ID}`;
const AWAITING = "Paid on Aztec. Waiting for the recipient to confirm receipt.";

/** A shielded order as the owner's history serves it, two hours after submit. */
const historyRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: INTENT_ID,
  status: "settling",
  substatus: "awaiting_recipient",
  settlement_type: "shielded",
  from_chain_id: 8453,
  to_chain_id: 1,
  from_token: USDC_BASE,
  to_token: OXDAI,
  from_amount: "5000000",
  to_amount: "1690000000000000000",
  tier: "Standard",
  fee_rate: 0.22,
  tx_hash: null,
  created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  ...over,
});

/**
 * Serve one history row from the platform boundary, and its owner status read
 * (by default the row's own status, so nothing moves).
 */
const serve = (
  row: Record<string, unknown>,
  status: Record<string, unknown> = { status: row.status, substatus: row.substatus },
): void => {
  sessionStorage.setItem(
    STORAGE_KEYS.walletSession,
    JSON.stringify({ token: "harness-wallet-session", wallet: TEST_ACCOUNT.toLowerCase() }),
  );
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/settlement": { body: { settlements: [] } },
      "/api/intent/history": { body: { intents: [row] } },
      "/status": { body: statusWire({ intent_id: INTENT_ID, ...status }) },
    }),
  );
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  sessionStorage.clear();
});

/**
 * Open the Activity tab and expand the one row it shows, once its badge reads
 * `badge`. A live row opens the strip by itself; a settled one waits for the
 * toggle. Clicking before the row settles would hit the live copy it replaces.
 */
const expandRow = async (badge: string): Promise<void> => {
  fireEvent.click(screen.getByRole("tab", { name: /^Activity/ }));
  const toggle = screen.getByRole("button", { name: "Toggle activity" });
  const found = await waitFor(() => {
    // Not the loading skeleton, which shares the class.
    const rowButton = document.querySelector<HTMLElement>(".activity-row-wrapper > .activity-row");
    if (rowButton?.querySelector(".activity-status-badge")?.textContent === badge) return rowButton;
    if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
    throw new Error(`no activity row reading ${badge}`);
  }, WAIT);
  fireEvent.click(found);
};

/** The one row, looked up fresh: a row that settles remounts in the past list. */
const row = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".activity-row-wrapper");
  if (!found) throw new Error("activity row not rendered");
  return found;
};

const headline = (): string | null | undefined =>
  row().querySelector(".expanded-status__headline")?.textContent;

describe("a shielded payout waiting on the recipient", () => {
  it("is labelled as an Aztec payout and names the recipient's next step", async () => {
    serve(historyRow());
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await expandRow("Settling");

    expect(row().querySelector(".activity-chain-route")?.textContent).toMatch(/Aztec\s*Shielded$/);
    // After the token icon's fallback letter, when it has no image.
    expect(row().querySelector(".to-token")?.textContent).toMatch(/^\D?1\.69 OXDAI$/);
    expect(document.querySelector(".activity-strip__latest")?.textContent).toMatch(
      /USDC -> \D?OXDAI/,
    );
    expect(headline()).toBe(AWAITING);
    expect(row().textContent).not.toMatch(/hello@xochi\.fi/);
    // Behind the client kill switch: the receipt endpoints 404 until it flips.
    expect(row().textContent?.includes(COMMAND)).toBe(RECIPIENT_RECEIPTS_LIVE);
  });

  it("offers no receipt command before the payout is final", async () => {
    serve(historyRow({ substatus: null }));
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await expandRow("Settling");

    expect(headline()).toMatch(/^Settling on/);
    expect(row().textContent).not.toContain("xochi-recipient");
  });

  // The history poll keeps the last known substatus when a completed read
  // carries none, so the marker outlives completion; the status decides.
  it("drops the waiting copy and the command once the receipt completes it", async () => {
    serve(historyRow(), { status: "completed", substatus: null, terminal: true });
    await renderTrade(<Trade look={FULL_LOOK} />, { connected: true });
    await expandRow("Complete");

    expect(headline()).toBe("Complete");
    expect(row().textContent).not.toContain(AWAITING);
    expect(row().textContent).not.toContain("xochi-recipient");
  });
});
