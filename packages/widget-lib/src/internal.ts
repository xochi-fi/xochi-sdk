/** Helpers both ends of the bridge share. Not exported from the package. */

import { MAX_MESSAGE_LENGTH } from "./protocol.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The message as plain JSON, or null when it cannot be one or its JSON text is
 * longer than `MAX_MESSAGE_LENGTH`. Re-parsing strips whatever structured clone
 * carried that JSON cannot (prototypes, Maps, Dates, typed arrays), so nothing
 * downstream, the host wallet included, sees more than JSON.
 */
export function asJson(data: unknown): unknown | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(data);
  } catch {
    return null;
  }
  if (text === undefined || text.length > MAX_MESSAGE_LENGTH) return null;
  return JSON.parse(text) as unknown;
}

/**
 * `origin` as `URL.origin` spells it. https only, except http on a loopback
 * host for local development. Throws a TypeError naming `what` for anything
 * that is not an origin (a path, query, fragment or credentials).
 */
export function normalizeOrigin(origin: string, what: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError(`${what} is not a URL: ${JSON.stringify(origin)}`);
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  if (!secure) {
    throw new TypeError(
      `${what} must be https (http only on localhost): ${JSON.stringify(origin)}`,
    );
  }
  if (url.href !== `${url.origin}/`) {
    throw new TypeError(
      `${what} must be an origin only, like "${url.origin}": ${JSON.stringify(origin)}`,
    );
  }
  return url.origin;
}
