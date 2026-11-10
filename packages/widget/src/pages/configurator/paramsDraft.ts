/**
 * The Developer section's editable `/embed` parameters (xochi-fi/xochi-widget#36).
 *
 * The text is one `key=value` per line. A pasted query string or a whole
 * `/embed` URL reads the same, as the frame would read it: from its query, with
 * any `#fragment` dropped and percent-encoding decoded. A draft applies only
 * when every entry is something the frame would honour. What it would drop, it
 * drops silently, so each problem is named here and the draft is held back.
 *
 * Every rule is the frame's own (trade/embedParams.ts): its parser decides what
 * is well-formed, its resolver decides what is honoured and says why not. This
 * module only splits the text and words the result.
 */

import {
  EMBED_PARAM_HINT,
  FRAME_FIELDS,
  type FrameField,
  embedOverrides,
  explainEmbedDefaults,
  type EmbedDefaults,
  type EmbedOffer,
} from "../trade/embedParams.js";
import {
  encodeEmbedParams,
  EMBED_PARAM,
  parseEmbedParams,
  type EmbedParams,
} from "@xochi/widget-lib";

type ParamField = FrameField;

/** The field each query key the frame resolves sets: EMBED_PARAM inverted. */
export const FIELD_BY_KEY: Readonly<Record<string, ParamField | undefined>> = Object.fromEntries(
  FRAME_FIELDS.map((field) => [EMBED_PARAM[field], field]),
);

/** The parameter names, for messages. */
export const PARAM_KEYS = FRAME_FIELDS.map((field) => EMBED_PARAM[field]).join(", ");

/** The parameters that open the frame on `config`, one per line. */
export function paramsText(config: EmbedDefaults): string {
  return Array.from(
    new URLSearchParams(encodeEmbedParams(embedOverrides(config))),
    ([key, value]) => `${key}=${value}`,
  ).join("\n");
}

/**
 * The `key=value` entries in a draft, decoded. A line that is a URL or path
 * contributes its query (none for a bare `/embed`); a fragment never counts.
 */
function draftEntries(text: string): [string, string][] {
  return text.split("\n").flatMap((raw) => {
    const line = raw.replace(/#.*$/, "").trim();
    const query = line.includes("?")
      ? line.slice(line.indexOf("?") + 1)
      : /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(line)
        ? ""
        : line;
    return Array.from(new URLSearchParams(query), ([key, value]): [string, string] => [
      key.trim(),
      value.trim(),
    ]);
  });
}

export interface ParamsDraft {
  /** The well-formed parameters in the draft. */
  params: EmbedParams;
  /** Why the draft cannot apply, one sentence each; empty when it can. */
  problems: string[];
}

/** Check a draft against the frame's parser, then against its resolver. */
export function readParamsDraft(text: string, offer: EmbedOffer): ParamsDraft {
  const problems: string[] = [];
  const accepted = new URLSearchParams();

  for (const [key, value] of draftEntries(text)) {
    // Own keys only: `constructor` or `__proto__` must read as unknown.
    const field = Object.prototype.hasOwnProperty.call(FIELD_BY_KEY, key)
      ? FIELD_BY_KEY[key]
      : undefined;
    if (field === undefined) {
      problems.push(`Unknown parameter "${key}". The widget reads ${PARAM_KEYS}.`);
    } else if (accepted.has(key)) {
      problems.push(`${key} is set twice. Keep one.`);
    } else if (value === "") {
      const { takes, example } = EMBED_PARAM_HINT[field];
      problems.push(`${key} needs a value: ${takes}, like ${example}.`);
    } else if (
      parseEmbedParams(new URLSearchParams([[key, value]]).toString())[field] === undefined
    ) {
      const { takes, example } = EMBED_PARAM_HINT[field];
      problems.push(`${key}=${value} is not valid. It takes ${takes}, like ${example}.`);
    } else {
      accepted.set(key, value);
    }
  }

  const params = parseEmbedParams(accepted.toString());
  const { ignored } = explainEmbedDefaults(params, offer);
  for (const field of FRAME_FIELDS) {
    const why = ignored[field];
    if (why === undefined) continue;
    const key = EMBED_PARAM[field];
    problems.push(`The widget would ignore ${key}=${accepted.get(key) ?? ""}: ${why}.`);
  }

  return { params, problems };
}
