/**
 * useTrustScore Hook
 *
 * The one place the widget turns the local verify state into a trust score.
 * Returns the EFFECTIVE score (`effectiveTrustScore`): 0 unless the server says
 * trust economics is live, so no consumer can show or send a tier the server
 * does not honour. `verifyState` is passed through for the non-score fields.
 */

import { useCapabilities } from "./useCapabilities.js";
import { useLocalStorageRead } from "./useLocalStorage.js";
import { effectiveTrustScore } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";
import { type VerifyState, isVerifyState } from "../types/index.js";

export interface UseTrustScoreReturn {
  /** Effective trust score: 0 while trust economics is off. */
  trustScore: number;
  /** Raw local verify state (connected providers etc.); never read its score. */
  verifyState: VerifyState | null;
}

export function useTrustScore(): UseTrustScoreReturn {
  const verifyState = useLocalStorageRead<VerifyState>(STORAGE_KEYS.verifyState, isVerifyState);
  const { features } = useCapabilities();
  return {
    trustScore: effectiveTrustScore(verifyState?.score ?? 0, features),
    verifyState,
  };
}
