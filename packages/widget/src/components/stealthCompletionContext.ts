/**
 * Claim from the stealth receipt itself. Trade provides it only while the
 * stealth keys are unlocked and the wallet is signed in, so the completion
 * screen can find the payment it just watched land and claim it to the
 * connected wallet without a trip to the Claims tab. Null otherwise; the
 * receipt then hands off to Claims as before.
 */

import { createContext, useContext } from "react";
import type { ClaimResult } from "../hooks/useStealthClaim.js";
import type { ChainStealthPayment } from "../hooks/useStealthScanner.js";

export interface StealthCompletion {
  /** Payments the unlocked keys found this session and not yet claimed or sent. */
  payments: readonly ChainStealthPayment[];
  isScanning: boolean;
  /** Look again (keys are already unlocked: never prompts). */
  scan: () => void;
  /** Claim to the connected wallet. */
  claim: (payment: ChainStealthPayment) => Promise<ClaimResult>;
}

export const StealthCompletionContext = createContext<StealthCompletion | null>(null);

export function useStealthCompletion(): StealthCompletion | null {
  return useContext(StealthCompletionContext);
}
