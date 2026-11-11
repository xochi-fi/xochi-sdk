/**
 * useEmbedDefaults
 *
 * The frame URL parameters (embedParams.ts) as the swap panel's opening state.
 * Read from the URL ONCE, at mount, which in the frame is page load: a host
 * that wants other defaults loads another URL.
 *
 * Two answers, because the capability matrix arrives after the first render:
 *
 *   seed     resolved against whatever matrix is on hand at mount (normally
 *            the fallback), so the panel opens on the requested route at once
 *            rather than flashing the defaults first;
 *   settled  resolved again once the matrix has answered (live, or failed and
 *            left on the fallback). Null until then.
 *   codes    referral and promo codes, sent on every quote.
 *
 * The composition applies `settled` over `seed` only while the opening is
 * untouched. Bare URLs also resolve: a served trusted Stealth route is preferred
 * over the static fallback without moving a route the user or host selected.
 */

import { useMemo, useState } from "react";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import {
  embedCodes,
  embedOffer,
  resolveEmbedDefaults,
  type EmbedCodes,
  type EmbedDefaults,
} from "./embedParams.js";
import { parseEmbedParams } from "@xochi/widget-lib";

export interface UseEmbedDefaultsResult {
  seed: EmbedDefaults;
  settled: EmbedDefaults | null;
  codes: EmbedCodes;
  settlementPreference: "public" | "stealth" | undefined;
}

export function useEmbedDefaults(): UseEmbedDefaultsResult {
  const { capabilities, state, isLoading } = useCapabilities();
  const [params] = useState(() => parseEmbedParams(window.location.search));
  const [codes] = useState(() => embedCodes(params));
  const [seed] = useState(() => resolveEmbedDefaults(params, embedOffer(capabilities, state)));
  const settled = useMemo(
    () => (!isLoading ? resolveEmbedDefaults(params, embedOffer(capabilities, state)) : null),
    [isLoading, params, capabilities, state],
  );
  return { seed, settled, codes, settlementPreference: params.settlement };
}
