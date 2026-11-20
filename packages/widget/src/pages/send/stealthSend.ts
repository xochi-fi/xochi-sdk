/**
 * The Send tab's `stealth` destination, as data.
 *
 * A Stealth send is the existing Stealth settlement, not a new transfer type:
 * the value leaves the connected wallet as a Xochi order whose payout lands at
 * a one-time address derived from the wallet's own stealth keys (ERC-5564),
 * claimed later from Claims. The quote, the signature, the confirm modal and
 * every refusal are the Swap card's, reached through its prefill, so nothing
 * here derives keys or addresses and nothing can settle Public in its place.
 *
 * Which networks the payout may land on is the producer's exact route list,
 * and only while it is `live`: the same asset, routed with `stealth` among its
 * privacy modes. Anything else offers nothing.
 */

import type { CapabilityRoute, SolverCapabilities } from "@xochi/signer";
import type { CapabilityState } from "@xochi/client";
import { sendTokens } from "./addressSend.js";

/** Destination chains a Stealth send of `symbol` from `chainId` can settle on. */
export function stealthSendDestinations(
  caps: Pick<SolverCapabilities, "routes">,
  state: CapabilityState,
  chainId: number,
  symbol: string,
): number[] {
  if (state !== "live" || caps.routes === null) return [];
  const out: number[] = [];
  for (const route of caps.routes as readonly CapabilityRoute[]) {
    const { origin, destination } = route;
    if (
      origin.chainId === chainId &&
      origin.token === symbol &&
      destination.kind === "chain" &&
      destination.token === symbol &&
      route.privacyModes.includes("stealth") &&
      sendTokens(destination.chainId).some((t) => t.symbol === symbol) &&
      !out.includes(destination.chainId)
    ) {
      out.push(destination.chainId);
    }
  }
  return out;
}
