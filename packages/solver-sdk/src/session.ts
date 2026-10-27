// SolverSession: registration and the session token every authenticated
// `/solver/*` request carries (SOLVER-RFC §3.1). `HttpSolverTransport` owns
// one; a custom transport can use it directly.
//
// The venue mints a token at `POST /solver/register` from a signed
// `SolverRegistration` and answers it with its expiry. This class holds the
// token, registers again shortly before it expires, and registers again when
// the venue answers 401 (`invalidate`): a rotated session secret, a bond that
// fell short, or an expiry this clock misjudged all look like that 401, and
// registering is what says which -- a bond that fell short comes back as
// `SolverRegistrationRefusedError` (`solver_bond_insufficient`).
//
// Refusals follow the venue's two sides (RFC §9.1). A 4xx is permanent for the
// registration as signed and is thrown as `SolverRegistrationRefusedError`,
// never retried: re-sending the same thing cannot clear it. A 503 (and a 429)
// is transient: retried with a freshly signed registration after the venue's
// `Retry-After`, up to `maxAttempts`, then thrown as
// `SolverRegistrationUnavailableError`.

import { ethers } from "ethers";

import { walletFromKey } from "./bid";
import { signRegistration, type SolverBondRef } from "./registration";
import { SolverRegistrationResponseSchema, VenueCapabilitiesSchema } from "./schema";
import type { SolverRegistrationResult } from "./types";

// The permanent refusal codes the venue answers at `POST /solver/register`
// (RFC §9.1). `string & {}` keeps the union open: a newer venue may add one,
// and an unknown 4xx is still permanent.
export type SolverRegistrationRefusalCode =
  | "solver_registration_not_enabled" // the venue admits no self-registered solver
  | "solver_bond_mismatch" // signed for another SolverBond than the venue's
  | "solver_registration_stale" // issuedAtMs outside the venue's window: this clock is off
  | "solver_bond_insufficient" // active stake below the venue's minimum
  | "bad_request" // malformed body or signature
  | "forbidden" // the signature does not recover to solverId
  | (string & {});

// A permanent refusal. Retrying the same registration cannot clear it; what
// clears it is in `code` (post more bond, fix the clock, sign for the venue's
// bond). `status` is undefined when the SDK decided before sending anything
// (the venue advertises no bond to sign for).
export class SolverRegistrationRefusedError extends Error {
  readonly name = "SolverRegistrationRefusedError";
  readonly permanent = true;
  constructor(
    readonly code: SolverRegistrationRefusalCode,
    readonly status: number | undefined,
    readonly detail: string,
  ) {
    super(`solver registration refused (${status ?? "not sent"} ${code}): ${detail}`);
  }
}

// The venue stayed transiently unavailable (503 or 429) for every attempt.
// `retryAfterMs` is its last `Retry-After`, when it sent one.
export class SolverRegistrationUnavailableError extends Error {
  readonly name = "SolverRegistrationUnavailableError";
  readonly permanent = false;
  constructor(
    readonly code: string,
    readonly status: number,
    readonly attempts: number,
    readonly retryAfterMs: number | undefined,
    readonly detail: string,
  ) {
    super(
      `solver registration unavailable after ${attempts} attempt(s) (${status} ${code}): ${detail}`,
    );
  }
}

export interface SolverSessionOptions {
  // Base URL of the venue's `/solver/*` surface.
  baseUrl: string;
  // The solver key (0x-prefixed). Signs registrations; its address is the
  // `solverId`.
  solverKey: string;
  // The SolverBond to sign for. Omitted, it is read from the venue's
  // `GET /solver/capabilities` (`admission.bond`) before each registration.
  // Pin it when you know which bond you posted: a pinned registration can
  // never be signed for a bond the venue chose, and a venue advertising
  // another one answers `solver_bond_mismatch`.
  bond?: SolverBondRef;
  // Injectable clock (ms). Signs `issuedAtMs` and decides when the token is
  // due for renewal. Defaults to `Date.now`.
  now?: () => number;
  // Upper bound on each registration or capabilities request (default 10_000).
  timeoutMs?: number;
  // Registration attempts across transient refusals (default 5).
  maxAttempts?: number;
  // Re-register this long before the token's `expiresAtMs` (default 60_000),
  // capped at half the token's lifetime as this session observed it.
  renewBeforeMs?: number;
}

// A `Retry-After` the venue sends is honoured up to this; a longer one is a
// venue asking for an outage-length wait inside one call.
const MAX_RETRY_AFTER_MS = 300_000;
// Without `Retry-After`: 1 s, 2 s, 4 s ... capped.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class SolverSession {
  readonly solverId: string;
  private readonly baseUrl: string;
  private readonly wallet: ethers.Wallet;
  private readonly bond?: SolverBondRef;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly renewBeforeMs: number;
  private current?: { result: SolverRegistrationResult; renewAtMs: number };
  private inFlight?: Promise<SolverRegistrationResult>;

  constructor(opts: SolverSessionOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.wallet = walletFromKey(opts.solverKey);
    this.solverId = this.wallet.address;
    this.bond = opts.bond;
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.renewBeforeMs = opts.renewBeforeMs ?? 60_000;
  }

  // The last registration this session holds, if any.
  get registration(): SolverRegistrationResult | undefined {
    return this.current?.result;
  }

  // A session token to send as `Authorization: Bearer`: the held one, or a
  // fresh registration when there is none or it is due for renewal.
  async token(signal?: AbortSignal): Promise<string> {
    const held = this.current;
    if (held && this.now() < held.renewAtMs) return held.result.sessionToken;
    return (await this.register(signal)).sessionToken;
  }

  // Forget `token` after the venue refused it (401), so the next `token()`
  // registers. A no-op when a newer token already replaced it, so concurrent
  // requests that all saw the old token register once, not once each.
  invalidate(token: string): void {
    if (this.current?.result.sessionToken === token) this.current = undefined;
  }

  // Register now. Concurrent callers share one registration, which runs under
  // the FIRST caller's signal.
  register(signal?: AbortSignal): Promise<SolverRegistrationResult> {
    this.inFlight ??= this.registerOnce(signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async registerOnce(signal?: AbortSignal): Promise<SolverRegistrationResult> {
    for (let attempt = 1; ; attempt++) {
      const bond = this.bond ?? (await this.advertisedBond(signal));
      // Re-signed every attempt: a Retry-After wait can outlast the venue's
      // freshness window, and a stale signature is a permanent refusal.
      const body = await signRegistration(this.wallet, {
        bondChainId: bond.chainId,
        bond: bond.address,
        issuedAtMs: this.now(),
      });
      const sentAtMs = this.now();
      const res = await fetch(`${this.baseUrl}/solver/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: this.bounded(signal),
      });

      if (res.ok) return this.accept(await res.json(), sentAtMs);

      const { code, detail } = await readError(res);
      if (res.status === 503 || res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
        if (attempt >= this.maxAttempts) {
          throw new SolverRegistrationUnavailableError(
            code,
            res.status,
            attempt,
            retryAfterMs,
            detail,
          );
        }
        await sleep(
          retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS),
          signal,
        );
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        throw new SolverRegistrationRefusedError(code, res.status, detail);
      }
      // Any other answer is neither a refusal nor a stated outage: report it
      // as the venue's fault, unclassified.
      throw new Error(`solver register ${res.status} ${code}: ${detail}`);
    }
  }

  private accept(raw: unknown, sentAtMs: number): SolverRegistrationResult {
    const parsed = SolverRegistrationResponseSchema.parse(raw);
    if (parsed.solverId.toLowerCase() !== this.solverId.toLowerCase()) {
      throw new Error(
        `solver register answered a session for ${parsed.solverId}, not ${this.solverId}`,
      );
    }
    const result: SolverRegistrationResult = {
      solverId: this.solverId,
      sessionToken: parsed.sessionToken,
      expiresAtMs: parsed.expiresAtMs,
      reputation: parsed.reputation,
    };
    const lifetime = Math.max(0, result.expiresAtMs - sentAtMs);
    this.current = {
      result,
      renewAtMs: result.expiresAtMs - Math.min(this.renewBeforeMs, lifetime / 2),
    };
    return result;
  }

  // `GET /solver/capabilities` is public: read before any credential exists.
  private async advertisedBond(signal?: AbortSignal): Promise<SolverBondRef> {
    const res = await fetch(`${this.baseUrl}/solver/capabilities`, {
      signal: this.bounded(signal),
    });
    if (!res.ok) throw new Error(`solver capabilities ${res.status}: ${await res.text()}`);
    const bond = VenueCapabilitiesSchema.parse(await res.json()).admission?.bond;
    if (!bond) {
      throw new SolverRegistrationRefusedError(
        "solver_registration_not_enabled",
        undefined,
        "the venue advertises no SolverBond (admission.bond on GET /solver/capabilities), " +
          "so it admits no self-registered solver",
      );
    }
    return { chainId: bond.chainId, address: bond.address };
  }

  private bounded(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
  }
}

// The venue's error envelope is `{ error, message, details? }`. Read
// defensively: a proxy in front of it may answer something else.
async function readError(res: Response): Promise<{ code: string; detail: string }> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    return {
      code: typeof body.error === "string" ? body.error : `http_${res.status}`,
      detail: typeof body.message === "string" ? body.message : text.slice(0, 200),
    };
  } catch {
    return { code: `http_${res.status}`, detail: text.slice(0, 200) };
  }
}

// RFC 9110 §10.2.3: delay-seconds or an HTTP-date. Undefined when absent or
// unreadable; clamped to [0, MAX_RETRY_AFTER_MS].
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  let ms: number;
  if (/^\d+$/.test(value)) ms = Number(value) * 1_000;
  else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
