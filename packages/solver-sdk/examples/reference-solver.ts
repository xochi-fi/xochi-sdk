// Runnable reference solver for the Riddler sealed-bid RFQ (SOLVER-RFC.md).
//
//   npm run example:solver              # offline stub auctioneer, no network
//   npm run example:solver -- --live    # against a venue's /solver/* surface
//
// OFFLINE IS THE DEFAULT BECAUSE IT IS THE ONLY MODE IN WHICH `fill` RUNS. At
// P0 the venue's own reserve wins every auction (SOLVER-RFC.md §9), so a live
// run exercises discovery -> quote -> sealed bid and stops there, by design and
// not by fault. The offline harness is a stub auctioneer implementing the §5.1
// acceptance rules, so the award -> fill half of the loop is exercised with no
// network, no credentials and no funds.
//
// The offline script deliberately covers the shapes a strictly serialized demo
// hides, because each one is a way to lose money rather than a corner case:
//   * an admissible bid that still loses to the venue's private reserve;
//   * the best output on the book EXCLUDED because its signed `validUntilMs`
//     has passed by the close -- unreachable in a script that never has a
//     rival bid;
//   * an announcement whose window closes an hour out, refused rather than
//     signed;
//   * three auctions open AT THE SAME TIME, which is the only way the inventory
//     hold and the tracked-announcement index are exercised at all.
//
// LIVE PREREQUISITES. The offline run needs none of this: it makes no network
// call, holds no credential, and reads no environment variable at all.
//   RIDDLER_SOLVER_URL  https origin of the venue's /solver/* surface. Plain
//                       http is refused unless the host is loopback.
//   SOLVER_KEY          0x + 64 hex. Signs bids; its ADDRESS is your solverId.
//                       Never printed, never in an error message. A demo key
//                       from this file is refused.
//   SOLVER_API_KEY      panel secret, sent as `X-API-Key`. REQUIRED: without it
//                       every feed poll is a 401 that reads like a failed
//                       admission rather than a missing variable.
// All three are resolved and checked before the first request.
//
// Copying this out of the repo: change the `../src/index` import to
// "@xochi/solver-sdk". Nothing else here is repo-local.

import { ethers } from "ethers";
import {
  SOLVER_RFC_VERSION,
  SolverClient,
  signBid,
  solverIdFromKey,
  verifyBidDetailed,
  type Award,
  type Bid,
  type BidDraft,
  type FeedGap,
  type FillReceipt,
  type IntentAnnouncement,
  type Solver,
  type SolverCapabilities,
  type SolverEvent,
  type SolverTransport,
  type VenueCapabilities,
  ZERO_ORDER_ID,
} from "../src/index";

// ---------------------------------------------------------------------------
// Strategy configuration. Everything here is a market-maker decision, not a
// protocol constant.
// ---------------------------------------------------------------------------

// Chains this solver can fill on. Sepolia only, and USDC-only: `usdt`/`weth`
// are null on every testnet entry in the taker SDK's CONFIG.CHAINS, so there
// is nothing else to make a market in here.
const SUPPORTED_CHAINS = [11155111, 84532, 421614, 11155420];
// The one settlement mode this solver can service. `stealth`/`shielded` need a
// destination-side claim path this reference does not implement.
const SUPPORTED_SETTLEMENT: Record<string, true> = { public: true };

// Per-token limits in that token's OWN base units, and its decimals, which the
// pricing path below actually reads: `fromAmount` is in the ORIGIN token's base
// units and `minOutput` is in the DESTINATION token's, and the two are only the
// same scale by accident on a usdc -> usdc corridor. `minFill`/`maxFill` bound
// the ORIGIN size.
//
// No USD notional here on purpose: a USD bound needs a price oracle, and
// inventing one in a reference solver would hide the fact that a real one is
// yours to bring.
const TOKENS: Record<string, { decimals: number; minFill: bigint; maxFill: bigint }> = {
  usdc: { decimals: 6, minFill: 1_000_000n, maxFill: 25_000_000_000n }, // 1 .. 25,000 USDC
};

// Destination float, keyed `<chainId>:<symbol>` in that token's base units.
//
// This map is what is AVAILABLE TO COMMIT, not what is on hand. A bid is a firm
// offer, so `quote` DEBITS it before returning a draft. Holding at fill time
// instead lets N concurrent auctions each see the whole balance and win N times
// what the solver can deliver -- which is not an edge case: the feed delivers a
// batch of announcements before any award arrives, and the overlapping round
// below reproduces it in a few lines of script.
//
// Three things release a hold: a fill consumes it, a refused submission hands
// it straight back (`releaseBid`), and an elapsed window drops it (`prune`).
// There is deliberately no fourth: LOSING is not announced -- the feed carries
// no "you lost" event -- so a losing bid's hold stays committed until
// `closesAt + exclusiveWindowMs` has passed and the prune can prove nobody can
// still award it. That latency is a real cost of bidding, and it is what the
// float has to be sized against.
//
// 50,000 is small on purpose: the overlapping round runs it out, so the third
// concurrent auction is refused in the run's own output instead of in prose.
const INITIAL_FLOAT = 50_000_000_000n; // 50,000 USDC per chain
const inventory = new Map<string, bigint>();
for (const chainId of SUPPORTED_CHAINS) inventory.set(`${chainId}:usdc`, INITIAL_FLOAT);

// What fills actually paid out, same keys. Kept apart from `inventory` so the
// summary can tell "committed and gone" from "committed and still held".
const settled = new Map<string, bigint>();

// This solver's all-in cost to service a corridor: its own spread plus bridging
// plus destination gas, in bps OF THE DELIVERABLE (i.e. of the origin size
// rescaled into destination base units, which is the same unit `minOutput` and
// every `output` on the wire are in). Everything it can deliver above that is
// the taker's.
//
// Note what this is NOT: a markup on the venue's reserve. As of RFC
// `0.3.0-draft` the announcement carries `minOutput` (the admissibility floor)
// rather than the reserve, so there is no reserve field in the feed to shade
// against and a solver has to price the corridor itself.
//
// Be precise about what that buys, because the docs have overclaimed it: the
// reserve is still RECONSTRUCTIBLE. It is `fromAmount` less the published take
// (SPEC.md §4 `FEE_SCHEDULE`, `fee/vectors.json`), and `fromAmount` is still
// announced -- so a panel member holding @xochi/spec recovers it to the wei
// and `reserve + ε` remains computable. Withholding it is a wire change, not a
// claim of unpredictability; it stops being reconstructible only when the venue
// gives the reserve a genuinely private component (D1d in Riddler's internal
// docs/economics/AUCTION-DISCLOSURE-MEMO.md, outstanding).
const OWN_COST_BPS = 14n;

// How long this solver's pricing takes, end to end. Bids arriving after
// `closesAt` are rejected 409, so a solver must refuse a window it cannot
// service rather than spend the round losing to the clock -- round 7 of the
// offline script is that race, lost.
//
// 40ms is a PLACEHOLDER for the p99 of the pricing call you replace the stub
// with, plus your own network leg to the venue. It is not a protocol number
// and there is nothing to copy here: measure yours. Set it too low and every
// bid arrives late; too high and the solver passes on windows it could serve.
const PRICING_MS = 40;

// How long this solver's bid stands after the window closes. Signed as the
// ABSOLUTE `validUntilMs` (SolverBid v2, RFC §5.1) = `closesAt` + this, on this
// solver's own reading of `closesAt` -- the venue cannot stretch it, and the
// escrow node refuses a `:winner` FillAuth past it. 2s is a hedge budget, not a
// protocol number -- replace it with the life of the quote you hedge against.
const BID_LIFETIME_MS = 2_000;

// The shortest exclusive fill window this solver accepts (`minExclusiveMs`,
// signed). The venue grants at least this or awards its reserve instead, so a
// shrunk window can never become a slash. Size it to your fill latency.
const MIN_EXCLUSIVE_MS = 30_000;

// Client-side bound on how far out an announcement's window may close.
// `closesAt` is not a signed field and nothing else bounds it, so this is the
// only place it can be bounded at all: a venue announcing a window that closes
// an hour out otherwise gets a sealed, firm, signed offer this solver cannot
// hedge for an hour. A venue advertises its own `auction.windowMs` (300ms on
// the deployments this was written against, 1500ms in the SDK's own transport
// fixture), so 10s is ~30x the largest advertised window and still inside the
// life of a hedge quote.
const MAX_WINDOW_AHEAD_MS = 10_000;

// Same argument for the obligation AFTER the award. `exclusiveWindowMs` is the
// winner's fill budget, advertised as 30_000 by the venue capability matrix;
// 60s is 2x that. Past it the exclusive window outlives the hedge behind the
// price, and defaulting the window is worse than not bidding.
const MAX_EXCLUSIVE_WINDOW_MS = 60_000;

// Bounded announcement index. `Award` carries no corridor (SOLVER-RFC.md §5.2),
// so the destination chain a fill must land on comes from the announcement that
// was bid on -- which means every bid MUST be indexed by `intentId`, and losing
// an entry forfeits a round this solver has already won.
//
// This is a MEMORY BACKSTOP, not a policy. Two real bounds already apply: the
// inventory hold caps concurrency at float/minFill, and the time prune caps age
// at `closesAt + exclusiveWindowMs`. 512 is far past the concurrency a 300ms
// window and a 30s exclusive window can produce, so REACHING it means one of
// those two bounds is broken. Eviction therefore takes the entry with the
// soonest fill deadline (least remaining value) and says so loudly -- never
// insertion order, which by construction drops the entry that has been
// winnable the longest, and never silently, because the consequence surfaces
// later as an award this solver cannot fill.
const MAX_TRACKED = 512;

// ---------------------------------------------------------------------------

type Clock = {
  now: () => number;
  // Advances the OFFLINE simulated clock. In live mode this is a no-op and
  // pricing latency is real; the offline harness needs a knob so the
  // window/late-bid paths are deterministic rather than machine-speed.
  tick: (ms: number) => void;
};

const say = (line: string) => console.log(line);

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
const MAX_LOGGED_CHARS = 64;
const MAX_LOGGED_ERROR_CHARS = 240;
const tame = (value: string, max = MAX_LOGGED_CHARS): string => {
  const clean = value.replace(/\p{C}/gu, "\uFFFD");
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max)}...` : clean);
};

// Local symbol lookup ONLY. A cross-VM token value (a base58 Tron address) is
// case-sensitive and MUST be carried verbatim everywhere else.
const symbolOf = (token: string): string => token.toLowerCase();

const bpsBelow = (amount: bigint, bps: bigint): bigint => amount - (amount * bps) / 10_000n;

// ORIGIN base units -> DESTINATION base units. Not optional even when the price
// is 1:1: `usdc` is 6 decimals on every chain here, but the moment a corridor
// lands on an 18-decimal token an unscaled `output` is off by 10^12 and clears
// the floor by a factor of a trillion with nothing objecting. Truncates on the
// way down, which under-promises rather than over-promises.
//
// The PRICE is still 1:1 and that is this model's one real assumption: every
// symbol in `TOKENS` is the same USD stablecoin. Bring your own price here.
const rescale = (amount: bigint, fromDecimals: number, toDecimals: number): bigint => {
  if (fromDecimals === toDecimals) return amount;
  return fromDecimals < toDecimals
    ? amount * 10n ** BigInt(toDecimals - fromDecimals)
    : amount / 10n ** BigInt(fromDecimals - toDecimals);
};

// RFC §4.2: `minOutput` is the lowest output the venue will settle at, so a bid
// BELOW it is rejected outright and a bid EQUAL to it is admissible. One
// predicate, read by both halves of this file, so the solver and the model
// auctioneer cannot disagree about the boundary -- they did, and an off-by-one
// on the only admissibility rule a maker has is not a style problem.
//
// Admissible is not winning: an output equal to the floor cannot beat a reserve
// at or above it. It is still worth sending, because the reserve is private.
const isAdmissible = (output: bigint, minOutput: bigint): boolean => output >= minOutput;

// ---------------------------------------------------------------------------
// Keys. Two rules, both load-bearing.
// ---------------------------------------------------------------------------

const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;
// A counting demo key: 24 zero bytes then a small integer. Real keys do not
// look like this. The offline harness signs with these and nothing else.
const DEMO_KEY = /^0x0{48}[0-9a-fA-F]{16}$/;

// Rule 1: a private key never reaches a message, a log line or an error. This
// output goes to a terminal, a CI log and a support ticket, so a caller gets
// the VARIABLE NAME and the reason, never the value.
function assertKeyShape(name: string, key: string): void {
  if (!KEY_SHAPE.test(key)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key (0x + 64 hex digits); value not shown`);
  }
}

// Rule 2, the offline half: the stub must not be handed a real key. It signs
// bids a live venue would accept as firm offers, so the signatures it produces
// are real signatures. Guarding the constant means a future edit that pastes a
// working key in here fails at startup instead of signing with it.
function assertDemoKey(name: string, key: string): void {
  assertKeyShape(name, key);
  if (!DEMO_KEY.test(key)) {
    throw new Error(`${name} is not one of this harness's demo keys; the offline run signs real, valid bids and must never hold a real key`);
  }
}

// Rule 2, the live half: `--live` must not be reachable with the placeholder.
// Its address is public, its bids are firm, and every reader of this file has
// its private key.
function assertLiveKey(name: string, key: string): void {
  assertKeyShape(name, key);
  if (DEMO_KEY.test(key)) {
    throw new Error(`${name} is a demo key from this example (top 24 bytes zero); --live signs firm offers, so it is refused`);
  }
}

// ---------------------------------------------------------------------------

interface Tracked {
  ann: IntentAnnouncement;
  bidOutput: bigint; // destination base units
  holdKey: string; // `<chainId>:<symbol>` the hold is against
  held: bigint; // destination base units debited from `inventory`
}

class ReferenceSolver implements Solver {
  readonly solverId: string;
  // `quoted` counts calls to `quote`, so an announcement whose window had
  // already closed on arrival is absent: the client skips it before asking.
  readonly stats = { quoted: 0, bid: 0, passed: 0, filled: 0, evicted: 0 };
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    solverKey: string,
    private readonly clock: Clock,
  ) {
    // The solverId is the solver key's ADDRESS, and the venue binds it to your
    // API secret: a valid secret paired with another member's id is a 401.
    this.solverId = solverIdFromKey(solverKey);
  }

  capabilities(): SolverCapabilities {
    return {
      solverId: this.solverId,
      chains: [...SUPPORTED_CHAINS],
      tokens: Object.keys(TOKENS),
      settlementTypes: ["public"],
      // One source of truth, exported by the SDK. A literal retyped here drifts
      // from the version the installed SDK actually implements, and the skew
      // surfaces as every bid being rejected as a bad signature.
      rfcVersion: SOLVER_RFC_VERSION,
    };
  }

  async quote(ann: IntentAnnouncement): Promise<BidDraft | null> {
    this.stats.quoted += 1;
    this.prune();

    const pass = (why: string): null => {
      this.stats.passed += 1;
      say(`  pass  ${tame(ann.intentId)}  ${why}`);
      return null;
    };

    // Cheap refusals first, before spending the pricing budget.
    const remaining = ann.closesAt - this.clock.now();
    if (remaining <= PRICING_MS) return pass(`${remaining}ms of window left, pricing needs ${PRICING_MS}ms`);
    if (remaining > MAX_WINDOW_AHEAD_MS) {
      return pass(`window closes ${remaining}ms out, past the ${MAX_WINDOW_AHEAD_MS}ms we will hold a firm offer open for`);
    }
    if (ann.exclusiveWindowMs > MAX_EXCLUSIVE_WINDOW_MS) {
      return pass(`exclusive fill window ${ann.exclusiveWindowMs}ms exceeds our ${MAX_EXCLUSIVE_WINDOW_MS}ms hedge`);
    }

    const unservicable = this.filter(ann);
    if (unservicable) return pass(unservicable);

    // Stand-in for your pricing call. Replace with a real one; its latency is
    // what the `remaining` check above is budgeting against.
    this.clock.tick(PRICING_MS);

    // `filter` already refused an announcement with no `fromAmount` and an
    // unknown symbol on either leg; both are re-read here because that
    // narrowing does not cross the function boundary, and a non-null assertion
    // would be a promise rather than a check.
    if (ann.fromAmount === undefined) return pass("exact_input announcement carries no fromAmount");
    const origin = TOKENS[symbolOf(ann.fromToken)];
    const dest = TOKENS[symbolOf(ann.toToken)];
    if (!origin || !dest) return pass(`corridor ${tame(ann.fromToken)} -> ${tame(ann.toToken)} is not one we price`);

    const size = BigInt(ann.fromAmount); // ORIGIN base units
    const deliverable = rescale(size, origin.decimals, dest.decimals); // DESTINATION base units
    const output = bpsBelow(deliverable, OWN_COST_BPS); // DESTINATION base units
    const floor = BigInt(ann.minOutput); // DESTINATION base units

    // Below the floor the venue rejects outright (422), so there is nothing to
    // gain by sending it. At or above it the bid is ADMISSIBLE, not winning:
    // the reserve is private and may well be higher than this.
    if (!isAdmissible(output, floor)) {
      return pass(`our ${OWN_COST_BPS}bp cost puts output ${output} below the floor ${floor} (both destination base units)`);
    }

    // A re-quote REPLACES the live bid at the venue, so it must replace the
    // hold here rather than stack a second one against the same intent.
    const prior = this.tracked.get(ann.intentId);
    if (prior) this.drop(ann.intentId, prior, "re-quoted, replacing the earlier hold");

    // Commit the inventory NOW. This is the point at which the solver becomes
    // liable for `output` on the destination; the award only tells it whether
    // the liability was worth taking.
    const holdKey = `${ann.toChainId}:${symbolOf(ann.toToken)}`;
    const available = inventory.get(holdKey) ?? 0n;
    if (available < output) {
      return pass(
        `uncommitted inventory ${available} on ${holdKey} < the ${output} this bid commits (${this.tracked.size} live bid(s) already holding)`,
      );
    }
    inventory.set(holdKey, available - output);
    this.tracked.set(ann.intentId, { ann, bidOutput: output, holdKey, held: output });

    this.stats.bid += 1;
    // bps OF THE FLOOR: both sides are destination base units, so this is the
    // headroom over the admissibility floor and nothing else. It is NOT bps of
    // the origin size, and it is NOT a distance from the reserve, which this
    // solver never sees.
    const overFloorBps = ((output - floor) * 10_000n) / floor;
    say(
      `  bid   ${tame(ann.intentId)}  output=${output} (floor ${floor}, +${overFloorBps}bp of floor)  hold ${output} on ${holdKey}, ${available - output} uncommitted`,
    );
    return { output: output.toString(), validUntilMs: ann.closesAt + BID_LIFETIME_MS, minExclusiveMs: MIN_EXCLUSIVE_MS };
  }

  async fill(award: Award): Promise<FillReceipt> {
    const tracked = this.tracked.get(award.intentId);
    if (!tracked) {
      // Loud and actionable, not a bare throw. Without the announcement there
      // is no destination chain to prove a fill on, and guessing one produces a
      // receipt the venue's oracle resolves against the wrong chain. This is
      // the one failure that forfeits a round already WON, so it says what to
      // do about it -- and it cannot be checked any other way, because the
      // announced terms are not members of the signed bid and `Award` carries
      // no corridor to cross-check (axol-io/Riddler#1034).
      const why =
        `award for untracked intent ${tame(award.intentId)}: nothing to fill against. ` +
        `In order of likelihood: (1) this process restarted between bid and award -- the index is in-memory only, persist it; ` +
        `(2) MAX_TRACKED=${MAX_TRACKED} evicted it, look for an EVICT line above; ` +
        `(3) the venue awarded an intent this solver never bid on, which is a venue bug and MUST NOT be filled blind.`;
      say(`  ALERT ${why}`);
      throw new Error(why);
    }

    if (this.clock.now() >= award.exclusiveUntil) {
      throw new Error(`exclusive window for ${tame(award.intentId)} closed at ${award.exclusiveUntil}; the backstop has it`);
    }

    // The settle rule may credit an output other than the one bid (§2.1's
    // Vickrey variant), so the awarded output is checked against what was
    // priced rather than assumed equal to it.
    const awarded = BigInt(award.output);
    if (awarded > tracked.bidOutput) {
      throw new Error(`award output ${awarded} exceeds our bid ${tracked.bidOutput} for ${tame(award.intentId)}`);
    }

    if (award.escrow) {
      // P1. Before filling, bind to the escrow: recompute the v2 orderId (ESCROW-RFC 2.3)
      // and check it equals `intentRef` (ESCROW-RFC.md §2, §7).
      say(`  note  escrow envelope present: ${tame(award.escrow.address)} intentRef=${tame(award.escrow.intentRef)}`);
    }

    // The hold taken at bid time already covers `awarded` (awarded <=
    // bidOutput, checked above), so the fill CONSUMES the hold instead of
    // re-reading a balance that other in-flight bids have already committed.
    // Any Vickrey difference goes back to the float.
    this.tracked.delete(award.intentId);
    settled.set(tracked.holdKey, (settled.get(tracked.holdKey) ?? 0n) + awarded);
    const unspent = tracked.held - awarded;
    if (unspent > 0n) inventory.set(tracked.holdKey, (inventory.get(tracked.holdKey) ?? 0n) + unspent);

    // STUB. Replace with the destination transaction you actually broadcast:
    // the venue's oracle watch resolves this hash on `chainId`, so a hash that
    // does not exist there is an unproven fill and releases nothing.
    const txHash = ethers.id(`${award.intentId}:${award.output}`);

    this.stats.filled += 1;
    say(`  fill  ${tame(award.intentId)}  ${awarded} on chain ${tracked.ann.toChainId}  tx=${txHash.slice(0, 18)}...`);
    return {
      auctionId: award.auctionId,
      intentId: award.intentId,
      solverId: this.solverId,
      proof: { kind: "tx_hash", chainId: tracked.ann.toChainId, txHash },
    };
  }

  // A bid the venue REFUSED is not a commitment. The SDK reports a submit
  // failure to `onError`, never to the solver, so the loop's error hook has to
  // hand the hold back here or the float stays committed to a bid that does not
  // exist until the window elapses.
  releaseBid(intentId: string, why: string): void {
    const entry = this.tracked.get(intentId);
    if (entry) this.drop(intentId, entry, why);
  }

  // Inventory committed to bids that have neither been awarded nor expired.
  outstandingHolds(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const entry of this.tracked.values()) {
      out.set(entry.holdKey, (out.get(entry.holdKey) ?? 0n) + entry.held);
    }
    return out;
  }

  // Reasons to pass that cost nothing to evaluate.
  private filter(ann: IntentAnnouncement): string | null {
    if (ann.swapKind !== "exact_input") {
      // Not announced in practice (§4.2: the reserve IS the requested output,
      // so no bid can beat it and this bid shape has no input field to compete
      // on). Refused rather than trusted not to arrive.
      return `swapKind ${tame(ann.swapKind)} is unwinnable under an output-only bid`;
    }
    if (!SUPPORTED_SETTLEMENT[ann.settlementPreference]) return `settlement ${tame(ann.settlementPreference)}`;
    if (!SUPPORTED_CHAINS.includes(ann.fromChainId)) return `origin chain ${ann.fromChainId}`;
    if (!SUPPORTED_CHAINS.includes(ann.toChainId)) return `destination chain ${ann.toChainId}`;

    const origin = TOKENS[symbolOf(ann.fromToken)];
    const dest = TOKENS[symbolOf(ann.toToken)];
    if (!origin) return `origin token ${tame(ann.fromToken)}`;
    if (!dest) return `destination token ${tame(ann.toToken)}`;

    if (ann.fromAmount === undefined) return "exact_input announcement carries no fromAmount";
    // `minFill`/`maxFill` are the ORIGIN token's base units, so they are
    // compared against `fromAmount` and looked up under the ORIGIN symbol.
    // Reading them off the destination token worked only because `TOKENS` holds
    // a single 6-decimal symbol.
    const size = BigInt(ann.fromAmount);
    if (size < origin.minFill) return `size ${size} below min ${origin.minFill} (origin base units)`;
    if (size > origin.maxFill) return `size ${size} above max ${origin.maxFill} (origin base units)`;
    return null;
  }

  private fillDeadline(ann: IntentAnnouncement): number {
    return ann.closesAt + ann.exclusiveWindowMs;
  }

  // Release the hold and forget the entry. EVERY exit from `tracked` other than
  // a completed fill goes through here, so a hold cannot leak: leaked inventory
  // is float this solver can never bid with again.
  private drop(intentId: string, entry: Tracked, why: string): void {
    this.tracked.delete(intentId);
    inventory.set(entry.holdKey, (inventory.get(entry.holdKey) ?? 0n) + entry.held);
    say(`  free  ${tame(intentId)}  released ${entry.held} on ${entry.holdKey} (${why})`);
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [intentId, entry] of this.tracked) {
      if (now > this.fillDeadline(entry.ann)) this.drop(intentId, entry, "fill window elapsed unawarded");
    }
    // Everything the time pass left is still inside its fill window -- i.e.
    // still winnable -- so there is no free entry to drop and exceeding
    // MAX_TRACKED means discarding a live commitment. Take the one with the
    // least remaining fill value (soonest deadline) and say so: insertion order
    // would drop the entry that has been winnable the longest, and silence
    // turns this into an unexplainable failed fill minutes later.
    while (this.tracked.size > MAX_TRACKED) {
      let victim: [string, Tracked] | undefined;
      for (const candidate of this.tracked) {
        if (!victim || this.fillDeadline(candidate[1].ann) < this.fillDeadline(victim[1].ann)) victim = candidate;
      }
      if (!victim) break;
      this.stats.evicted += 1;
      say(
        `  EVICT ${tame(victim[0])} at MAX_TRACKED=${MAX_TRACKED}: an award for it can no longer be filled. Raise the bound or find the announcement flood.`,
      );
      this.drop(victim[0], victim[1], "evicted at MAX_TRACKED");
    }
  }
}

// ---------------------------------------------------------------------------
// Offline harness: a stub auctioneer enforcing the §5.1 acceptance rules.
// ---------------------------------------------------------------------------

// One-way, applied to a submission. Big enough that the "priced in time,
// submitted late" round is a real race against `closesAt` rather than an
// instant hop, and small enough to sit inside a 300ms window.
const NET_LATENCY_MS = 25;

// Another panel member's bid, submitted through the same acceptance path at the
// instant the announcement goes out. Rivals are why the harness can show the
// selection rules at all: with a single bidder, every acceptance rule that
// EXCLUDES a bid looks identical to "no bid was made".
interface RivalBid {
  key: string; // demo key; its address is the rival's solverId
  output: bigint; // destination base units
  // How long the rival's bid stands past the close; signed as the absolute
  // `validUntilMs` = closesAt + this. 0 = dead the instant the window closes.
  lifetimeMs: number;
}

interface Round {
  label: string;
  clockAt: number; // simulated wall clock when this announcement is delivered
  announcement: IntentAnnouncement;
  // The venue's own reserve bid for this round. PRIVATE to the auctioneer: it
  // is deliberately NOT a field of `announcement`, which is the whole point of
  // RFC 0.3.0-draft. A solver never sees this number.
  venueReserve: bigint;
  rivals?: RivalBid[];
}

class StubAuctioneer implements SolverTransport {
  readonly fills: FillReceipt[] = [];
  readonly awards: Award[] = [];
  private readonly open = new Map<string, IntentAnnouncement>();
  // auctionId -> solverId -> bid. One live bid PER SOLVER per window: a
  // resubmission replaces that solver's own bid and never another's.
  private readonly live = new Map<string, Map<string, Bid>>();
  // Announced but not yet closed. More than one entry here is more than one
  // auction open at once, which is the live shape and the only state in which
  // the inventory hold and the tracked index do anything.
  private pending: Round[] = [];

  constructor(
    private readonly clock: { t: number },
    private readonly script: Round[],
  ) {}

  // The venue half of RFC §12; `SolverClient.run` reads it before the first
  // event and refuses a skew, for an injected transport too. The stub serves
  // the version this SDK implements -- an offline harness advertising a skew
  // would only ever refuse to run.
  async getCapabilities(): Promise<VenueCapabilities> {
    return {
      rfcVersion: SOLVER_RFC_VERSION,
      phase: "P0",
      auction: { model: "sealed_bid_best_output", settleRule: "first_price", windowMs: WINDOW_MS, exclusiveWindowMs: EXCLUSIVE_WINDOW_MS },
      admission: { model: "riddler_only", panelSize: 1 },
      chains: [...SUPPORTED_CHAINS],
      settlementTypes: ["public"],
    };
  }

  async *events(): AsyncIterable<SolverEvent> {
    for (const round of this.script) {
      // Close only the windows that have actually ELAPSED by the time this
      // announcement is delivered, and do it before delivering it. Yielding
      // round N's award before announcing N+1 -- what this harness used to do
      // -- serializes the script and makes overlapping auctions unreachable,
      // which is exactly why every concurrency defect in this file was
      // invisible in its own demo.
      for (const award of this.closeElapsed(round.clockAt)) yield { type: "award", award };
      this.advanceTo(round.clockAt);
      say(`\n${round.label}`);
      this.open.set(round.announcement.auctionId, round.announcement);
      this.pending.push(round);
      await this.submitRivals(round);
      yield { type: "announcement", announcement: round.announcement };
    }
    // The feed ended: close everything still open, in close order.
    for (const award of this.closeElapsed(Number.MAX_SAFE_INTEGER)) yield { type: "award", award };
  }

  // The auctioneer's checks, in the order and with the codes SOLVER-RFC.md
  // §5.1 specifies. A live venue answers these as HTTP status codes; here they
  // are thrown so a rejection is visible rather than assumed.
  async submitBid(bid: Bid): Promise<void> {
    this.clock.t += NET_LATENCY_MS;
    // ONE verification call, and the REASON picks the status. `unencodable` and
    // `non_canonical` are 400s: the signature is fine and the BODY is not --
    // `007` and `7` are the same uint256 and therefore the same digest, so a
    // signature over a padded output recovers perfectly, and answering 403
    // sends a solver hunting a signing bug it does not have. `bad_signature`
    // (including the malleated high-s twin) and `signer_mismatch` are the
    // identity failures, and they are the only 403s.
    //
    // The two 400s are NOT interchangeable, and neither are the two 403s: only
    // `non_canonical` and `signer_mismatch` recovered an address, so a rejected
    // bid is attributable on exactly those branches. `verdict.signer` is typed
    // `null` on the other two, which is why this reads the field instead of
    // assuming a venue can always log who sent a bad bid.
    const verdict = verifyBidDetailed(bid);
    if (!verdict.ok) {
      const status = verdict.reason === "unencodable" || verdict.reason === "non_canonical" ? 400 : 403;
      const from = verdict.signer === null ? " from an unattributable signature" : ` from ${verdict.signer}`;
      throw new Error(`${status} ${verdict.reason}${from}: ${tame(verdict.detail, MAX_LOGGED_ERROR_CHARS)}`);
    }
    const ann = this.open.get(bid.auctionId);
    if (!ann) throw new Error(`404 no open auction ${tame(bid.auctionId)}`);
    if (bid.intentId !== ann.intentId) throw new Error("400 intentId does not match the announced intent");
    if (!isAdmissible(BigInt(bid.output), BigInt(ann.minOutput))) {
      // Below the admissibility floor there is nothing to settle against, so
      // the bid is refused outright rather than carried into selection.
      throw new Error(`422 output ${bid.output} below minOutput ${ann.minOutput}`);
    }
    if (this.clock.t >= ann.closesAt) throw new Error(`409 window closed at ${ann.closesAt}, bid arrived ${this.clock.t}`);
    const book = this.live.get(bid.auctionId) ?? new Map<string, Bid>();
    book.set(bid.solverId.toLowerCase(), bid); // a resubmission REPLACES, never accumulates
    this.live.set(bid.auctionId, book);
    say(`  202   accepted from ${bid.solverId.slice(0, 10)} (sealed until ${ann.closesAt})`);
  }

  async submitFill(receipt: FillReceipt): Promise<void> {
    this.fills.push(receipt);
    say(`  202   fill receipt recorded (recorded, NOT settled: the escrow is RESERVED)`);
  }

  // A rival's bid arrives at the same instant as the announcement, so it does
  // not eat the window the reference solver is pricing against: the latency and
  // the acceptance path are real, the clock is restored afterwards.
  private async submitRivals(round: Round): Promise<void> {
    const at = this.clock.t;
    for (const rival of round.rivals ?? []) {
      assertDemoKey("rival key", rival.key);
      const wallet = new ethers.Wallet(rival.key);
      const validUntilMs = round.announcement.closesAt + rival.lifetimeMs;
      say(`  rival ${wallet.address.slice(0, 10)} output=${rival.output} validUntilMs=${validUntilMs}`);
      const bid = await signBid(wallet, round.announcement, {
        output: rival.output.toString(),
        validUntilMs,
        minExclusiveMs: MIN_EXCLUSIVE_MS,
      });
      try {
        await this.submitBid(bid);
      } catch (err) {
        say(`  ${(err as Error).message}  (rival)`);
      }
    }
    this.clock.t = at;
  }

  private *closeElapsed(t: number): Generator<Award> {
    for (;;) {
      const due = this.pending
        .filter((round) => round.announcement.closesAt <= t)
        .sort((a, b) => a.announcement.closesAt - b.announcement.closesAt)[0];
      if (!due) return;
      this.pending = this.pending.filter((round) => round !== due);
      const award = this.close(due);
      if (award) yield award;
    }
  }

  // Never backwards: the solver's pricing tick and the submission latency move
  // the same clock, so a round nominally delivered at `opensAt + 5` can find
  // the clock already past that.
  private advanceTo(t: number): void {
    if (t > this.clock.t) this.clock.t = t;
  }

  private close(round: Round): Award | null {
    const ann = round.announcement;
    // Selection happens AT the close.
    const selectionAt = ann.closesAt;
    this.advanceTo(selectionAt);
    this.open.delete(ann.auctionId);
    const book = this.live.get(ann.auctionId) ?? new Map<string, Bid>();
    this.live.delete(ann.auctionId);
    say(`  close ${tame(ann.auctionId)} at ${selectionAt}: ${book.size} sealed bid(s)`);

    let best: Bid | undefined;
    for (const bid of book.values()) {
      // A bid stands while now <= validUntilMs (RFC §5.1). Inclusive at the
      // close, so a bid signed to lapse AT closesAt is excluded only once the
      // clock is past it -- the stub selects one tick after.
      if (selectionAt > bid.validUntilMs) {
        say(`  close ${bid.solverId.slice(0, 10)} output ${bid.output} EXCLUDED: validUntilMs ${bid.validUntilMs} passed by selection`);
        continue;
      }
      say(`  close ${bid.solverId.slice(0, 10)} output ${bid.output} eligible (until ${bid.validUntilMs})`);
      if (!best || BigInt(bid.output) > BigInt(best.output)) best = bid;
    }

    if (!best) {
      say(`  close reserve ${round.venueReserve} wins (no eligible bid)`);
      return null;
    }
    // Strictly greater: equal output loses, so the taker is never settled below
    // the venue's own quote (RFC §2.1).
    if (BigInt(best.output) <= round.venueReserve) {
      say(`  close best bid ${best.output} did not beat the private reserve ${round.venueReserve}; reserve wins`);
      return null;
    }
    const award: Award = {
      auctionId: ann.auctionId,
      intentId: ann.intentId,
      solverId: best.solverId,
      output: best.output,
      exclusiveUntil: ann.closesAt + ann.exclusiveWindowMs,
      // `escrow` is absent: at P0 there is nothing to claim against, which is
      // exactly why a live venue never awards a third party.
    };
    this.awards.push(award);
    say(`  award ${best.output} to ${best.solverId} until ${award.exclusiveUntil}`);
    return award;
  }
}

// A fixed simulated epoch (2027-01-15T08:00:00Z) so every run is identical.
const T0 = 1_800_000_000_000;
// Rounds are spaced far enough apart that only the rounds meant to overlap do;
// the overlapping round sets `opensAt`/`closesAt` explicitly.
const ROUND_SPACING_MS = 10_000;
const WINDOW_MS = 300; // the sealed window the deployments this models announce
const EXCLUSIVE_WINDOW_MS = 3_000; // the winner's fill budget, well inside MAX_EXCLUSIVE_WINDOW_MS
const DEFAULT_NOTIONAL = "1000000000"; // 1,000 USDC

// The MODEL venue's side of a round, in bps of the notional: a 22 bps headline
// take (solver 8 + venue 6 + routing 8) and a 50 bps taker slippage tolerance,
// which is what separates the announced `minOutput` from the reserve the venue
// keeps to itself.
//
// These are the stub's knobs -- `round()` is their only reader, and no bid is
// priced off them. But note what they demonstrate, because the maker-facing
// docs have overclaimed it: `minOutput = notional * (1 - (take + slippage))` is
// a published closed form, so a panel member holding @xochi/spec inverts the
// announced `fromAmount` back to the reserve exactly. See the OWN_COST_BPS note.
const VENUE_RESERVE_BPS = 22n;
const TAKER_SLIPPAGE_BPS = 50n;

interface RoundSpec {
  announcement?: Partial<IntentAnnouncement>;
  offsetMs?: number; // delivery time relative to opensAt
  reserveBps?: bigint;
  rivals?: RivalBid[];
}

function round(index: number, label: string, spec: RoundSpec = {}): Round {
  const overrides = spec.announcement ?? {};
  const opensAt = overrides.opensAt ?? T0 + index * ROUND_SPACING_MS;
  const closesAt = overrides.closesAt ?? opensAt + WINDOW_MS;
  const exactOutput = overrides.swapKind === "exact_output";
  const notional = BigInt(overrides.fromAmount ?? overrides.outputAmount ?? DEFAULT_NOTIONAL);
  const reserveBps = spec.reserveBps ?? VENUE_RESERVE_BPS;

  // On an exact-output round the taker's requested output IS both the floor and
  // the reserve, which is why those rounds are not announced in practice
  // (RFC §4.2): there is no room between them for a bid to land in.
  const venueReserve = exactOutput ? notional : bpsBelow(notional, reserveBps);
  const minOutput = exactOutput ? notional : bpsBelow(notional, reserveBps + TAKER_SLIPPAGE_BPS);

  const announcement: IntentAnnouncement = {
    intentId: `intent-${String(index).padStart(4, "0")}`,
    auctionId: `auction-${String(index).padStart(4, "0")}`,
    orderId: ZERO_ORDER_ID, // non-escrow rounds: the stub never issues a FillAuth
    fromChainId: 84532,
    toChainId: 421614,
    fromToken: "usdc",
    toToken: "usdc",
    swapKind: "exact_input",
    fromAmount: DEFAULT_NOTIONAL,
    settlementPreference: "public",
    minOutput: minOutput.toString(),
    opensAt,
    closesAt,
    exclusiveWindowMs: EXCLUSIVE_WINDOW_MS,
    recipientCommitment: ethers.id(`recipient-${index}`), // venue-keyed HMAC; opaque to you
    ...overrides,
  };
  return { label, clockAt: opensAt + (spec.offsetMs ?? 5), announcement, venueReserve, rivals: spec.rivals };
}

// Fixed keys so the run is reproducible. NOT keys to reuse anywhere: the top 24
// bytes are zero, which is what `assertDemoKey` recognises and what `--live`
// refuses.
const OFFLINE_KEY = `0x${"0".repeat(63)}1`;
const RIVAL_ZERO_LIFETIME = `0x${"0".repeat(63)}2`;
const RIVAL_UNDERBID = `0x${"0".repeat(63)}3`;

// The three overlapping rounds share one base so their windows genuinely
// intersect, and they settle on a chain the earlier rounds have not spent, so
// the float they exhaust is the whole 50,000.
const OVERLAP_OPENS = T0 + 11 * ROUND_SPACING_MS;
const OVERLAP_WINDOW_MS = 900; // long enough that all three are delivered while all three are open
const OVERLAP_NOTIONAL = "20000000000"; // 20,000 USDC: two holds fit the float, the third cannot
const OVERLAP_CHAIN = 11155420;

const SCRIPT: Round[] = [
  round(1, "1. we are cheaper than the venue -> bid, award, fill"),
  round(2, "2. exact_output round -> pass (unwinnable, and not announced live)", {
    announcement: { swapKind: "exact_output", fromAmount: undefined, outputAmount: DEFAULT_NOTIONAL },
  }),
  round(3, "3. unsupported token -> pass", { announcement: { fromToken: "usdt", toToken: "usdt" } }),
  round(4, "4. size above our cap -> pass", { announcement: { fromAmount: "250000000000" } }),
  round(5, "5. shielded settlement -> pass", { announcement: { settlementPreference: "shielded" } }),
  round(6, "6. window already closed on arrival -> client skips before quoting", { offsetMs: 350 }),
  round(7, "7. priced in time, submitted late -> 409 from the venue (and the hold comes straight back)", {
    offsetMs: WINDOW_MS - (PRICING_MS + 10),
  }),
  // The round the published-reserve design could not produce: our bid clears
  // the floor, so it is admissible, and still loses because the venue's own
  // reserve -- which we cannot see -- is better than our cost allows.
  round(8, "8. venue is cheaper than us -> admissible bid loses to the private reserve", { reserveBps: 10n }),
  // The best output on the book is a rival's and it is thrown out at selection
  // because its signed validUntilMs has passed; the second rival's bid still
  // stands and is simply outbid.
  round(9, "9. best output EXCLUDED at selection: its signed validUntilMs has passed", {
    rivals: [
      { key: RIVAL_ZERO_LIFETIME, output: 999_000_000n, lifetimeMs: -1 },
      { key: RIVAL_UNDERBID, output: 998_000_000n, lifetimeMs: 5_000 },
    ],
  }),
  round(10, "10. window closes an hour out -> pass (a firm offer we cannot hedge)", {
    announcement: { opensAt: T0 + 10 * ROUND_SPACING_MS, closesAt: T0 + 10 * ROUND_SPACING_MS + 3_600_000 },
  }),
  // Three auctions open at once against one float. The first two commit
  // 19,972 USDC each at BID time; the third is refused because the inventory is
  // already spoken for. Reserve at fill time instead and all three bid, after
  // which one of them defaults its exclusive window.
  round(11, "11a. three overlapping auctions, one float -> bid (holds 19,972 of 50,000)", {
    announcement: {
      opensAt: OVERLAP_OPENS,
      closesAt: OVERLAP_OPENS + OVERLAP_WINDOW_MS,
      toChainId: OVERLAP_CHAIN,
      fromAmount: OVERLAP_NOTIONAL,
    },
  }),
  round(12, "11b. still open, same float -> bid (holds the rest)", {
    announcement: {
      opensAt: OVERLAP_OPENS + 100,
      closesAt: OVERLAP_OPENS + 100 + OVERLAP_WINDOW_MS,
      toChainId: OVERLAP_CHAIN,
      fromAmount: OVERLAP_NOTIONAL,
    },
  }),
  round(13, "11c. both still open -> pass (inventory already committed, not double-sold)", {
    announcement: {
      opensAt: OVERLAP_OPENS + 200,
      closesAt: OVERLAP_OPENS + 200 + OVERLAP_WINDOW_MS,
      toChainId: OVERLAP_CHAIN,
      fromAmount: OVERLAP_NOTIONAL,
    },
  }),
  // Every string on an announcement is venue-controlled, and this one carries
  // an ANSI colour escape and a newline. Printed raw it repaints the terminal
  // and forges a whole log line -- "  202   accepted ..." is trivial to fake,
  // and a maker reading its own logs afterwards cannot tell. Every venue string
  // in this file therefore goes through `tame`, which is why this round stays
  // one line per event.
  round(14, "12. hostile announcement strings -> escaped in the log, never raw", {
    announcement: { intentId: "intent-\u001b[31m0014\n  202   accepted (forged)" },
  }),
];

async function runOffline(): Promise<void> {
  // No environment variable is read on this path: there is no route by which a
  // real SOLVER_KEY reaches this signer.
  assertDemoKey("OFFLINE_KEY", OFFLINE_KEY);

  const wall = { t: T0 };
  const clock: Clock = {
    now: () => wall.t,
    tick: (ms) => {
      wall.t += ms;
    },
  };
  const solver = new ReferenceSolver(OFFLINE_KEY, clock);
  const venue = new StubAuctioneer(wall, SCRIPT);

  say(`offline stub auctioneer  solverId=${solver.solverId}  RFC ${SOLVER_RFC_VERSION}`);
  say("the venue here awards a third party, which a real P0 venue never does");

  const client = new SolverClient({
    solverKey: OFFLINE_KEY,
    transport: venue,
    now: clock.now,
    // A rejected bid must not kill a solver daemon -- but it must not leave the
    // inventory committed either, and this hook is the only place the SDK
    // reports a refused submission. Note that `onFeedGap` / `onInvalidEvent`
    // are a CONSTRUCTOR ERROR alongside an injected transport: that transport
    // owns its feed and must report gaps itself.
    onError: (err, event) => {
      say(`  error ${event.type}: ${tame((err as Error).message, MAX_LOGGED_ERROR_CHARS)}`);
      if (event.type === "announcement") solver.releaseBid(event.announcement.intentId, "bid refused by the venue");
    },
  });

  await client.run(solver);

  say("\n--- summary ---");
  say(`quoted ${solver.stats.quoted}  bids ${solver.stats.bid}  passes ${solver.stats.passed}  evictions ${solver.stats.evicted}`);
  say(`awards ${venue.awards.length}  fills ${solver.stats.filled}  receipts ${venue.fills.length}`);
  for (const [key, paid] of settled) say(`settled ${key}: ${paid}`);
  for (const [key, held] of solver.outstandingHolds()) say(`held    ${key}: ${held} still committed to a live bid`);
  for (const [key, available] of inventory) {
    if (available !== INITIAL_FLOAT) say(`float   ${key}: ${available} uncommitted of ${INITIAL_FLOAT}`);
  }
}

// ---------------------------------------------------------------------------
// Live mode.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for --live (needs RIDDLER_SOLVER_URL, SOLVER_KEY, SOLVER_API_KEY)`);
  return value;
}

// The panel secret goes to this URL on every feed poll and every bid POST, and
// whatever answers chooses the announcements this solver signs firm offers
// against -- offers that are NOT bound to the venue that served them, because
// the EIP-712 domain carries no deployment binding (axol-io/Riddler#1034). So an
// unauthenticated origin is not a downgrade, it is a credential in cleartext
// plus a bid-signing oracle. https only, the same rule
// `scripts/probe-lib.mjs` applies to `RIDDLER_URL_<NAME>`.
//
// The loopback exemption exists for a local venue -- testing the version gate
// against one is a documented workflow -- and for nothing else: no private-range
// hosts, no plain http to a name that resolves off-box.
function assertVenueUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`RIDDLER_SOLVER_URL is not a URL: ${tame(raw)}`);
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) {
    say(`WARNING ${tame(url.origin)} is plain http, allowed only because it is loopback: the panel secret is sent unencrypted`);
    return;
  }
  throw new Error(`RIDDLER_SOLVER_URL must be https (loopback http is the only exemption); got ${tame(raw)}`);
}

interface LiveConfig {
  baseUrl: string;
  solverKey: string;
  apiKey: string;
}

// Everything a live run needs, resolved and checked BEFORE the first request
// and before a signer exists. All three variables are required: a missing panel
// secret otherwise surfaces as a feed 401, which reads as "you are not admitted
// to the panel" rather than "you forgot to export a variable".
function resolveLiveConfig(): LiveConfig {
  const baseUrl = requireEnv("RIDDLER_SOLVER_URL");
  const solverKey = requireEnv("SOLVER_KEY");
  const apiKey = requireEnv("SOLVER_API_KEY");
  assertVenueUrl(baseUrl);
  assertLiveKey("SOLVER_KEY", solverKey);
  return { baseUrl, solverKey, apiKey };
}

async function runLive(): Promise<void> {
  const { baseUrl, solverKey, apiKey } = resolveLiveConfig(); // no network yet, and nothing signed yet
  const clock: Clock = { now: () => Date.now(), tick: () => {} }; // pricing latency is real here

  const solver = new ReferenceSolver(solverKey, clock);
  const client = new SolverClient({
    baseUrl,
    solverKey,
    apiKey,
    onError: (err, event) => {
      say(`  error ${event.type}: ${tame((err as Error).message, MAX_LOGGED_ERROR_CHARS)}`);
      if (event.type === "announcement") solver.releaseBid(event.announcement.intentId, "bid refused by the venue");
    },
    // A gap means intents you will NEVER see. Acting on it is the point.
    onFeedGap: (gap: FeedGap) =>
      say(`  GAP   dropped=${gap.dropped} reset=${gap.reset} lost (${tame(gap.requestedCursor)}, ${tame(gap.cursor)}]`),
    onInvalidEvent: (err) => say(`  skip  malformed feed entry: ${tame((err as Error).message, MAX_LOGGED_ERROR_CHARS)}`),
  });

  // Public and unauthenticated: readable before admission. PRINTED, not
  // checked. `SolverClient.run` refuses an `rfcVersion` skew itself (RFC §12),
  // and a second comparison here would be a second thing to keep in step.
  const caps = await client.getCapabilities();
  // `phase` is a SHOULD in RFC §12, so a conformant venue may omit it and this
  // read must not be the thing that crashes a solver against one. Absent means
  // "the venue did not say", never "not P0".
  const phase = typeof caps.phase === "string" ? caps.phase : null;
  say(
    `venue ${tame(baseUrl)}  rfcVersion=${tame(caps.rfcVersion)} phase=${phase === null ? "(not advertised)" : tame(phase)} panel=${caps.admission?.panelSize ?? "?"}`,
  );
  say(`this solver implements RFC ${SOLVER_RFC_VERSION}`);
  if (phase === null) {
    say("the venue advertises no phase; assume nothing about whether an award can reach this solver");
  } else if (phase.toUpperCase() === "P0") {
    say("phase P0: bids are scored but the venue's reserve wins every auction -- `fill` will not run");
  }
  say(`solverId=${solver.solverId}\n`);

  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  try {
    await client.run(solver, abort.signal);
  } catch (err) {
    // Ctrl-C aborts the in-flight long poll, and the abort surfaces as a thrown
    // fetch error. That is a clean shutdown, not a failure: rethrowing it would
    // exit 1 and read like the venue dropped the feed.
    if (!abort.signal.aborted) throw err;
  } finally {
    say(`\nquoted ${solver.stats.quoted}  bids ${solver.stats.bid}  passes ${solver.stats.passed}  fills ${solver.stats.filled}`);
  }
}

const live = process.argv.includes("--live");
try {
  await (live ? runLive() : runOffline());
} catch (err) {
  // A missing variable, an http URL, a demo key or a version skew should say so
  // in one line, not print a stack: this is the first thing a new panel member
  // runs. Nothing here interpolates a key.
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
}
