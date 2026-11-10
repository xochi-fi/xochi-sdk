/**
 * Stealth announcement scanning (ERC-5564), the on-chain half.
 *
 * The pure crypto (key derivation, view tags, the stealth owner derivation and
 * the metadata layout) lives in `@xochi/signer`. What stays here reads the
 * chain: the factory's `getAddress` for the counterfactual match, behind the
 * factory trust check, and the token balance that filters swept payments.
 *
 * @see https://eips.ethereum.org/EIPS/eip-5564
 */

import { parseAbi, type Hex, type PublicClient } from "viem";
import {
  checkViewTag,
  decodeAnnouncementMetadata,
  deriveStealthOwner,
  type StealthAnnouncement,
  type StealthPayment,
} from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY, isTrustedStealthFactory } from "@xochi/client";

// getAddress(owner, salt) -> counterfactual SimpleAccount address.
// Riddler derives the same value via an on-chain eth_call to this method
// (simple_account.ex), NOT an offline CREATE2 formula, so we do the same to
// guarantee byte-exact parity and avoid replicating ERC1967 proxy bytecode.
const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export interface CounterfactualAddressParams {
  /**
   * Stealth EOA that owns the SimpleAccount. This is the ERC-5564 stealth
   * address derived client-side (address(P')), used as the SimpleAccount owner.
   */
  owner: Hex;
  /**
   * viem public client bound to the DESTINATION chain. The derivation is an
   * on-chain `eth_call`, so the client must target the chain where the
   * SimpleAccount will be deployed.
   */
  client: PublicClient;
  /**
   * SimpleAccountFactory address. Defaults to the pinned v0.8 factory; pass the
   * factory from `/xochi/capabilities` once Riddler exposes it.
   */
  factory?: Hex;
  /** CREATE2 salt. One account per stealth EOA -> 0. */
  salt?: bigint;
  /**
   * Destination chain id. LOAD-BEARING: the factory allowlist is per-chain, so
   * this is what the trust check is evaluated against. Omitting it fails closed
   * rather than skipping the check.
   */
  chainId: number;
}

/**
 * Compute the counterfactual SimpleAccount address for a stealth owner.
 *
 * Parity with Riddler is guaranteed by calling the factory's `getAddress`
 * on-chain (viem `readContract`) on the destination chain rather than
 * reimplementing the CREATE2 + ERC1967 proxy derivation. This is an RPC call,
 * so it is async and cannot be exercised offline.
 */
export async function computeCounterfactualAddress(
  params: CounterfactualAddressParams,
): Promise<Hex> {
  const { owner, client, factory = SIMPLE_ACCOUNT_FACTORY as Hex, salt = 0n, chainId } = params;

  // THE chokepoint. This is the single place a factory address becomes a payout
  // destination, so the trust check belongs here rather than at each caller.
  // Gating callers instead left `scanAnnouncements` and this function exported
  // with `factory` as a plain parameter: any future caller could pass an
  // unvetted factory and every call-site check would be irrelevant.
  //
  // Throws rather than returning a sentinel: there is no sensible address to
  // return, and a caller that ignores the result would derive against the
  // attacker's factory anyway. Callers already treat derivation as fallible.
  if (!isTrustedStealthFactory(factory, chainId)) {
    throw new Error(
      `Refusing to derive a stealth payout against an untrusted SimpleAccountFactory ` +
        `(${factory} on chain ${chainId}). See TRUSTED_STEALTH_FACTORIES.`,
    );
  }

  const address = await client.readContract({
    address: factory,
    abi: SIMPLE_ACCOUNT_FACTORY_ABI,
    functionName: "getAddress",
    args: [owner, salt],
  });

  return address;
}

/**
 * Check if we can spend from a stealth announcement.
 *
 * In the counterfactual SimpleAccount model the announcement carries the
 * counterfactual SimpleAccount address, NOT the stealth owner EOA. So the full
 * check derives the owner EOA (pure), computes the counterfactual from it via
 * the factory (on-chain), and matches the announced address against that.
 *
 * This is async because the counterfactual derivation is an `eth_call`.
 */
export async function canSpendFromAddress(
  announcement: StealthAnnouncement,
  spendingPrivKey: Uint8Array,
  viewingPrivKey: Uint8Array,
  client: PublicClient,
  factory: Hex | undefined,
  chainId: number,
): Promise<StealthPayment | null> {
  const { stealthPrivKey, stealthEOA } = deriveStealthOwner(
    announcement,
    spendingPrivKey,
    viewingPrivKey,
  );

  // The announced destination is the counterfactual SimpleAccount owned by the
  // stealth EOA, so compare the counterfactual (not the EOA) to the announcement.
  const counterfactual = await computeCounterfactualAddress({
    owner: stealthEOA as Hex,
    client,
    factory,
    chainId,
  });

  if (counterfactual.toLowerCase() !== announcement.stealthAddress.toLowerCase()) {
    return null;
  }

  return {
    announcement,
    stealthPrivKey,
  };
}

const ERC20_BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * Read the counterfactual's balance of the token the announcement names.
 *
 * `undefined` means "could not tell" (the metadata predates the full layout, or
 * the call failed), which is deliberately distinct from `0n`. A payment is only
 * dropped as swept on a definite zero: an RPC hiccup must never hide a real
 * claimable payment, because the user's only route to those funds is this list.
 */
async function readSettledBalance(
  announcement: StealthAnnouncement,
  client: PublicClient,
): Promise<{ token: string; balance: bigint } | undefined> {
  const metadata = decodeAnnouncementMetadata(announcement.metadata);
  if (!metadata) return undefined;

  try {
    const balance = await client.readContract({
      address: metadata.token as Hex,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [announcement.stealthAddress as Hex],
    });
    return { token: metadata.token, balance };
  } catch {
    // Log rather than swallow: a persistent read failure here degrades the scan
    // to "show everything", which is the pre-fix behaviour and safe, but it is
    // not something to discover silently.
    console.warn(
      "[stealth] balanceOf failed for",
      announcement.stealthAddress,
      "- keeping the payment in the list",
    );
    return undefined;
  }
}

/**
 * Scan announcements for payments to us.
 *
 * Three passes, cheapest first: the view tag (pure, no RPC), the counterfactual
 * match (one `eth_call` per candidate factory), then the on-chain balance (one
 * more `eth_call`) to drop payments that have already been swept. Multiple
 * trusted factories keep payments discoverable across a factory rotation.
 *
 * The balance pass exists because a match alone says "this payment was sent to
 * an address you control", not "these funds are still there". A claimed payment
 * kept matching forever and kept a live CLAIM button, and clicking it spent a
 * claim rate-limit token to receive an error: Riddler drops the intent out of
 * `claimable?` once `receiving_tx_hash` is set, so the answer is always a
 * refusal. With `claimAll` walking the list top-down, every dead row was a
 * guaranteed wasted token before any real payment was reached (#470).
 */
export async function scanAnnouncements(
  announcements: StealthAnnouncement[],
  spendingPrivKey: Uint8Array,
  viewingPrivKey: Uint8Array,
  client: PublicClient,
  factories: Hex | readonly Hex[] | undefined,
  chainId: number,
): Promise<StealthPayment[]> {
  const candidates: readonly (Hex | undefined)[] =
    typeof factories === "string" || factories === undefined ? [factories] : factories;
  const payments: StealthPayment[] = [];

  for (const announcement of announcements) {
    // Fast filter by view tag
    if (!checkViewTag(announcement, viewingPrivKey)) {
      continue;
    }

    // Full check (counterfactual match; on-chain)
    let payment: StealthPayment | null = null;
    for (const factory of candidates) {
      payment = await canSpendFromAddress(
        announcement,
        spendingPrivKey,
        viewingPrivKey,
        client,
        factory,
        chainId,
      );
      if (payment) break;
    }
    if (!payment) {
      continue;
    }

    const settled = await readSettledBalance(announcement, client);
    if (settled?.balance === 0n) {
      continue;
    }

    // Carry the token and the live balance through. Both fields have been on
    // StealthPayment all along and nothing ever populated them, so the claims
    // list had no amount to show.
    payments.push(
      settled === undefined
        ? payment
        : { ...payment, tokenAddress: settled.token, amount: settled.balance.toString() },
    );
  }

  return payments;
}
