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

/** Whether `payment` pays out `symbol` on `chainId`. */
export function paysOut(payment: ChainStealthPayment, chainId: number, symbol: string): boolean {
  return payment.chainId === chainId && paymentToken(payment)?.symbol === symbol;
}
