/**
 * Whether the page framing this one is first party, decided from what the browser
 * reports about the parent, never from anything the parent says: no URL or embed
 * param and no message field is read.
 *
 * The evidence is `MessageEvent.origin` on messages whose `source` is
 * `window.parent`. The browser sets it to the sending document's origin, and it is
 * the value `@xochi/widget-lib`'s `connectToHost` pins as the host origin and names
 * as `targetOrigin` on every bridge message, wallet requests included: a pinned
 * origin is always one recorded here. Where the browser exposes
 * `location.ancestorOrigins` (Chromium, Safari; not Firefox), its parent entry must
 * agree. The host is first party only while every origin the parent has posted
 * from is on the build's list, and it has posted at least once.
 */

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// An ASCII (punycode) DNS name, as `scripts/write-headers.mjs` requires of a frame ancestor.
const DNS_HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The origin for `https://host[:port]` or `http://<loopback>[:port]`, else null. */
function toOrigin(token: string): string | null {
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return null;
  }
  if (url.href !== `${url.origin}/`) return null;
  if (url.protocol === "https:") return DNS_HOST.test(url.hostname) ? url.origin : null;
  return url.protocol === "http:" && LOOPBACK.includes(url.hostname) ? url.origin : null;
}

/**
 * The first-party host list from a space-separated build value. An entry that is
 * not an explicit origin is dropped (and logged), so it never widens the list.
 */
export function firstPartyOrigins(value: string): readonly string[] {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const origins = tokens.map(toOrigin);
  const bad = tokens.filter((_, i) => origins[i] === null);
  if (bad.length > 0) {
    console.error(`[hostOrigin] Not an explicit first-party origin, ignored: ${bad.join(" ")}`);
  }
  return [...new Set(origins.filter((origin): origin is string => origin !== null))];
}

export interface HostOriginWatch {
  /** Whether the framing page is first party, as the module header defines it. */
  firstParty(): boolean;
  /** Stop listening. */
  stop(): void;
}

/** The parent's origin as the browser reports it, or undefined where it does not (Firefox). */
function reportedParentOrigin(win: Window): string | undefined {
  if (!("ancestorOrigins" in win.location)) return undefined;
  const ancestors = win.location.ancestorOrigins;
  return ancestors.length > 0 ? ancestors[0] : undefined;
}

/**
 * Record the origin of every message `win.parent` posts to `win`. Start it before
 * the bridge on `win` so no message reaches the bridge unrecorded.
 */
export function watchHostOrigin(win: Window, allowed: readonly string[]): HostOriginWatch {
  const parent = win.parent;
  const seen = new Set<string>();
  const onMessage = (event: MessageEvent): void => {
    if (event.source === null || event.source !== parent) return;
    seen.add(event.origin);
  };
  win.addEventListener("message", onMessage);
  return {
    firstParty() {
      if (seen.size === 0) return false;
      const reported = reportedParentOrigin(win);
      return [...seen].every(
        (origin) => allowed.includes(origin) && (reported === undefined || origin === reported),
      );
    },
    stop() {
      win.removeEventListener("message", onMessage);
    },
  };
}
