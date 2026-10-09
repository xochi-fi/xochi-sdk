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
  VenueCapabilities,
} from "./types";
import { signBid, solverIdFromKey } from "./bid";
import {
  parseSolverEvent,
  FeedBatchSchema,
  FillAcceptanceReceiptSchema,
  FillAttestationWireSchema,
  VenueCapabilitiesSchema,
} from "./schema";

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
export const SOLVER_RFC_VERSION = "0.5.0-draft";

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
  // The solver key (0x-prefixed). Signs bids; its address is the `solverId`.
  solverKey: string;
  // Panel secret. Sent as `X-API-Key` alongside `X-Solver-Id`; the venue binds
  // one secret to one solverId and both must agree, so a valid secret paired
  // with another member's id is a 401 (RFC section 8).
  apiKey?: string;
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
  // Called when a feed entry fails validation. Supplying it SKIPS the offending
  // entry and continues; omitting it rethrows and ends the loop. Same contract
  // as `onError`: the error is reported or raised, never swallowed. Like
  // `onFeedGap`, it belongs to the default transport.
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
    this.wallet = new ethers.Wallet(opts.solverKey);
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
      ].filter(Boolean);
      if (orphaned.length > 0) {
        throw new Error(
          `SolverClient: ${orphaned.join("/")} only applies to the default transport; ` +
            "an injected transport owns its own feed and must report these itself",
        );
      }
      this.transport = opts.transport;
    } else {
      if (!opts.baseUrl) throw new Error("SolverClient: baseUrl is required when no transport is injected");
      this.transport = new HttpSolverTransport({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        solverId: this.solverId,
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

  // Run the loop until the stream ends or `signal` aborts. For each announcement,
  // call `solver.quote` within the window and submit a sealed bid; for each award
  // addressed to this solver, call `solver.fill` and submit the receipt.
  //
  // Refuses up front unless the venue advertises exactly `SOLVER_RFC_VERSION`
  // (RFC §12). The check is here, before the first event is read, because the
  // MUST it enforces is "refuse to BID": once an announcement has been quoted
  // and sealed, a signature over a struct the two sides read differently is
  // already published.
  async run(solver: Solver, signal?: AbortSignal): Promise<void> {
    await this.assertVenueRfcVersion(signal);
    for await (const event of this.transport.events(signal)) {
      try {
        if (event.type === "announcement") {
          await this.handleAnnouncement(solver, event);
        } else if (this.isForThisSolver(event.award.solverId)) {
          const receipt = await solver.fill(event.award);
          await this.transport.submitFill(receipt);
        }
      } catch (err) {
        if (this.onError) this.onError(err, event);
        else throw err;
      }
    }
  }

  // Three outcomes, three sentences, deliberately not sharing one: an operator
  // reading this at 3am has to know whether the venue disagrees with this SDK,
  // answered something this SDK cannot read, or never answered at all. The
  // first is a lockstep-deploy problem, the second is the venue's contract, the
  // third is reachability/routing, and they are fixed by different people.
  //
  // The middle one used to collapse into the third. `VenueCapabilitiesSchema`
  // required `phase`, which RFC §12 only SHOULDs, so a conformant venue serving
  // `200 {"rfcVersion":"0.3.0-draft"}` threw a zod error inside
  // `HttpSolverTransport.getCapabilities`, landed in the same `catch` as a
  // connection refusal, and was reported as "the venue never answered -- check
  // reachability, routing and the base URL". It answered, correctly. `phase` is
  // optional now, and a body that still fails validation says so in its own
  // words rather than borrowing the reachability one.
  private async assertVenueRfcVersion(signal?: AbortSignal): Promise<void> {
    const silent = (why: string): Error =>
      new Error(`SolverClient: refusing to run -- the venue did not tell me its RFC version: ${why}`);

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
      // Two different faults arrive here, and the remedies have no overlap. A
      // transport that never completed is a reachability problem; a body that
      // completed and then failed validation is the venue's contract, and
      // telling its operator to check routing is how a correct venue gets
      // debugged as an unreachable one.
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

  private async handleAnnouncement(solver: Solver, event: Extract<SolverEvent, { type: "announcement" }>): Promise<void> {
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
  apiKey?: string;
  solverId: string;
  // Resumable feed cursor to start from (RFC section 4.1). Defaults to "0".
  since?: string;
  // Called when a batch reports `dropped` or `reset` -- i.e. this reader missed
  // announcements. Omitting it preserves the previous behaviour (the gap is not
  // acted on), but the batch is now parsed rather than destructured, so the
  // fields can never be silently lost again.
  onFeedGap?: (gap: FeedGap) => void;
  // Called when a single feed ENTRY fails validation. Supplying it skips that
  // entry and continues; omitting it rethrows, which ends `SolverClient.run`.
  //
  // This is deliberately per-ENTRY. A malformed batch envelope is NOT routed
  // here and always throws: without a trustworthy `cursor` there is no safe way
  // to continue -- resuming from the old one replays, and inventing one skips.
  onInvalidEvent?: (err: unknown, raw: unknown) => void;
  // Upper bound on `acceptAward` (default 10_000 ms), on top of any caller
  // signal. An acceptance is owed from the moment it is sent, so a venue that
  // never answers must not hold the solver past the point it has to fill.
  acceptTimeoutMs?: number;
}

// Transport over the `/solver/*` HTTP surface: a resumable long-poll feed
// (`GET /solver/intents/stream?since=`) + POST bid/fill.
//
// The feed parks server-side when nothing is new, which is what keeps this
// delay-free loop from spinning. The batch also carries `dropped` (entries that
// fell off the retention ring -- this reader is too slow) and `reset` (the
// cursor named a sequence the log never issued, so an unknown number of
// announcements were missed). Both are reported via `onFeedGap`.
export class HttpSolverTransport implements SolverTransport {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly onFeedGap?: (gap: FeedGap) => void;
  private readonly onInvalidEvent?: (err: unknown, raw: unknown) => void;
  private readonly acceptTimeoutMs: number;
  private cursor: string;

  constructor(opts: HttpSolverTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.cursor = opts.since ?? "0";
    this.onFeedGap = opts.onFeedGap;
    this.onInvalidEvent = opts.onInvalidEvent;
    this.acceptTimeoutMs = opts.acceptTimeoutMs ?? 10_000;
    this.headers = {
      "Content-Type": "application/json",
      "X-Solver-Id": opts.solverId,
      ...(opts.apiKey ? { "X-API-Key": opts.apiKey } : {}),
    };
  }

  async *events(signal?: AbortSignal): AsyncIterable<SolverEvent> {
    while (!signal?.aborted) {
      const requestedCursor = this.cursor;
      const res = await fetch(`${this.baseUrl}/solver/intents/stream?since=${encodeURIComponent(requestedCursor)}`, {
        headers: this.headers,
        signal,
      });
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
      if (this.onFeedGap && (dropped > 0 || reset)) {
        this.onFeedGap({ dropped, reset, requestedCursor, cursor: batch.cursor });
      }
      for (const raw of batch.events) {
        let event: SolverEvent;
        try {
          event = parseSolverEvent(raw);
        } catch (err) {
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

  // `GET /solver/capabilities` is public and unauthenticated (RFC §12), so this
  // deliberately sends no credentials -- it must work before admission.
  async getCapabilities(signal?: AbortSignal): Promise<VenueCapabilities> {
    const res = await fetch(`${this.baseUrl}/solver/capabilities`, { signal });
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
    const res = await fetch(`${this.baseUrl}/solver/attestations/${encodeURIComponent(orderId)}`, {
      headers: this.headers,
      signal,
    });
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
    const res = await fetch(`${this.baseUrl}/solver/awards/${encodeURIComponent(auctionId)}/accept`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.acceptTimeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) throw new Error(`solver accept ${res.status}: ${await res.text()}`);
    return FillAcceptanceReceiptSchema.parse(await res.json());
  }

  async submitFill(receipt: FillReceipt): Promise<void> {
    await this.post("/solver/fills", receipt);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
  }
}
