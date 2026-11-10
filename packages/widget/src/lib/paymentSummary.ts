/**
 * The payment line of the quote panel and the confirm modal: the gas state and
 * what the wallet will be asked to do, in one compact line.
 *
 * The signature count is read off the quote, never the method label: a quote
 * that carries a pull authorization asks for two signatures (the intent, then
 * the pull), the same rule the signing flow counts by (`signingSlot` in
 * @xochi/client). Riddler declares "pimlico" on every stealth quote yet still
 * serves a pull, and a preview quote names erc3009/permit2 with the pull
 * stripped, so a gasless quote without a pull promises no count at all.
 *
 * A gasless method still costs one gasful `approve(Permit2)` when the
 * allowance is short, so "No gas" is claimed only when the allowance is known
 * to cover the amount (`paysNoGas`); an unknown allowance gets a conditional
 * that is true either way.
 */

import { GLYPH } from "./glyphs.js";
import { paysNoGas, type OriginApproval, type PaymentMethod } from "../types/intent.js";

export function paymentSummary(
  method: PaymentMethod,
  hasPull: boolean,
  approval: OriginApproval,
): string {
  const sep = ` ${GLYPH.sep} `;
  switch (method) {
    case "erc3009":
    case "permit2":
    case "pimlico":
    case "mpp": {
      const gas = paysNoGas(method, approval)
        ? "No gas"
        : approval === "required"
          ? "Gas for a one-time approval"
          : "Gas only if an approval is needed";
      return hasPull ? `${gas}${sep}sign twice` : gas;
    }
    case "approval":
      // An on-chain approval transaction first (gas), then the intent signature.
      return `Gas needed${sep}approve, then sign`;
    case "deposit":
      // The tokens are sent from the wallet itself, and nothing is signed.
      return `Gas needed${sep}send the tokens`;
    case "x402":
      return `Gas needed${sep}pay per call`;
  }
}
