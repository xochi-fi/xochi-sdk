import { decodeAnnouncementMetadata } from "@xochi/signer";
import { getTokenInfoForChain } from "@xochi/client";
import { formatTokenAmount } from "../utils/format.js";
import type { ChainStealthPayment } from "../hooks/useStealthScanner.js";

/** The registry token a payment pays out in, or null when it cannot be shown honestly. */
function paymentToken(
  payment: ChainStealthPayment,
): { symbol: string; decimals: number; amount: bigint } | null {
  const announced = decodeAnnouncementMetadata(payment.announcement.metadata);
  const token = announced?.token ?? payment.tokenAddress;
  const amount = announced ? announced.amount : payment.amount ? BigInt(payment.amount) : undefined;
  if (!token || amount === undefined) return null;
  const info = getTokenInfoForChain(token, payment.chainId);
  return info ? { ...info, amount } : null;
}

/**
 * Render the payout this announcement describes.
 *
 * Reads the ERC-5564 metadata rather than `payment.amount`/`payment.tokenAddress`,
 * which are optional on StealthPayment and which nothing populates: the scanner
 * sets neither. The announcement carries both on chain, which is also the figure
 * the claim's verification checks the operation against.
 */
export function formatPaymentAmount(payment: ChainStealthPayment): string | null {
  const token = paymentToken(payment);
  return token
    ? `${formatTokenAmount(token.amount, token.decimals, token.decimals)} ${token.symbol}`
    : null;
}

/** One order's stealth payout: its chain, registry token symbol and exact base-unit amount. */
export interface StealthPayout {
  chainId: number;
  symbol: string;
  amount: bigint;
}

/** Whether `payment` is exactly `payout`: same chain, token and amount to the base unit. */
export function paysOut(payment: ChainStealthPayment, payout: StealthPayout): boolean {
  const token = paymentToken(payment);
  return (
    payment.chainId === payout.chainId &&
    token?.symbol === payout.symbol &&
    token.amount === payout.amount
  );
}
