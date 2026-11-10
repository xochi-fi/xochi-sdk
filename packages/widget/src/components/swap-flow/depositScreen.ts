/**
 * Everything the deposit screen renders, resolved from the ATTESTED binding and
 * from nothing else.
 *
 * WHY THIS EXISTS. `SwapFlowModal` already sourced the four money-routing lines
 * (address, payout, refund, deadline) off the verified binding. The other half of
 * the screen still came from live panel props: the amount to send, its symbol and
 * decimals, the origin chain, the destination symbol and the payout estimate. So
 * the single most consequential sentence in the app,
 *
 *   "Send exactly {amount} {symbol} on {chain} to this address"
 *
 * had a proven address and an unproven instruction attached to it, followed by a
 * warning that a different token or network "cannot be recovered".
 *
 * That split was reachable two ways, neither of them exotic:
 *
 *  - With no attacker at all. `resolveTokenForChain` in useSwapRoute re-runs when
 *    the solver's capability matrix refreshes, with no guard on the flow modal
 *    being open, and calls `setFromToken`. A refresh while the deposit screen is
 *    up re-rendered the instruction with a different symbol and different
 *    DECIMALS under a live, correctly attested address.
 *  - On a resumed swap, those props originate in `record.data`, which is
 *    localStorage: same-origin mutable state that `verifyStoredDeposit` does not
 *    cover. It binds `intentId` and `wallet` and proves the signature; it says
 *    nothing about `data.fromAmount`. Leaving the attestation byte-identical and
 *    editing that one field passes every check while telling the user to send a
 *    different amount to a genuine address.
 *
 * The fix is not another comparison. It is removing the second derivation: every
 * value below comes off the one object the signature covers, so there is nothing
 * left to drift. `DepositAttestationFields` binds all of them (v3 signs the
 * destination side precisely so a substituted quote has to be economically
 * identical), so nothing here is fabricated or re-derived from live state.
 *
 * Returns null on a binding this client cannot render faithfully. That is a
 * refusal, not a fallback: the caller shows the unavailable view rather than a
 * partially-attested screen, which is the failure mode this module removes.
 */

import { getTokenInfoForChain, isSelectableChainId } from "@xochi/client";
import type { SelectableChainId } from "@xochi/client";
import { formatTokenAmount } from "../../utils/format.js";
import type { DepositAttestationFields } from "@xochi/client";

/** The deposit screen's inputs, every one of them attested. */
export interface DepositScreenView {
  depositAddress: string;
  /** Origin amount in base units, as signed. */
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  fromChainId: SelectableChainId;
  toSymbol: string;
  toChainId: SelectableChainId;
  /** Display-formatted attested payout, or undefined if it will not parse. */
  receivedAmount?: string;
  payoutAddress?: string;
  refundAddress?: string;
  depositDeadline?: number;
}

/**
 * Display-format an attested base-units amount, or undefined when it is not one.
 *
 * Undefined rather than "0" or "": the payout line is omitted entirely when this
 * cannot be resolved, and a zero would be a claim about the deal rather than an
 * absence of one. `BigInt` throws on a malformed string and returns 0n for "",
 * so both are excluded before it is reached.
 */
function formatAttestedAmount(raw: string, decimals: number): string | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  return formatTokenAmount(BigInt(raw), decimals, 6);
}

/**
 * Resolve the deposit screen from a proven binding, or null if it cannot be.
 *
 * The chain ids are narrowed rather than cast. They are typed `number` on the
 * binding because that is what the solver sends and what the message signs, and
 * a chain this build cannot name is one whose token registry, explorer and
 * display name are all absent. Rendering "Send exactly 100 USDT on undefined" is
 * worse than saying we cannot show the screen.
 */
export function buildDepositScreen(
  attested: DepositAttestationFields | null | undefined,
): DepositScreenView | null {
  if (!attested?.deposit_address) return null;
  if (!isSelectableChainId(attested.from_chain_id)) return null;
  if (!isSelectableChainId(attested.to_chain_id)) return null;

  const fromChainId = attested.from_chain_id;
  const toChainId = attested.to_chain_id;

  // Chain-aware, because `getTokenInfoByAddress` lowercases and that destroys
  // base58: a Tron token would resolve to a truncated-address symbol and the
  // 18-decimal default, and the decimals are what scale the amount the user is
  // told to send.
  const fromInfo = getTokenInfoForChain(attested.from_token, fromChainId);
  const toInfo = getTokenInfoForChain(attested.to_token, toChainId);
  if (!fromInfo || !toInfo) return null;

  return {
    depositAddress: attested.deposit_address,
    fromAmount: attested.from_amount,
    fromSymbol: fromInfo.symbol,
    fromDecimals: fromInfo.decimals,
    fromChainId,
    toSymbol: toInfo.symbol,
    toChainId,
    receivedAmount: formatAttestedAmount(attested.to_amount, toInfo.decimals),
    // Empty means the field bound nothing, which renders no address rather than
    // falling back to a live one. See DepositInstructions.
    payoutAddress: attested.recipient || undefined,
    refundAddress: attested.refund_address || undefined,
    depositDeadline: attested.deposit_deadline ?? undefined,
  };
}
