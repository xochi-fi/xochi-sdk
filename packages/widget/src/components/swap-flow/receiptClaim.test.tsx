// @vitest-environment jsdom

/**
 * The stealth receipt claims in place only the payment that is exactly this
 * swap's payout. An older unclaimed payout in the same token on the same chain
 * stays in Claims, and the receipt never reports it as this swap's claim.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { zeroAddress, type Hex } from "viem";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { SwapResult } from "./SwapResult.js";
import { StealthCompletionContext, type StealthCompletion } from "../stealthCompletionContext.js";
import type { ClaimResult } from "../../hooks/useStealthClaim.js";
import type { ChainStealthPayment } from "../../hooks/useStealthScanner.js";

const DAI_BASE = "50c5725949a6f0c72e6c4a641f24049a917db0cb";
const THIS_PAYOUT = 4_980_000_000_000_000_000n;

/** A Base DAI payment as the scanner hands it over, announcing `amount`. */
function daiPayment(amount: bigint, txHash: Hex): ChainStealthPayment {
  return {
    chainId: 8453,
    stealthPrivKey: new Uint8Array(32).fill(1),
    announcement: {
      schemeId: 1,
      stealthAddress: zeroAddress,
      caller: zeroAddress,
      ephemeralPubKey: `0x02${"11".repeat(32)}`,
      metadata: `0x01${DAI_BASE}a9059cbb${amount.toString(16).padStart(64, "0")}${SIMPLE_ACCOUNT_FACTORY.slice(2)}${"0".repeat(64)}`,
      blockNumber: 10,
      txHash,
      logIndex: 0,
    },
  };
}

const olderPayment = daiPayment(10_000_000_000_000_000_000n, `0x${"0a".repeat(32)}`);
const thisPayment = daiPayment(THIS_PAYOUT, `0x${"0b".repeat(32)}`);

/** Render the stealth receipt; `payoutAmount: null` is a swap whose quote is gone (a resume). */
function renderReceipt(
  completion: StealthCompletion,
  payoutAmount: string | null = THIS_PAYOUT.toString(),
) {
  const onGoToClaims = vi.fn();
  render(
    <StealthCompletionContext value={completion}>
      <SwapResult
        variant="success"
        isStealth
        stealthPayee="self"
        fromChainId={8453}
        toChainId={8453}
        isCrossChain={false}
        txHash={null}
        toSymbol="DAI"
        receivedAmount="4.98"
        payoutAmount={payoutAmount ?? undefined}
        onRetry={() => {}}
        onClose={() => {}}
        onGoToClaims={onGoToClaims}
      />
    </StealthCompletionContext>,
  );
  return { onGoToClaims };
}

afterEach(cleanup);

describe("stealth receipt claim", () => {
  it("claims this swap's payout, not an older one in the same token", async () => {
    const reply = Promise.withResolvers<ClaimResult>();
    const claim = vi.fn((_payment: ChainStealthPayment) => reply.promise);
    renderReceipt({
      payments: [olderPayment, thisPayment],
      isScanning: false,
      scan: vi.fn(),
      claim,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Claim 4.98 DAI" }));
    });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(thisPayment);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);

    await act(async () => reply.resolve({ success: true }));
    expect(screen.getByRole("status").textContent).toBe("Claimed to your wallet.");
  });

  it("hands off to Claims when only an older payout is known", () => {
    const claim = vi.fn();
    const { onGoToClaims } = renderReceipt({
      payments: [olderPayment],
      isScanning: false,
      scan: vi.fn(),
      claim,
    });

    expect(screen.queryByRole("button", { name: /^Claim \d/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Look again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim payment" }));
    expect(onGoToClaims).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("hands off to Claims when the swap's payout is unknown", () => {
    const claim = vi.fn();
    renderReceipt({ payments: [thisPayment], isScanning: false, scan: vi.fn(), claim }, null);

    expect(screen.queryByRole("button", { name: /^Claim \d/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Claim payment" })).toBeTruthy();
  });
});
