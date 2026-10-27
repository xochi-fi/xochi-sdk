// Startup checks shared by examples/offline-solver.ts and
// examples/escrow-solver.ts: required variables, the venue URL, the key shape
// and numeric knobs, every one refused before the first request, plus the log
// sanitizer for strings a venue or an operator controls. Nothing here is
// repo-local.

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required ${hint}`);
  return value;
}

// Every string on an announcement is VENUE-CONTROLLED and lands in a maker's
// terminal, its log pipeline and its support tickets. An `intentId` carrying an
// ANSI escape rewrites the line above it; one carrying a newline forges a whole
// line; one carrying 10KB of padding buries the round. So: replace every
// Unicode control/format codepoint, cap the length, and quote, so a
// substitution or a truncation is visible rather than pretty.
// A venue-supplied ID is short by nature (a UUID is 36 chars), so 64 is
// generous. An ERROR MESSAGE is the one venue-supplied string worth reading in
// full, so it gets its own cap: truncating a 409 or a 422 at 64 chars throws
// away the diagnosis this is printed for.
export const MAX_LOGGED_CHARS = 64;
export const MAX_LOGGED_ERROR_CHARS = 240;
export const tame = (value: string, max = MAX_LOGGED_CHARS): string => {
  const clean = value.replace(/\p{C}/gu, "\uFFFD");
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max)}...` : clean);
};

export const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

// A private key never reaches a message, a log line or an error (ethers' own
// error quotes the value). This output goes to a terminal, a CI log and a
// support ticket, so a caller gets the VARIABLE NAME and the reason, never the
// value.
export function assertKeyShape(name: string, key: string): void {
  if (!KEY_SHAPE.test(key)) {
    throw new Error(
      `${name} must be a 0x-prefixed 32-byte private key (0x + 64 hex digits); value not shown`,
    );
  }
}

// A numeric knob: unset takes the default; set, it must be a non-negative
// integer. An empty value is unset, as `requireEnv` treats it; `Number("")`
// would read it as 0 and `Number("x")` as NaN.
export function envInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  }
  return BigInt(raw.trim());
}

// The session token goes to this URL on every feed poll and every bid POST, the
// signed registration that mints it on every renewal, and whatever answers
// chooses the announcements this solver signs firm offers against -- offers
// that are NOT bound to the venue that served them, because the EIP-712 domain
// carries no deployment binding (axol-io/Riddler#1034). So an unauthenticated
// origin is not a downgrade, it is a credential in cleartext plus a bid-signing
// oracle. https only, the same rule
// `scripts/probe-lib.mjs` applies to `RIDDLER_URL_<NAME>`.
//
// The loopback exemption exists for a local venue -- testing the version gate
// against one is a documented workflow -- and for nothing else: no private-range
// hosts, no plain http to a name that resolves off-box.
export function assertVenueUrl(raw: string, warn: (msg: string) => void): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`RIDDLER_SOLVER_URL is not a URL: ${tame(raw)}`);
  }
  if (url.protocol === "https:") return;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) {
    warn(
      `WARNING ${tame(url.origin)} is plain http, allowed only because it is loopback: the session token is sent unencrypted`,
    );
    return;
  }
  throw new Error(
    `RIDDLER_SOLVER_URL must be https (loopback http is the only exemption); got ${tame(raw)}`,
  );
}
