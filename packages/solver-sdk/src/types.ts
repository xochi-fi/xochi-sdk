// Wire types + solver interface for the Riddler sealed-bid RFQ. Mirrors
// SOLVER-RFC.md (@xochi/spec) sections 3-7. This is the maker-side contract:
// discovery -> bid -> award -> fill.
//
// The `/solver/*` surface these types target is served behind
// `SOLVER_RFQ_ENABLED`, off by default (off on prod). The `escrow` envelope is
// sent only where Riddler can bind an escrow to a third-party award
// (`escrow_binding_available?`), which no real deployment can yet, so the
// reserve wins every auction there; the venue side stays [RESERVED] (M6).
// `OnchainEscrowGateway` is live code regardless: it sends real transactions
// (approve, fill, claim, SolverBond) for whatever award a caller hands it, and
// `SolverClient` never builds one. See SOLVER-RFC.md §7.1.

export type SettlementType = "public" | "stealth" | "shielded";
export type SwapKind = "exact_input" | "exact_output";

// What a solver can service. Returned by `Solver.capabilities()` and (proposed)
// advertised to the auctioneer for feed-eligibility.
export interface SolverCapabilities {
  solverId: string; // the solver key's address (see bidding)
  chains: number[]; // chain ids it can source/fill on
  tokens: string[]; // token symbols or addresses it makes markets in
  corridors?: { from: number; to: number }[];
  minNotionalUsd?: number;
  maxNotionalUsd?: number;
  settlementTypes: SettlementType[];
  rfcVersion: string; // SOLVER-RFC version it implements
}

// What the VENUE advertises about itself at `GET /solver/capabilities` (RFC
// §12). Distinct from `SolverCapabilities`, which is what a solver advertises.
// Public and unauthenticated by design: a prospective solver must be able to
// read `rfcVersion` and `phase` before it has registered, `admission.bond` to
// know which SolverBond to post and sign for (RFC §3.1), and `panelSize` to
// see the panel without holding credentials.
export interface VenueCapabilities {
  rfcVersion: string; // SOLVER-RFC version the venue serves
  // Optional because RFC §12 only SHOULDs it, and only `rfcVersion` is the
  // gate. A venue serving `{"rfcVersion": "0.3.0-draft"}` is conformant, so a
  // reader MUST guard this before calling a string method on it.
  phase?: string; // permissioning phase, upper-cased (e.g. "P0")
  auction?: {
    model?: string;
    settleRule?: string;
    windowMs?: number;
    exclusiveWindowMs?: number;
  };
  admission?: {
    // "bonded_permissionless" while a solver can register; "riddler_only" when
    // the venue admits nobody (no bond or no session secret configured).
    model?: string;
    panelSize?: number;
    // The SolverBond a registration names; null when none is configured.
    bond?: { chainId: number; address: string } | null;
  };
  chains?: number[];
  settlementTypes?: SettlementType[];
  // Present only while the venue lists a quote-through corridor (RFC §2.5).
  quoteThrough?: {
    settleRule?: string;
    quoteTtlSeconds?: number;
    corridors?: { fromChainId: number; toChainId: number }[];
  };
}

// A solver's standing with the venue (RFC §8), answered by
// `POST /solver/register`. Rates are over SETTLED panel awards (fills +
// no-shows) and read 0 before the first one.
export interface SolverReputation {
  solverId: string;
  fillSuccessRate: number; // fills / (fills + no-shows)
  noShowRate: number; // no-shows / (fills + no-shows)
  medianLatencyMs: number | null; // winner FillAuth issued -> fill observed; null with no fills
  volumeUsd: number;
  bondUsd: number; // active SolverBond stake, at par
  probation: boolean;
  eligible: boolean; // admitted: bond sufficient and freshly read
  exposureCapUsd: number; // in-flight awarded notional it may carry now
  inFlightUsd: number; // awarded notional not yet settled
}

// What `POST /solver/register` answers (RFC §3.1).
export interface SolverRegistrationResult {
  solverId: string;
  sessionToken: string; // sent back as `Authorization: Bearer`
  expiresAtMs: number; // venue clock
  reputation: SolverReputation;
}

// Signalled by the feed when this reader missed announcements. Both cases mean
// the same thing operationally -- there are intents you will never see -- but
// they differ in cause, so they are reported separately rather than collapsed.
export interface FeedGap {
  // Entries that fell off the retention ring before this reader consumed them:
  // you are too slow. 0 when the gap is a `reset` only.
  dropped: number;
  // The cursor named a sequence the log never issued, so an unknown number of
  // announcements were missed and the feed resumed from the log's head.
  reset: boolean;
  // The cursor this reader asked from -- the last position it is known to have
  // consumed. The lost range starts here.
  requestedCursor: string;
  // The cursor the feed resumed at. The lost range ends here, so the gap is
  // (requestedCursor, cursor]. Both are given because neither alone locates it.
  cursor: string;
}

// The sealed RFQ broadcast to the solver panel. Carries NO taker identity and NO
// signature -- the signed XochiIntent stays with the venue (SPEC.md section 2).
// Size is visible to the solicited panel only, never to a public book (the
// dark-pool boundary; RFC section 2.2).
export interface IntentAnnouncement {
  intentId: string;
  auctionId: string;
  // The escrow order this auction sells (bytes32). `0x00..00` for a non-escrow
  // auction; a bid over the zero orderId is never awardable. Signed into the bid.
  orderId: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  // Riddler announces exact_input only: an exact_output RFQ is unwinnable
  // under a bid with no input field (RFC 4.2). Keep handling both.
  swapKind: SwapKind;
  fromAmount?: string; // present iff exact_input (origin base units)
  outputAmount?: string; // present iff exact_output (dest base units)
  // Public-only (RFC §4.2), narrowed from `SettlementType`: a stealth or
  // shielded intent is not put to the panel, and the parser refuses any other
  // value off the feed.
  settlementPreference: "public";
  // The lowest output the venue will settle at for this intent: a bid below it
  // is rejected outright. It is NOT the venue's reserve bid, which is private
  // (RFC §2.1) -- a bid at `minOutput + 1` is ADMISSIBLE and still loses to the
  // reserve. Price the corridor yourself; there is no number here to shadow.
  // Exception: on a quote-through announcement (`quoteThrough: true`, RFC §2.5)
  // there is no private reserve -- `minOutput` IS the reserve, public, and a bid
  // at it is eligible (settled second-price).
  minOutput: string;
  opensAt: number; // server clock, ms
  closesAt: number; // sealed-window close, ms
  exclusiveWindowMs: number; // winner's exclusive fill budget after award
  // Quote-through corridor (RFC §2.5): the winning bid IS the taker's price,
  // settled second-price, and is selected only if its `validUntilMs` reaches
  // `minValidUntilMs`. Both absent on every other announcement.
  quoteThrough?: true;
  minValidUntilMs?: number;
}

// What `Solver.quote` returns: the output it commits to deliver to the taker,
// and the two terms the award is held to (SOLVER-RFC §5.1, SolverBid v2).
// Higher output = better for the taker = more likely to win.
export interface BidDraft {
  output: string; // committed output, dest base units; MUST fit uint256 (<= 78 digits)
  // ABSOLUTE unix ms. The bid stands only until then: the escrow node refuses
  // to issue a `:winner` FillAuth past it. Range 0..2^53-1 (`MAX_BID_MS`).
  validUntilMs: number;
  // The shortest exclusive fill window (ms) this solver accepts. The venue
  // grants at least ceil(minExclusiveMs / 1000) seconds or awards the reserve.
  minExclusiveMs: number;
}

// A sealed, signed bid on the wire: SolverBid v2 over (orderId, auctionId,
// intentId, output, validUntilMs, minExclusiveMs) with the solver key.
export interface Bid {
  auctionId: string;
  intentId: string;
  solverId: string;
  orderId: string; // bytes32, the announcement's; zero for a non-escrow auction
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
  signature: string; // 0x + 130 lowercase hex, low-s
}

// The auctioneer's award to the winning solver. Origin funds are escrowed
// against this award, never paid to the solver up front (ESCROW-RFC §9.4).
export interface Award {
  auctionId: string;
  intentId: string;
  solverId: string; // winner
  output: string; // settled output (see RFC section 2.1 settle variant)
  exclusiveUntil: number; // server clock, ms; exclusive fill window
  escrow?: AwardEscrow;
}

// The escrow envelope of an award (SOLVER-RFC §5.2). `address`/`intentRef` are
// the lock; the rest is what a solver needs to fill it and MUST verify before
// paying anything (`verifyAward`). Every uint is a decimal string on the wire.
export interface AwardEscrow {
  address: string; // the origin RiddlerEscrow
  intentRef: string; // the v2 orderId (ESCROW-RFC 2.3) the pull-auth binds to (SPEC section 2.3)
  fillId?: string; // keccak(orderId, fillSalt): the RiddlerFiller key (ESCROW-RFC §9.4)
  destOpening?: AwardDestOpening; // plaintext of the lock's destCommitment
  fillAuth?: AwardFillAuth; // the venue's RiddlerFiller authorization, naming this solver
  orderTerms?: AwardOrderTerms; // origin preimage of orderId, when the venue sends it
  payee?: string; // if present, MUST equal `fillAuth.filler`: the venue attests the filler, so `verifyAward` refuses any other
  bond?: AwardBond; // SolverBond v2: the FillAcceptance EIP-712 domain
  // Unix seconds (venue clock): the venue refuses an acceptance after this and
  // hands the order to the reserve (SOLVER-RFC §5.3 acceptance window).
  acceptBy?: string;
}

// The SolverBond v2 deployment the FillAcceptance is signed on (SOLVER-RFC §5.3).
export interface AwardBond {
  chainId: string; // decimal
  address: string;
}

// What the venue answers to `POST /solver/awards/:auctionId/accept`.
export interface FillAcceptanceReceipt {
  auctionId: string;
  orderId: string;
  signature: string;
  acceptedAt: number; // unix seconds
}

export interface AwardDestOpening {
  recipient: string;
  toToken: string;
  toAmount: string; // the release FLOOR the attester checks the fill against
  blinding: string; // bytes32
  intentId: string;
}

// Every member is optional on the WIRE so an award missing one still parses
// and reaches `Solver.fill`; `requireFillableEscrow` refuses it there.
export interface AwardFillAuth {
  fillId?: string;
  filler?: string; // msg.sender of RiddlerFiller.fill
  to?: string;
  token?: string;
  amount?: string; // :winner = the winning bid's output; >= destOpening.toAmount
  deadline?: string; // unix seconds; `fill` requires block.timestamp <= deadline
  chainId?: string; // destination chain: the EIP-712 domain
  fillerContract?: string; // RiddlerFiller: the EIP-712 verifyingContract
  signature?: string; // 65-byte r||s||v
}

export interface AwardOrderTerms {
  depositor: string;
  fromChainId: string;
  fromToken: string;
  fromAmount: string;
  toChainId: string;
  fillDeadline: string;
  escrow: string;
  destCommitment: string;
}

// What the venue's tier-0 attester signed for a conforming fill
// (`GET /solver/attestations/:orderId`). `verifier`/`chainId` are the EIP-712
// domain: the origin AttestedFillVerifier the lock was opened against.
export interface FillAttestationWire {
  orderId: string;
  payee: string;
  signature: string;
  proof: string; // abi.encode(address payee, bytes signature)
  verifier: string;
  chainId: string;
}

// Proof that a fill happened on the destination. Tagged union from day one so
// the wire format survives the proof upgrade (tx-hash -> oracle -> light-client
// -> zk). A verifier MUST treat an unknown `kind` as unproven (fail closed).
// `canton_update` is a Canton destination's fill: there is no transaction hash,
// only the ledger update id, an opaque case-sensitive string (never fold it).
export type FillProof =
  | { kind: "tx_hash"; chainId: number; txHash: string }
  | { kind: "canton_update"; updateId: string }
  | { kind: "oracle_attestation"; attestation: string; signer: string }
  | { kind: "light_client"; header: string; proof: string }
  | { kind: "zk"; proof: string; publicInputs: string[] };

export interface FillReceipt {
  auctionId: string;
  intentId: string;
  solverId: string;
  proof: FillProof;
}

// The two methods a third-party solver implements. The SolverClient drives the
// discovery/bid/award/fill loop and handles sealing/signing.
export interface Solver {
  capabilities(): SolverCapabilities;
  // Return a bid within the sealed window, or null to pass.
  quote(intent: IntentAnnouncement): Promise<BidDraft | null>;
  // Called only when this solver won the award. Fill on the destination and
  // return a receipt before `award.exclusiveUntil`.
  fill(award: Award): Promise<FillReceipt>;
}

// A single event off the discovery stream: a new RFQ, or an award. Modeled as a
// tagged union so the transport is a single ordered stream (RFC section 4.1).
export type SolverEvent =
  | { type: "announcement"; announcement: IntentAnnouncement }
  | { type: "award"; award: Award };

// The transport seam. `events()` is the (proposed) SSE / resumable long-poll
// feed; the submit methods are the (proposed) POST endpoints. Injectable so a
// solver is testable against an in-memory stub with no network.
export interface SolverTransport {
  events(signal?: AbortSignal): AsyncIterable<SolverEvent>;
  submitBid(bid: Bid): Promise<void>;
  submitFill(receipt: FillReceipt): Promise<void>;
  // Optional so an existing custom transport stays valid: widening this
  // interface with a required method would break every implementor.
  getCapabilities?(signal?: AbortSignal): Promise<VenueCapabilities>;
  // `POST /solver/register` now (RFC §3.1), renewing the session the
  // authenticated requests carry. A transport registers on its own when it
  // needs a session; this is for a caller that wants the answer (its
  // reputation, its exposure cap) or a refusal up front.
  register?(signal?: AbortSignal): Promise<SolverRegistrationResult>;
  // The venue's FillAttestation for an order this solver filled, or null while
  // there is none (not yet attested, or not this solver's: indistinguishable).
  getAttestation?(orderId: string, signal?: AbortSignal): Promise<FillAttestationWire | null>;
  // `POST /solver/awards/:auctionId/accept`: record this solver's
  // FillAcceptance (SOLVER-RFC §5.3). Answers the acceptance the venue holds,
  // which is the FIRST valid one if several were sent.
  acceptAward?(
    auctionId: string,
    body: { orderId: string; signature: string },
    signal?: AbortSignal,
  ): Promise<FillAcceptanceReceipt>;
  // Subscribe to the feed's gaps (`dropped`/`reset`). `SolverClient` uses it to
  // re-check the venue's RFC version after a `reset` (RFC §12); a transport
  // without it is re-checked only on this solver's own awards. Returns the
  // unsubscribe.
  addFeedGapListener?(listener: (gap: FeedGap) => void): () => void;
  // Subscribe to the entries the feed skipped because their `type` is unknown
  // (`UnknownSolverEventError`): a kind this SDK has never heard of is what a
  // venue redeployed on a newer RFC emits, so `SolverClient` re-checks the
  // venue's RFC version before acting on the next event, as after a `reset`.
  // Call each listener before yielding the next event. Returns the unsubscribe.
  addUnknownEventListener?(listener: (eventType: string) => void): () => void;
}

// The escrow LIFECYCLE as the venue sees it (RFC section 7): lock on open,
// release on proof, void on no-show. Modeled in memory by `StubEscrowGateway`.
// The solver's side of the same boundary -- verify, await final, fill, claim --
// is `OnchainEscrowGateway` (escrow-gateway.ts).
export interface Funds {
  chainId: number;
  token: string;
  amount: string;
}

export interface EscrowGateway {
  lock(
    intentId: string,
    funds: Funds,
    solver: string,
    exclusiveUntil: number,
  ): Promise<{ lockRef: string }>;
  release(intentId: string, proof: FillProof): Promise<void>;
  void(intentId: string): Promise<void>;
}
