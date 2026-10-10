// Zod schemas for the solver wire types, validated at the HTTP boundary (an
// announcement or award arriving off the feed is untrusted input). Consistent
// with the taker SDK's fee-boundary validation.
//
// `.passthrough()` throughout: a newer server may send additive fields, and
// tolerating them is what keeps a version skew from becoming a parse failure.
// Note what that means precisely -- `.passthrough()` RETAINS the unknown keys on
// the parsed object (zod's default `.strip()` is what removes them), so a field
// this SDK does not model is still readable by whoever gets the parsed value.
// Tolerated is not the same as dropped, which is why the two RETIRED
// announcement fields below are deleted explicitly rather than left to the
// object schema.

import { z } from "zod";

import { CANONICAL_BID_SIGNATURE, MAX_BID_MS } from "./bid";

// Digits only, and bounded: every amount on this surface is a uint256 in base
// units, whose decimal ceiling is 78 digits. The server enforces both (a bid
// above it is a 400), and types.ts documents the bound on `BidDraft.output` --
// so validating it here is what makes that documentation true client-side
// instead of a promise the caller only discovers the server keeps.
const amount = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer string (base units)")
  .max(78, "exceeds uint256 (max 78 digits)");

const settlement = z.enum(["public", "stealth", "shielded"]);

// Withdrawn in RFC 0.3.0-draft and deleted from the parsed announcement rather
// than merely unmodelled: `reserveOutput` (the venue's reserve is no longer
// announced) and `trustScore` (no solver use, and it handed the panel the
// taker's fee tier). `.passthrough()` keeps unknown keys, so without this delete
// the withdrawal would be type-level only -- both fields would survive onto the
// object handed to `solver.quote()` and stay readable through a cast.
//
// What the delete is NOT is the withdrawal. This SDK runs in the process of the
// panel member the reserve is withheld FROM, so deleting a key after
// `JSON.parse` only protects a member who chooses not to look: `curl` on the
// feed, a one-line fork of this file, or the `raw` value handed to
// `onInvalidEvent` all still yield `reserveOutput` and `trustScore` while the
// producer sends them, and the Riddler side still sends both today. The
// **enforcement point is the producer** (SOLVER-RFC.md "Migrating from
// `0.2.0-draft`", steps 1-2), and nothing on either side observes whether it
// has stopped: there is no producer-drift probe on `/solver/*` (prod serves no
// solver surface at all -- CLAUDE.md, "Producer-drift probes"). Treat this as
// defence in depth whose absence of enforcement is the point; what it does buy
// is that neither retired key reaches `solver.quote()` through `.passthrough()`
// by accident.
const RETIRED_ANNOUNCEMENT_KEYS = ["reserveOutput", "trustScore"] as const;

export const IntentAnnouncementSchema = z
  .object({
    intentId: z.string(),
    auctionId: z.string(),
    // Signed into every bid (SolverBid v2); zero bytes32 for a non-escrow auction.
    orderId: z.string().regex(/^0x[0-9a-f]{64}$/, "must be 0x + 64 lowercase hex"),
    fromChainId: z.number().int().positive(),
    toChainId: z.number().int().positive(),
    fromToken: z.string(),
    toToken: z.string(),
    swapKind: z.enum(["exact_input", "exact_output"]),
    fromAmount: amount.optional(),
    outputAmount: amount.optional(),
    settlementPreference: settlement,
    // See types.ts: the admissibility floor, not the venue's reserve.
    minOutput: amount,
    opensAt: z.number().int().nonnegative(),
    closesAt: z.number().int().nonnegative(),
    exclusiveWindowMs: z.number().int().nonnegative(),
    recipientCommitment: z.string().optional(),
  })
  .passthrough()
  .transform((announcement) => {
    for (const key of RETIRED_ANNOUNCEMENT_KEYS) delete announcement[key];
    return announcement;
  });

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes (0x + 64 hex)");
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte EVM address");
const signature65 = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte r||s||v signature");
// A uint the venue may still emit as a JSON number (the escrow-fill server
// serializes `fillAuth.deadline` as an integer); normalized to the decimal
// string every other escrow uint is sent as. A non-safe integer is refused: a
// JSON number past 2^53 has already lost precision before it reaches us.
const uintWire = z
  .union([amount, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => String(v));

export const AwardDestOpeningSchema = z
  .object({
    recipient: z.string().min(1),
    toToken: z.string().min(1),
    toAmount: amount,
    blinding: hex32,
    intentId: z.string().min(1),
  })
  .passthrough();

export const AwardFillAuthSchema = z
  .object({
    fillId: hex32.optional(),
    filler: evmAddress.optional(),
    to: evmAddress.optional(),
    token: evmAddress.optional(),
    amount: amount.optional(),
    deadline: uintWire.optional(),
    chainId: uintWire.optional(),
    fillerContract: evmAddress.optional(),
    signature: signature65.optional(),
  })
  .passthrough();

export const AwardOrderTermsSchema = z
  .object({
    depositor: evmAddress,
    fromChainId: uintWire,
    fromToken: evmAddress,
    fromAmount: amount,
    toChainId: uintWire,
    fillDeadline: uintWire,
    escrow: evmAddress,
    destCommitment: hex32,
  })
  .passthrough();

// Lenient on PRESENCE (an award without the fill fields still parses, so the
// feed keeps delivering it) and strict on SHAPE (a field that is present must
// be well-formed). `requireFillableEscrow` is what insists on presence.
export const AwardEscrowSchema = z
  .object({
    address: z.string(),
    intentRef: z.string(),
    fillId: hex32.optional(),
    destOpening: AwardDestOpeningSchema.optional(),
    fillAuth: AwardFillAuthSchema.optional(),
    orderTerms: AwardOrderTermsSchema.optional(),
    payee: evmAddress.optional(),
    bond: z.object({ chainId: uintWire, address: evmAddress }).passthrough().optional(),
    acceptBy: uintWire.optional(),
  })
  .passthrough();

export const FillAcceptanceReceiptSchema = z
  .object({
    auctionId: z.string(),
    orderId: hex32,
    signature: signature65,
    acceptedAt: z.number().int().nonnegative(),
  })
  .passthrough();

export const AwardSchema = z
  .object({
    auctionId: z.string(),
    intentId: z.string(),
    solverId: z.string(),
    output: amount,
    exclusiveUntil: z.number().int().nonnegative(),
    escrow: AwardEscrowSchema.optional(),
  })
  .passthrough();

export const FillAttestationWireSchema = z
  .object({
    orderId: hex32,
    payee: evmAddress,
    signature: signature65,
    proof: z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed bytes"),
    verifier: evmAddress,
    chainId: uintWire,
  })
  .passthrough();

export const SolverEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("announcement"), announcement: IntentAnnouncementSchema }),
  z.object({ type: z.literal("award"), award: AwardSchema }),
]);

const fillProof = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tx_hash"),
    chainId: z.number().int().positive(),
    txHash: z.string(),
  }),
  z.object({ kind: z.literal("oracle_attestation"), attestation: z.string(), signer: z.string() }),
  z.object({ kind: z.literal("light_client"), header: z.string(), proof: z.string() }),
  z.object({ kind: z.literal("zk"), proof: z.string(), publicInputs: z.array(z.string()) }),
]);

export const BidSchema = z
  .object({
    auctionId: z.string(),
    intentId: z.string(),
    solverId: z.string(),
    // Wider than `solver-bid-v2.schema.json`'s `output` on purpose, and the only place
    // the two artifacts differ. This is a READ path: it admits the server's own
    // rule (`\A\d+\z`), so a `007` bid the server already admitted parses and
    // `verifyBidDetailed` can report it as `non_canonical` -- signature
    // genuine, spelling refused -- instead of it failing as an unreadable
    // shape. The SIGNER (`bidTypedData`) holds to the canonical spelling the
    // published schema declares, because a producer must not emit two wire
    // strings for one digest.
    output: amount,
    orderId: z.string().regex(/^0x[0-9a-f]{64}$/, "must be 0x + 64 lowercase hex"),
    // Bounded by `MAX_BID_MS`, not by the struct's `uint64`: the wire spelling
    // is a bare JSON number, so a value past 2^53-1 cannot be read back
    // exactly, and the signer refuses it.
    validUntilMs: z.number().int().nonnegative().max(MAX_BID_MS),
    minExclusiveMs: z.number().int().nonnegative().max(MAX_BID_MS),
    // The one encoding this protocol defines, derived from `bid.ts` rather than
    // retyped: `solver-bid-v2.schema.json` declares this pattern and `verifyBidDetailed`
    // refuses anything else, and a third copy of the regex is how the three
    // stop agreeing. Unlike `output` this is NOT a read path widened to the
    // server's rule -- `z.string()` alone let the EIP-2098 compact form and
    // uppercase hex parse, and both then verified, so one seal had three
    // admissible spellings on the wire.
    signature: z
      .string()
      .regex(CANONICAL_BID_SIGNATURE, "must be 0x + 130 lowercase hex digits (65-byte r||s||v)"),
  })
  .passthrough();

export const FillReceiptSchema = z
  .object({
    auctionId: z.string(),
    intentId: z.string(),
    solverId: z.string(),
    proof: fillProof,
  })
  .passthrough();

// The venue's self-description at `GET /solver/capabilities` (RFC §12). Only
// `rfcVersion` is required, and only that one is load-bearing: §12 makes it the
// gate ("a venue that does not advertise `rfcVersion` cannot be bid into by a
// conformant solver"), while `phase` is a SHOULD. Requiring `phase` here made a
// spec-conformant `200 {"rfcVersion":"0.3.0-draft"}` fail this parse inside
// `HttpSolverTransport.getCapabilities`, which `SolverClient` then reported as
// the venue never having answered -- sending the operator to debug routing
// against a venue that answered correctly. The rest is advisory metadata that
// may grow.
export const VenueCapabilitiesSchema = z
  .object({
    rfcVersion: z.string(),
    phase: z.string().optional(),
    auction: z
      .object({
        model: z.string().optional(),
        settleRule: z.string().optional(),
        windowMs: z.number().int().nonnegative().optional(),
        exclusiveWindowMs: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    admission: z
      .object({
        model: z.string().optional(),
        panelSize: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    chains: z.array(z.number().int().positive()).optional(),
    settlementTypes: z.array(settlement).optional(),
  })
  .passthrough();

// The feed batch envelope. `dropped` and `reset` are what tell a reader it
// missed announcements; modeling them here is what stops them being silently
// dropped on the floor by a destructure.
export const FeedBatchSchema = z
  .object({
    events: z.array(z.unknown()),
    cursor: z.string(),
    dropped: z.number().int().nonnegative().optional(),
    reset: z.boolean().optional(),
  })
  .passthrough();

// Parse + validate a raw feed event. Throws (zod) on a malformed shape -- the
// caller at the boundary MUST NOT swallow it.
export function parseSolverEvent(raw: unknown) {
  return SolverEventSchema.parse(raw);
}
