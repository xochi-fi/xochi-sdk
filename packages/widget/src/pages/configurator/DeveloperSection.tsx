/**
 * The Developer section (xochi-fi/xochi-widget#36): the `/embed` parameters as
 * editable text, with every problem the frame would silently swallow named.
 */

import { useId } from "react";
import { PARAM_KEYS } from "./paramsDraft.js";
import type { ParamsDraftState } from "./useParamsDraft.js";

interface DeveloperSectionProps {
  params: ParamsDraftState;
  /** The user typed in the draft (before it is checked). */
  onEdit: (text: string) => void;
}

export function DeveloperSection({ params, onEdit }: DeveloperSectionProps) {
  const paramsId = useId();
  const paramsHintId = useId();
  const paramsProblemsId = useId();
  return (
    <div className="config-field">
      <label htmlFor={paramsId} className="label">
        Embed parameters
      </label>
      <textarea
        id={paramsId}
        className="config-input config-params"
        rows={7}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder="None"
        value={params.draft}
        aria-invalid={params.problems.length > 0}
        aria-describedby={`${paramsProblemsId} ${paramsHintId}`}
        onChange={(e) => onEdit(e.target.value)}
        onBlur={params.settle}
      />
      <div id={paramsProblemsId} aria-live="polite">
        {params.problems.length > 0 ? (
          <div className="config-problems">
            <p className="config-problems__title">Not applied</p>
            <ul>
              {params.problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p id={paramsHintId} className="config-hint">
        One key=value per line, a query string, or an /embed URL. Keys: {PARAM_KEYS}.
      </p>
    </div>
  );
}
