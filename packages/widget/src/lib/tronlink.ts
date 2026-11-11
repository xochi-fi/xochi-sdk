/**
 * TronLink address picker.
 *
 * Tron is never a signing wallet in this app, in either direction:
 *   - A Tron DESTINATION settles to an address the user names. We need the
 *     string, nothing else.
 *   - A Tron ORIGIN is a deposit route. The connected wallet stays EVM and only
 *     the origin token and the refund address are base58 (see
 *     `TRON_ORIGIN_LIVE` in src/pages/trade/config.ts). A deposit route never
 *     reaches /execute, so there is nothing for TronLink to sign there either.
 *
 * So the entire job here is to save the user copying their own address out of
 * the extension. Nothing in this module signs, builds a transaction, or holds a
 * session. Treat any future call to do so as a design change, not an extension.
 *
 * The provider is injected on `window` by the extension, so there is no package
 * to depend on and no version to pin. That also means its shape is not ours and
 * cannot be trusted. `readTronAddress` therefore takes the provider as an
 * argument rather than reaching for a global, is total, and returns a value for
 * every outcome including a malformed one. A caller cannot mistake "the
 * extension told us nothing useful" for an address.
 */
import { TRON_ADDRESS_REGEX } from "@xochi/client";

/**
 * The slice of TronLink we use, declared structurally.
 *
 * Deliberately not the extension's full type: we call one method and read one
 * field, and a narrow local shape is what lets the tests build a real provider
 * instead of standing up a fake extension.
 */
export interface TronLinkProvider {
  request(args: { method: string }): Promise<unknown>;
  tronWeb?: { defaultAddress?: { base58?: unknown } };
}

/**
 * Every way this can end. Split by cause so the caller can say something true:
 * "install it", "you declined", "unlock it" and "that is not an address" want
 * different copy, and collapsing them would put the wrong instruction on screen.
 */
export type TronAddressOutcome =
  | { kind: "ok"; address: string }
  | { kind: "unavailable" }
  | { kind: "rejected" }
  | { kind: "locked" }
  | { kind: "malformed"; received: string }
  | { kind: "failed"; cause: string };

/** TronLink's documented response codes for `tron_requestAccounts`. */
const CODE_OK = 200;
const CODE_REJECTED = 4001;

/**
 * Cap on any externally-supplied string this module hands back. The malformed
 * and failed branches echo values the extension chose, and an unbounded echo is
 * how a log line or a rendered error becomes someone else's payload.
 */
const MAX_ECHO_CHARS = 80;

function clip(value: string): string {
  return value.length > MAX_ECHO_CHARS ? `${value.slice(0, MAX_ECHO_CHARS)}[clipped]` : value;
}

/**
 * `defaultAddress.base58` is `false`, not undefined, while the wallet is locked
 * or no account is selected. Reading it as a string would turn that into the
 * literal "false" and hand it to an address validator, so the falsy case is
 * separated from the wrong-type case here rather than at the call site.
 */
function readBase58(
  provider: TronLinkProvider,
): { present: false } | { present: true; raw: string } {
  const value = provider.tronWeb?.defaultAddress?.base58;
  if (value === undefined || value === null || value === false || value === "") {
    return { present: false };
  }
  if (typeof value === "string") return { present: true, raw: value };
  // Present but not a string. Label a number by its digits and anything else by
  // its type: `String({})` is "[object Object]", which tells a reader nothing and
  // is precisely the sort of value that must never reach an address field.
  if (typeof value === "number" || typeof value === "bigint") {
    return { present: true, raw: `${value}` };
  }
  return { present: true, raw: `<${typeof value}>` };
}

/** Pull the numeric `code` out of an unknown response body without asserting a shape. */
function responseCode(response: unknown): number | null {
  if (typeof response !== "object" || response === null) return null;
  const code = (response as Record<string, unknown>).code;
  return typeof code === "number" ? code : null;
}

/**
 * Ask TronLink for the user's address.
 *
 * Total by construction: it never throws and never returns undefined, so a
 * caller cannot fall through to a success path on a failure it forgot to check.
 * Pass `undefined` for a browser with no extension.
 */
export async function readTronAddress(
  provider: TronLinkProvider | undefined,
): Promise<TronAddressOutcome> {
  if (!provider) return { kind: "unavailable" };

  let response: unknown;
  try {
    response = await provider.request({ method: "tron_requestAccounts" });
  } catch (err) {
    // The extension rejects by throwing in some versions and by returning a
    // code in others, so the throw is classified the same way rather than being
    // reported as an unexplained failure.
    const message = err instanceof Error ? err.message : String(err);
    if (/reject|denied|declin/i.test(message)) return { kind: "rejected" };
    return { kind: "failed", cause: clip(message) };
  }

  const code = responseCode(response);
  if (code === CODE_REJECTED) return { kind: "rejected" };
  // A null code means an older build that resolves with no envelope. Fall
  // through to the address read, which is the real check either way; only a
  // recognised NON-ok code is treated as a refusal.
  if (code !== null && code !== CODE_OK) {
    return { kind: "failed", cause: `TronLink returned code ${code}` };
  }

  const base58 = readBase58(provider);
  if (!base58.present) return { kind: "locked" };
  if (!TRON_ADDRESS_REGEX.test(base58.raw)) {
    return { kind: "malformed", received: clip(base58.raw) };
  }

  return { kind: "ok", address: base58.raw };
}

/**
 * The injected provider, or undefined when TronLink is not installed.
 *
 * The only part of this module that touches a global, kept to one line so the
 * decision logic above stays testable without patching `window`.
 */
export function getTronLinkProvider(): TronLinkProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const injected = (window as { tronLink?: unknown }).tronLink;
  if (typeof injected !== "object" || injected === null) return undefined;
  const candidate = injected as { request?: unknown };
  return typeof candidate.request === "function" ? (injected as TronLinkProvider) : undefined;
}

/**
 * Plain-language copy for each non-success outcome.
 *
 * Lives beside the outcomes so a new kind cannot be added without a message:
 * the switch is exhaustive and the build fails if one is missed.
 */
export function describeTronOutcome(outcome: Exclude<TronAddressOutcome, { kind: "ok" }>): string {
  switch (outcome.kind) {
    case "unavailable":
      return "TronLink is not installed in this browser.";
    case "rejected":
      return "TronLink was not allowed to share the address.";
    case "locked":
      return "Unlock TronLink and pick an account, then try again.";
    case "malformed":
      return "TronLink gave back something that is not a Tron address.";
    case "failed":
      return "Could not reach TronLink. Try again.";
  }
}
