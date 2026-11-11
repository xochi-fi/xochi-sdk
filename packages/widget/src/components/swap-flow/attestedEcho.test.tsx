// @vitest-environment jsdom

/**
 * What the deposit screen is allowed to source its money-routing lines from.
 *
 * A deposit route is the only flow in the app where the user moves funds by hand
 * off a displayed instruction. Every value on that screen has a live panel or
 * wallet twin sitting next to it that keeps moving after the quote is bound:
 *
 *   - the refund input stays editable, and re-quoting is suppressed once the
 *     flow modal is open, so an edit changes the input and not the binding;
 *   - `awaiting_deposit` is deliberately absent from WALLET_INTERRUPTIBLE_STATES
 *     (an in-flight swap is never yanked out from under the user), so switching
 *     accounts changes `useAccount().address` and not the signed recipient;
 *   - `resolveTokenForChain` re-runs when the capability matrix refreshes, with
 *     no guard on this modal being open, so the symbol and DECIMALS in "Send
 *     exactly X USDT on Tron" could change under a correctly attested address;
 *   - on a RESUMED swap those props originate in localStorage, which
 *     `verifyStoredDeposit` binds the intent id and wallet of but says nothing
 *     about `data.fromAmount`.
 *
 * The fix was not another comparison, it was removing the second derivation:
 * `buildDepositScreen` resolves the whole screen from the one object the
 * signature covers.
 *
 * THIS FILE USED TO ASSERT SOURCE TEXT, and said so: "the divergence only exists
 * across a wallet change on a mounted modal with a live intent, which needs a
 * wallet and an API this repo will not fake". That is no longer true. jsdom
 * renders are possible now, and collapsing eighteen drilled intent props into
 * one `IntentView` means the disagreement can simply be CONSTRUCTED: hand the
 * modal an attestation naming one deal and drilled display props naming a
 * different one, and check which set reaches the screen. So the checks below are
 * about rendered output rather than which identifier the JSX is spelled with --
 * which is stronger, since a rename can no longer make them vacuous and a
 * rewiring can no longer slip past them.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SwapFlowModal, type IntentView } from "../SwapFlowModal.js";
import { DEFAULT_DESTINATION } from "../../types/intent.js";
import type { QuoteResponse } from "../../types/intent.js";
import type { DepositAttestationFields, StoredDepositAttestation } from "@xochi/client";
import { testBudget } from "../../test/waitBudget.js";

// Longest test: "stops claiming to check once the poll has given up" -- it
// renders the deposit screen, cleans up, and renders it again, so 2 renders and
// 0 waits (this file has no waitFor and no findBy; every assertion reads the
// DOM synchronously). It carried no budget at all and ran on vitest's 5000ms
// default, which is what it was failing against.
vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 0 }) });

afterEach(cleanup);

const ATTESTED_DEPOSIT_ADDRESS = "TQ5NMqJjW8sTUCcxQd1hnG4qNbFbnQwzoV";
const ATTESTED_PAYOUT = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const ATTESTED_REFUND = "TRefundRefundRefundRefundRefundRefu";
const LIVE_WALLET = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TRON = 728126428;

/**
 * The signed binding: 100 USDT on Tron in, 99.5 USDC on Arbitrum out.
 *
 * These are the ONLY values the screen may render. Everything drilled in beside
 * them below deliberately disagrees.
 */
const attestedFields = (
  over: Partial<DepositAttestationFields> = {},
): DepositAttestationFields => ({
  intent_id: "xi_deposit",
  quote_id: "q_deposit",
  wallet: ATTESTED_PAYOUT,
  from_chain_id: TRON,
  from_token: USDT_TRON,
  from_amount: "100000000",
  deposit_address: ATTESTED_DEPOSIT_ADDRESS,
  deposit_deadline: null,
  refund_address: ATTESTED_REFUND,
  to_chain_id: 42161,
  to_token: USDC_ARB,
  to_amount: "99500000",
  min_to_amount: "99000000",
  recipient: ATTESTED_PAYOUT,
  stealth_spending_pub_key: null,
  stealth_viewing_pub_key: null,
  settlement_preference: "public",
  ...over,
});

const stored = (over: Partial<DepositAttestationFields> = {}): StoredDepositAttestation => ({
  attested: attestedFields(over),
  // Never re-checked at render: `verifyDepositAttestation` (live) and
  // `verifyStoredDeposit` (restored) are what prove a binding, upstream of
  // here. This component's job is to render the proven one and nothing else.
  attestation: `0x${"cd".repeat(65)}`,
});

/** A quote with a deposit address, which is what selects the live path. */
const depositQuote: QuoteResponse = {
  success: true,
  intentId: "xi_deposit",
  quoteId: "q_deposit",
  canSolve: true,
  toAmount: "99500000",
  minToAmount: "99000000",
  xochiFee: "0",
  xochiFeeRate: "0.22",
  estimatedGasCost: "0",
  expiry: new Date(Date.now() + 60_000).toISOString(),
  gasless: false,
  settlementOptions: [],
  depositAddress: ATTESTED_DEPOSIT_ADDRESS,
};

const intentView = (over: Partial<IntentView> = {}): IntentView => ({
  status: "awaiting_deposit",
  error: null,
  refundReason: null,
  intentId: "xi_deposit",
  quoteId: "q_deposit",
  txHash: null,
  receivingTxHash: null,
  settlementTxHash: null,
  settlementChainId: null,
  substatus: null,
  quote: null,
  permitType: "none",
  approval: "none",
  awaitingPull: false,
  isSigningPull: false,
  quoteExpiresIn: null,
  raceEvents: [],
  fillMs: null,
  attestedDeposit: null,
  pollExhausted: false,
  receipt: { phase: "deposit", signing: { kind: "unavailable" } },
  ...over,
});

/**
 * Render the deposit phase with drilled display props that all DISAGREE with the
 * binding: a different origin token, a different origin chain, a different
 * amount, a different destination token, and the live wallet switched to another
 * account. Any of those reaching the screen is the regression.
 */
function renderDeposit(props: {
  intent: IntentView;
  resumedDeposit?: StoredDepositAttestation | null;
  onStartOver?: () => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SwapFlowModal
        open
        intent={props.intent}
        // Every one of these is the live-state twin of an attested field.
        fromAmount="1"
        fromSymbol="WETH"
        fromDecimals={18}
        toSymbol="WETH"
        toDecimals={18}
        receivedAmount="0.0004"
        fromChainId={8453}
        toChainId={10}
        destination={{ ...DEFAULT_DESTINATION, recipientAddress: LIVE_WALLET }}
        wallet={LIVE_WALLET}
        isCrossChain
        estimatedDuration={60}
        resumedDeposit={props.resumedDeposit}
        onStartOver={props.onStartOver}
        onConfirm={() => {}}
        onCancelSign={() => {}}
        onRetry={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** The rendered deposit screen's text, or "" when it is not on screen. */
const depositText = (): string =>
  document.querySelector(".deposit-instructions")?.textContent ?? "";

describe("the deposit screen renders the signed deal, not live state", () => {
  it("takes the whole instruction off the live quote's attestation", () => {
    renderDeposit({
      intent: intentView({ quote: depositQuote, attestedDeposit: stored() }),
    });

    const text = depositText();
    // The instruction the user acts on: attested amount, attested symbol,
    // attested origin chain. The drilled props say 1 WETH on Base.
    expect(text).toContain("Send exactly");
    expect(text).toContain("100 USDT");
    expect(text).toContain("Tron");
    expect(text).not.toContain("WETH");
    expect(text).not.toContain("Base");

    // The address itself, verbatim base58 -- never transformed.
    expect(screen.getByText(ATTESTED_DEPOSIT_ADDRESS)).toBeTruthy();

    // The payout line and the refund line, both attested. `wallet` and
    // `destination.recipientAddress` are the live account and must not appear:
    // an account switch here would otherwise tell the user their funds are
    // going somewhere the attestation never named.
    expect(text).toContain("99.5 USDC");
    expect(text).toContain(ATTESTED_PAYOUT.slice(0, 6));
    expect(text).toContain(ATTESTED_REFUND.slice(0, 6));
    expect(text).not.toContain(LIVE_WALLET.slice(0, 6));
  });

  it("renders the same screen for a resumed swap, which has no quote", () => {
    // The served quote is gone and is never synthesized (a fabricated price
    // shown as current would be a lie), so the deposit facts travel separately
    // -- restored from the record and re-proven by `verifyStoredDeposit`. This
    // is the flow whose completion REQUIRES leaving the browser, so it is the
    // one that most needs its screen back.
    renderDeposit({ intent: intentView(), resumedDeposit: stored() });

    const text = depositText();
    expect(text).toContain("100 USDT");
    expect(text).toContain(ATTESTED_DEPOSIT_ADDRESS);
    expect(text).not.toContain(LIVE_WALLET.slice(0, 6));
  });

  it("keeps the live quote's binding when both are present", () => {
    // They cannot legitimately disagree (the resumed one is only ever reached
    // with no quote in hand), so this pins which wins rather than inventing a
    // reconciliation.
    renderDeposit({
      intent: intentView({ quote: depositQuote, attestedDeposit: stored() }),
      resumedDeposit: stored({ deposit_address: "TStaleStaleStaleStaleStaleStaleStal" }),
    });
    expect(depositText()).toContain(ATTESTED_DEPOSIT_ADDRESS);
    expect(depositText()).not.toContain("TStaleStale");
  });
});

describe("nothing provable to show", () => {
  it("renders an unavailable body with a way out, and names no address", () => {
    /**
     * The deposit phase had exactly one body, gated on the binding, and the
     * timeline branch excludes this phase -- so a null binding produced a modal
     * containing a title and a close button. No address, no sign the swap was
     * still tracked, and no Start Over (that button lives inside
     * DepositInstructions), while closing records a dismissal so it never
     * offers to reopen.
     *
     * Not only tampering: the attestation signer is pinned at BUILD time, so
     * rotating it strands every stored in-flight deposit on the next load.
     */
    let startedOver = 0;
    renderDeposit({
      intent: intentView({ quote: depositQuote, attestedDeposit: null }),
      onStartOver: () => {
        startedOver += 1;
      },
    });

    expect(screen.getByRole("alert").textContent).toContain("The deposit address can't be shown");
    // It must not name an address it could not prove.
    expect(document.body.textContent).not.toContain(ATTESTED_DEPOSIT_ADDRESS);
    // And it has to offer the way out, or closing is the only move -- and
    // closing dismisses the swap permanently.
    screen.getByRole("button", { name: "Get a fresh address" }).click();
    expect(startedOver).toBe(1);
  });

  it("refuses a binding naming a chain this build cannot render", () => {
    // Rendering "Send exactly 100 USDT on undefined" under a proven address is
    // worse than saying the screen is unavailable.
    renderDeposit({
      intent: intentView({
        quote: depositQuote,
        attestedDeposit: stored({ from_chain_id: 999_999 }),
      }),
    });
    expect(screen.getByRole("alert").textContent).toContain("The deposit address can't be shown");
  });
});

describe("the waiting indicator is a claim about this client", () => {
  it("stops claiming to check once the poll has given up", () => {
    // "No deposit seen yet" and "no longer looking" otherwise render
    // identically, which is the failure mode where absent input reads as a
    // negative result. Derived from `intent.pollExhausted` inside the modal now,
    // rather than passed in beside it as `depositCheckActive` -- one fact, one
    // source.
    renderDeposit({
      intent: intentView({ quote: depositQuote, attestedDeposit: stored() }),
    });
    expect(depositText()).toContain("Waiting for the deposit...");
    cleanup();

    renderDeposit({
      intent: intentView({
        quote: depositQuote,
        attestedDeposit: stored(),
        pollExhausted: true,
      }),
    });
    expect(depositText()).toContain("Deposit check stopped");
    expect(depositText()).not.toContain("Waiting for the deposit...");
  });
});
