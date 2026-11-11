/**
 * The Developer parameters as a draft, two-way synced with the controls
 * (xochi-fi/xochi-widget#36, #47).
 *
 * A control change rewrites the draft. A draft the frame would fully honour
 * drives the controls through `apply`; one with problems is kept as typed and
 * not applied. Leaving the field tidies an applied draft to canonical form.
 */

import { useMemo, useState } from "react";
import { resolveEmbedDefaults, type EmbedDefaults, type EmbedOffer } from "../trade/embedParams.js";
import { type EmbedParams } from "@xochi/widget-lib";
import { paramsText, readParamsDraft } from "./paramsDraft.js";

export interface ParamsDraftState {
  /** The text as it stands. */
  draft: string;
  /** Why the draft is not applied; empty when it is. */
  problems: string[];
  /** The user typed `text`. */
  edit: (text: string) => void;
  /** The user left the draft: tidy it if it applied. */
  settle: () => void;
  /** Empty the draft (Reset). */
  clear: () => void;
}

/**
 * @param config What the frame opens on now, as the controls show it.
 * @param apply Make `params` the configuration. The caller resolves them with
 *   `resolveEmbedDefaults` against the same `offer`, which is what lets the
 *   draft predict the controls' next state below and keep the text as typed.
 */
export function useParamsDraft(
  config: EmbedDefaults,
  offer: EmbedOffer,
  apply: (params: EmbedParams) => void,
): ParamsDraftState {
  const canonical = paramsText(config);
  const [draft, setDraft] = useState(canonical);
  // The canonical text the draft was last synced with. When the controls move
  // away from it, the draft follows them.
  const [draftBase, setDraftBase] = useState(canonical);
  if (canonical !== draftBase) {
    setDraftBase(canonical);
    setDraft(canonical);
  }
  const problems = useMemo(() => readParamsDraft(draft, offer).problems, [draft, offer]);

  return {
    draft,
    problems,
    edit: (text) => {
      setDraft(text);
      const read = readParamsDraft(text, offer);
      if (read.problems.length > 0) return;
      apply(read.params);
      // What the controls will now show; matching it keeps the draft as typed.
      setDraftBase(paramsText(resolveEmbedDefaults(read.params, offer)));
    },
    settle: () => {
      if (problems.length === 0) setDraft(canonical);
    },
    clear: () => setDraft(""),
  };
}
