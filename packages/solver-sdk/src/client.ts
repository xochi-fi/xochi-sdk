// SolverClient: drives the discovery -> bid -> award -> fill loop, sealing and
// signing on the solver's behalf. The solver only implements `capabilities` /
// `quote` / `fill` (see types.ts).
//
// At P0 the venue's own reserve always wins, and awards are addressed to their
// winner, so a third-party solver receives announcements and submits bids but is
// never awarded -- `solver.fill` does not run. That is the escrow gate (RFC
// section 9), not a transport limitation.

import { ethers } from "ethers";
import { ZodError } from "zod";
import type {
  Solver,
  SolverTransport,
  SolverEvent,
  Bid,
  FillAttestationWire,
  FillAcceptanceReceipt,
  FillReceipt,
  FeedGap,
  SolverRegistrationResult,
  VenueCapabilities,
} from "./types";
import { signBid, solverIdFromKey, walletFromKey } from "./bid";
import type { SolverBondRef } from "./registration";
import {
  parseSolverEvent,
  UnknownSolverEventError,
  FeedBatchSchema,
  FillAcceptanceReceiptSchema,
  FillAttestationWireSchema,
  VenueCapabilitiesSchema,
} from "./schema";
import { SolverSession } from "./session";

// The RFC revision this SDK implements, and the ONE place it is a value rather
// than prose. `SolverClient.run` compares the venue's advertised `rfcVersion`
// against it before anything is signed (RFC §12: "a solver MUST refuse to bid
// against an `rfcVersion` it does not implement"), and the docs, the example
// and any operator tooling read it from here instead of retyping the literal.
//
// The comparison is EXACT string equality. Not a prefix, not a semver range,
// not a lexicographic ordering: `0.3.0-draft` is a different announcement
// contract from `0.3.0` and from `0.3.0-draft2`, and the sealing scheme's
// domain does NOT vary with this string, so a skew produces valid signatures
// over an announcement the two sides read differently -- there is nothing
// cryptographic to catch it. This check is the only protection.
export const SOLVER_RFC_VERSION = "0.6.0-draft";

// Thrown by `SolverClient.run` when the venue answered and advertised an
// `rfcVersion` other than `SOLVER_RFC_VERSION`. Typed so a supervisor can stop
// for good on a skew (retrying cannot fix a lockstep-deploy mismatch) while
// still retrying an unreachable or unreadable venue, which `run` reports as a
// plain `Error`.
export class VenueVersionSkewError extends Error {
  readonly name = "VenueVersionSkewError";
  constructor(
    readonly advertised: string,
    readonly implemented: string = SOLVER_RFC_VERSION,
  ) {
    super(
      `SolverClient: refusing to run -- version skew: the venue serves RFC ${advertised}, ` +
        `this SDK implements ${implemented} (exact match required; RFC §12)`,
    );
  }
}

export interface SolverClientOptions {
  // Base URL of the venue's `/solver/*` surface. Required for the default
  // transport; ignored if a `transport` is injected.
  baseUrl?: string;
  // The solver key (0x-prefixed). Signs bids and the registration that admits
  // it (RFC §3.1); its address is the `solverId`.
  solverKey: string;
  // The SolverBond to register against. Omitted, the default transport reads
  // the venue's advertised `admission.bond` (see `SolverSessionOptions.bond`).
  // Applies to the default transport only.
  bond?: SolverBondRef;
  // Injectable transport seam. Defaults to `HttpSolverTransport` over `baseUrl`.
  transport?: SolverTransport;
  // Injectable clock (ms). Defaults to `Date.now`. A bid whose announcement has
  // already closed is skipped (the auctioneer rejects late bids anyway; this
  // avoids the round trip). Overridable so tests are deterministic.
  now?: () => number;
  // Per-event error hook. When provided, an error thrown by `quote`/`fill` (or a
  // submit) is reported here and the loop continues -- a solver daemon should
  // not die on one bad intent. When omitted, the error propagates out of `run`
  // (fail loud). Errors are never silently swallowed either way.
  onError?: (err: unknown, event: SolverEvent) => void;
  // Called when the feed reports it skipped announcements (`dropped`/`reset`).
  // Only meaningful for the default transport, which owns the feed; supplying it
  // alongside an injected `transport` is a constructor error rather than a
  // silent no-op. A production solver should act on this -- the intents behind a
  // gap are simply never delivered.
  onFeedGap?: (gap: FeedGap) => void;
  // Called for each feed entry the default transport skips; the contract
  // (which entries, and what a handler that throws does) is on
  // `HttpSolverTransportOptions.onInvalidEvent`. Like `onFeedGap`, it belongs
  // to the default transport.
  onInvalidEvent?: (err: unknown, raw: unknown) => void;
}

// Did the capability read fail because the venue's BODY is unreadable, rather
// than because the request never completed? `HttpSolverTransport` validates
// with zod, so a served body that does not satisfy RFC §12 arrives here as a
// `ZodError` through the same `catch` as a DNS failure or a connection refusal.
//
// The structural fallback is not defensive decoration: zod is a peer of this
// package, so a host that resolves two copies of it (a hoisting split, a linked
// workspace) makes `instanceof` false for an error a `ZodError` in every other
// respect, and the fallback keeps the operator-facing sentence right instead of
// silently reverting to "check your routing".
function isValidationFailure(err: unknown): boolean {
  if (err instanceof ZodError) return true;
  if (typeof err !== "object" || err === null) return false;
  if (!("name" in err) || !("issues" in err)) return false;
  return err.name === "ZodError" && Array.isArray(err.issues);
}

export class SolverClient {
  readonly solverId: string;
  private readonly wallet: ethers.Wallet;
  private readonly transport: SolverTransport;
  private readonly now: () => number;
  private readonly onError?: (err: unknown, event: SolverEvent) => void;

  constructor(opts: SolverClientOptions) {
    this.wallet = walletFromKey(opts.solverKey);
    this.solverId = this.wallet.address;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
    if (opts.transport) {
      // Fail at construction rather than dropping the handler on the floor: an
      // injected transport owns its own feed, so these could never fire, and a
      // silently-never-called gap handler reads as "no gaps ever happened".
      const orphaned = [
        opts.onFeedGap ? "onFeedGap" : null,
        opts.onInvalidEvent ? "onInvalidEvent" : null,
        opts.bond ? "bond" : null,
      ].filter(Boolean);
      if (orphaned.length > 0) {
        throw new Error(
          `SolverClient: ${orphaned.join("/")} only applies to the default transport; ` +
            "an injected transport owns its own feed and registration",
        );
      }
      this.transport = opts.transport;
    } else {
      if (!opts.baseUrl)
        throw new Error("SolverClient: baseUrl is required when no transport is injected");
      this.transport = new HttpSolverTransport({
        baseUrl: opts.baseUrl,
        solverKey: opts.solverKey,
        bond: opts.bond,
        onFeedGap: opts.onFeedGap,
        onInvalidEvent: opts.onInvalidEvent,
      });
    }
  }

  // The venue's advertised RFC version and permissioning phase (RFC §12). A
  // solver SHOULD gate on both before running: a venue serving a different
  // `rfcVersion` may reject or misread its bids, and a phase that has not
  // admitted it means every announcement it sees is unwinnable.
  async getCapabilities(signal?: AbortSignal): Promise<VenueCapabilities> {
    if (!this.transport.getCapabilities) {
      throw new Error("SolverClient: the injected transport does not implement getCapabilities()");
    }
    return this.transport.getCapabilities(signal);
  }

  // Register now (RFC §3.1) and answer the venue's view of this solver: its
  // probation, bond and exposure cap. `run` registers on its own; this is for
  // printing that standing, or failing fast on a permanent refusal
  // (`SolverRegistrationRefusedError`), before the loop starts.
  async register(signal?: AbortSignal): Promise<SolverRegistrationResult> {
    if (!this.transport.register) {
      throw new Error("SolverClient: the injected transport does not implement register()");
    }
    return this.transport.register(signal);
  }

  // Run the loop until the stream ends or `signal` aborts. For each announcement,
  // call `solver.quote` within the window and submit a sealed bid; for each award
  // addressed to this solver, call `solver.fill` and submit the receipt.
  //
  // Refuses up front unless the venue advertises exactly `SOLVER_RFC_VERSION`
  // (RFC §12). The check is here, before the first event is read, because the
  // MUST it enforces is "refuse to BID": once an announcement has been quoted
  // and sealed, a signature over a struct the two sides read differently is
  // already published.
  //
  // The venue can be redeployed under a running solver, so the gate is re-run
  // at three points, never per announcement as such: after a feed `reset` (the
  // cursor named a sequence the log never issued -- what a venue restart looks
  // like) and after a skipped entry of an unknown `type` (what a venue on a
  // newer RFC emits), both before the next event is acted on; and before each
  // award addressed to this solver reaches `solver.fill`, where the acceptance
  // is signed. A skew or an unanswered re-check ends `run` with nothing
  // signed, whatever `onError` is: the error is about the venue, not the event.
  async run(solver: Solver, signal?: AbortSignal): Promise<void> {
    // A `reset` or an unknown-type skip re-arms the version gate, whoever built
    // the transport: an injected one keeps its own `onFeedGap`, and these
    // listeners ride alongside it. Subscribed for this run only, so clients
    // rebuilt over one transport do not accumulate listeners. A custom
    // transport without the listener methods cannot report either, so its feed
    // is re-gated only on own awards.
    let versionRecheckPending = false;
    const unsubscribeGap = this.transport.addFeedGapListener?.((gap) => {
      if (gap.reset) versionRecheckPending = true;
    });
    const unsubscribeUnknown = this.transport.addUnknownEventListener?.(() => {
      versionRecheckPending = true;
    });
    try {
      await this.assertVenueRfcVersion(signal);
      versionRecheckPending = false;
      for await (const event of this.transport.events(signal)) {
        const ownAward = event.type === "award" && this.isForThisSolver(event.award.solverId);
        if (versionRecheckPending || ownAward) {
          await this.assertVenueRfcVersion(signal);
          versionRecheckPending = false;
        }
        try {
          if (event.type === "announcement") {
            await this.handleAnnouncement(solver, event);
          } else if (ownAward) {
            const receipt = await solver.fill(event.award);
            await this.transport.submitFill(receipt);
          }
        } catch (err) {
          if (this.onError) this.onError(err, event);
          else throw err;
        }
      }
    } finally {
      unsubscribeGap?.();
      unsubscribeUnknown?.();
    }
  }

  // Three outcomes, three sentences, deliberately not sharing one: an operator
  // reading this at 3am has to know whether the venue disagrees with this SDK,
  // answered something this SDK cannot read, or never answered at all. The
  // first is a lockstep-deploy problem, the second is the venue's contract, the
  // third is reachability/routing, and they are fixed by different people.
  // `VenueCapabilitiesSchema` requires only `rfcVersion` (`phase` is a RFC §12
  // SHOULD): a conformant `200 {"rfcVersion":...}` must not fail validation
  // and be reported as "the venue never answered".
  private async assertVenueRfcVersion(signal?: AbortSignal): Promise<void> {
    const silent = (why: string): Error =>
      new Error(
        `SolverClient: refusing to run -- the venue did not tell me its RFC version: ${why}`,
      );

    if (!this.transport.getCapabilities) {
      throw silent(
        "this transport does not implement getCapabilities(), so nothing can show it speaks " +
          `${SOLVER_RFC_VERSION} (RFC §12)`,
      );
    }
    let capabilities: VenueCapabilities;
    try {
      capabilities = await this.transport.getCapabilities(signal);
    } catch (err) {
      // Two different faults arrive here, and the remedies have no overlap (see
      // `isValidationFailure`).
      const why = err instanceof Error ? err.message : String(err);
      throw silent(
        isValidationFailure(err)
          ? `GET /solver/capabilities answered a body this SDK cannot read (${why}). ` +
              "The venue DID answer, so this is not a reachability problem -- the body does not " +
              "satisfy the RFC §12 capability shape, and the venue has to correct it"
          : `GET /solver/capabilities failed (${why}). ` +
              "The venue never answered, so this is not a disagreement about the version -- " +
              "check reachability, routing and the base URL",
      );
    }
    const advertised = capabilities?.rfcVersion;
    if (typeof advertised !== "string" || advertised.length === 0) {
      throw silent(`it advertised no usable rfcVersion (got ${JSON.stringify(advertised)})`);
    }
    if (advertised !== SOLVER_RFC_VERSION) throw new VenueVersionSkewError(advertised);
  }

  private async handleAnnouncement(
    solver: Solver,
    event: Extract<SolverEvent, { type: "announcement" }>,
  ): Promise<void> {
    const { announcement } = event;
    if (this.now() >= announcement.closesAt) return; // window already closed
    const draft = await solver.quote(announcement);
    if (draft === null) return; // solver passed
    const bid: Bid = await signBid(this.wallet, announcement, draft);
    await this.transport.submitBid(bid);
  }

  private isForThisSolver(solverId: string): boolean {
    return solverId.toLowerCase() === this.solverId.toLowerCase();
  }
}

export interface HttpSolverTransportOptions {
  baseUrl: string;
  // The solver key (0x-prefixed). Signs the `SolverRegistration` that admits
  // this transport (RFC §3.1); its address is the `solverId`. Every request
  // but `getCapabilities` carries the resulting session token as
  // `Authorization: Bearer`.
  solverKey: string;
  // The SolverBond to register against; see `SolverSessionOptions.bond`.
  bond?: SolverBondRef;
  // Upper bound on each registration request (default 10_000 ms).
  registerTimeoutMs?: number;
  // Registration attempts across transient (503/429) refusals (default 5).
  maxRegisterAttempts?: number;
  // Resumable feed cursor to start from (RFC section 4.1). Defaults to "0".
  since?: string;
  // Called when a batch reports `dropped` or `reset` -- i.e. this reader missed
  // announcements. Omitted, the gap is not acted on; the batch is parsed, not
  // destructured, so the fields are never silently lost.
  onFeedGap?: (gap: FeedGap) => void;
  // Called for each feed ENTRY skipped instead of yielded. Two kinds arrive,
  // told apart by class:
  // - `UnknownSolverEventError`: the entry's `type` is a string this SDK does
  //   not know (a kind a newer venue added). Skipped with or without this
  //   handler (without it: one `console.warn` per distinct type for the first
  //   32, then one line saying further types go unreported), and it re-arms
  //   `SolverClient.run`'s version gate before the next event is acted on.
  // - anything else (a `ZodError`): a malformed entry, including a `type` that
  //   folds to a known kind or one carrying a known kind's payload key (see
  //   `UnknownSolverEventError`). Skipped only when this handler is set;
  //   without it, thrown, which ends `SolverClient.run`.
  //
  // A handler that throws ends the run exactly like having no handler: the
  // throw leaves `events()` before the batch's cursor is taken, so a restart
  // reads the same batch and ends again. It is not caught, because a throw is
  // how a handler chooses to stop; report and return to skip.
  //
  // This is deliberately per-ENTRY. A malformed batch envelope is NOT routed
  // here and always throws: without a trustworthy `cursor` there is no safe way
  // to continue -- resuming from the old one replays, and inventing one skips.
  onInvalidEvent?: (err: unknown, raw: unknown) => void;
  // Upper bound on `acceptAward` (default 10_000 ms), on top of any caller
  // signal. An acceptance is owed from the moment it is sent, so a venue that
  // never answers must not hold the solver past the point it has to fill.
  acceptTimeoutMs?: number;
  // Upper bound on `getCapabilities` and `getAttestation` (default 10_000 ms),
  // on top of any caller signal. `SolverClient.run` re-reads capabilities
  // before acting on its own award, so a venue that never answers must not
  // freeze the loop.
  readTimeoutMs?: number;
  // Upper bound on `submitBid` and `submitFill` (default 10_000 ms). Both run
  // inside `SolverClient.run`'s loop, so a venue that never answers a POST must
  // not stall every announcement behind it.
  postTimeoutMs?: number;
}

// Distinct unknown feed event types `HttpSolverTransport` warns about without
// an `onInvalidEvent` (see that option) before it says further ones go unreported.
const MAX_WARNED_UNKNOWN_TYPES = 32;

// Transport over the `/solver/*` HTTP surface: a resumable long-poll feed
// (`GET /solver/intents/stream?since=`) + POST bid/fill.
//
// The feed parks server-side when nothing is new, which is what keeps this
// delay-free loop from spinning. The batch also carries `dropped` (entries that
// fell off the retention ring -- this reader is too slow) and `reset` (the
// cursor named a sequence the log never issued, so an unknown number of
// announcements were missed). Both are reported via `onFeedGap`.
export class HttpSolverTransport implements SolverTransport {
  // Registration and the session token (session.ts). Exposed so a caller can
  // read the last registration's reputation.
  readonly session: SolverSession;
  private readonly baseUrl: string;
  private readonly onFeedGap?: (gap: FeedGap) => void;
  private readonly onInvalidEvent?: (err: unknown, raw: unknown) => void;
  private readonly acceptTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly postTimeoutMs: number;
  private readonly feedGapListeners = new Set<(gap: FeedGap) => void>();
  private readonly unknownEventListeners = new Set<(eventType: string) => void>();
  private cursor: string;
  // Unknown types already warned about (no handler), as the message shows them.
  private readonly warnedUnknownTypes = new Set<string>();
  private unknownTypeWarningsCapped = false;

  constructor(opts: HttpSolverTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.session = new SolverSession({
      baseUrl: this.baseUrl,
      solverKey: opts.solverKey,
      bond: opts.bond,
      timeoutMs: opts.registerTimeoutMs,
      maxAttempts: opts.maxRegisterAttempts,
    });
    this.cursor = opts.since ?? "0";
    this.onFeedGap = opts.onFeedGap;
    this.onInvalidEvent = opts.onInvalidEvent;
    this.acceptTimeoutMs = opts.acceptTimeoutMs ?? 10_000;
    this.readTimeoutMs = opts.readTimeoutMs ?? 10_000;
    this.postTimeoutMs = opts.postTimeoutMs ?? 10_000;
  }

  register(signal?: AbortSignal): Promise<SolverRegistrationResult> {
    return this.session.register(signal);
  }

  async *events(signal?: AbortSignal): AsyncIterable<SolverEvent> {
    while (!signal?.aborted) {
      const requestedCursor = this.cursor;
      const res = await this.authed(
        `/solver/intents/stream?since=${encodeURIComponent(requestedCursor)}`,
        {},
        undefined,
        signal,
      );
      if (!res.ok) throw new Error(`solver feed ${res.status}: ${await res.text()}`);
      // Envelope failures always throw -- see `onInvalidEvent` on the options.
      const batch = FeedBatchSchema.parse(await res.json());
      // Gate on MEANING, not presence: Riddler's `Feed.batch/4` emits both keys
      // on every batch (`dropped: 0, reset: false` when nothing was missed), so
      // a presence check would fire on every poll and make the signal useless.
      // Treated as optional anyway -- a server that omits them is not a gap.
      const dropped = batch.dropped ?? 0;
      const reset = batch.reset ?? false;
      // Report the gap BEFORE yielding this batch, so a handler learns it is
      // missing intents ahead of acting on the ones that did arrive.
      if (dropped > 0 || reset) {
        const gap: FeedGap = { dropped, reset, requestedCursor, cursor: batch.cursor };
        this.onFeedGap?.(gap);
        for (const listener of this.feedGapListeners) listener(gap);
      }
      for (const raw of batch.events) {
        let event: SolverEvent;
        try {
          event = parseSolverEvent(raw);
        } catch (err) {
          if (err instanceof UnknownSolverEventError) {
            this.skipUnknownType(err, raw);
            continue;
          }
          // One malformed entry must not take down a solver daemon. Reported and
          // skipped when a handler exists, rethrown when one does not -- never
          // swallowed. The throw escapes `SolverClient.run`'s per-event try,
          // which is why it cannot be left to `onError`.
          if (!this.onInvalidEvent) throw err;
          this.onInvalidEvent(err, raw);
          continue;
        }
        yield event;
      }
      this.cursor = batch.cursor;
    }
  }

  // Listeners first, so the version gate is re-armed even if the handler
  // throws. Without a handler, one warning per distinct type, capped: the type
  // is venue-chosen, so remembering every one would be unbounded.
  private skipUnknownType(err: UnknownSolverEventError, raw: unknown): void {
    for (const listener of this.unknownEventListeners) listener(err.eventType);
    if (this.onInvalidEvent) return this.onInvalidEvent(err, raw);
    const key = err.eventType.slice(0, 64);
    if (this.warnedUnknownTypes.has(key)) return;
    if (this.warnedUnknownTypes.size >= MAX_WARNED_UNKNOWN_TYPES) {
      if (this.unknownTypeWarningsCapped) return;
      this.unknownTypeWarningsCapped = true;
      console.warn(
        `HttpSolverTransport: ${MAX_WARNED_UNKNOWN_TYPES} unknown feed event types reported; ` +
          "further unknown types are skipped without a warning (set onInvalidEvent to see each)",
      );
      return;
    }
    this.warnedUnknownTypes.add(key);
    console.warn(
      `HttpSolverTransport: skipping a feed entry: ${err.message}; later entries of this type ` +
        "are skipped without a warning (set onInvalidEvent to see each)",
    );
  }

  // `GET /solver/capabilities` is public and unauthenticated (RFC §12), so this
  // deliberately sends no credentials -- it must work before registration.
  async getCapabilities(signal?: AbortSignal): Promise<VenueCapabilities> {
    const res = await fetch(`${this.baseUrl}/solver/capabilities`, {
      signal: this.bounded(this.readTimeoutMs, signal),
    });
    if (!res.ok) throw new Error(`solver capabilities ${res.status}: ${await res.text()}`);
    return VenueCapabilitiesSchema.parse(await res.json());
  }

  async submitBid(bid: Bid): Promise<void> {
    await this.post("/solver/bids", bid);
  }

  // `GET /solver/attestations/:orderId` (authenticated like the rest of the
  // panel surface). 404 means "no attestation for you yet" -- not yet attested
  // and not this solver's are deliberately indistinguishable -- so it is null,
  // never an error; any other non-2xx throws.
  async getAttestation(orderId: string, signal?: AbortSignal): Promise<FillAttestationWire | null> {
    const res = await this.authed(
      `/solver/attestations/${encodeURIComponent(orderId)}`,
      {},
      this.readTimeoutMs,
      signal,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`solver attestation ${res.status}: ${await res.text()}`);
    return FillAttestationWireSchema.parse(await res.json());
  }

  // `POST /solver/awards/:auctionId/accept` (SOLVER-RFC §5.3). Idempotent on
  // the server, so a retry after an ambiguous failure is safe -- unlike a fill.
  // Bounded by `acceptTimeoutMs` whatever the caller passes.
  async acceptAward(
    auctionId: string,
    body: { orderId: string; signature: string },
    signal?: AbortSignal,
  ): Promise<FillAcceptanceReceipt> {
    const res = await this.authed(
      `/solver/awards/${encodeURIComponent(auctionId)}/accept`,
      { method: "POST", body: JSON.stringify(body) },
      this.acceptTimeoutMs,
      signal,
    );
    if (!res.ok) throw new Error(`solver accept ${res.status}: ${await res.text()}`);
    return FillAcceptanceReceiptSchema.parse(await res.json());
  }

  async submitFill(receipt: FillReceipt): Promise<void> {
    await this.post("/solver/fills", receipt);
  }

  // Every gap this transport reports to `onFeedGap` is also passed to each
  // listener. Returns the unsubscribe.
  addFeedGapListener(listener: (gap: FeedGap) => void): () => void {
    this.feedGapListeners.add(listener);
    return () => this.feedGapListeners.delete(listener);
  }

  // Each entry skipped as `UnknownSolverEventError` is passed to every
  // listener, before `onInvalidEvent`. Returns the unsubscribe.
  addUnknownEventListener(listener: (eventType: string) => void): () => void {
    this.unknownEventListeners.add(listener);
    return () => this.unknownEventListeners.delete(listener);
  }

  private bounded(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  }

  // An authenticated request (RFC §3.1): the session token as
  // `Authorization: Bearer`, registering first when there is none or it is due
  // for renewal. A 401 means the session no longer holds -- it expired, the
  // venue rotated its secret, or the bond fell short -- so the token is
  // dropped, the solver registers again and the request is sent once more.
  // Re-sending is safe: the venue refuses a 401 before it reads the body. A
  // registration refusal is thrown from here as its typed error; a second 401
  // is returned, and the caller reports it like any other status.
  private async authed(
    path: string,
    init: { method?: string; body?: string },
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    const send = (token: string) =>
      fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: timeoutMs === undefined ? signal : this.bounded(timeoutMs, signal),
      });
    const token = await this.session.token(signal);
    const res = await send(token);
    if (res.status !== 401) return res;
    await res.body?.cancel();
    this.session.invalidate(token);
    return send(await this.session.token(signal));
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.authed(
      path,
      { method: "POST", body: JSON.stringify(body) },
      this.postTimeoutMs,
    );
    if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }
}
