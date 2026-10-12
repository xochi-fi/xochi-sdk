// Bid sealing/signing: EIP-712 typed data. A solver signs over the bid's
// binding fields so the auctioneer can attribute an award to the recovered
// signer, and the solver cannot later repudiate a winning price.
//
// EIP-712, not a `personal_sign` over a JSON string, for two reasons:
//
//   1. Domain separation. A signature over bare JSON is valid for any other
//      protocol that asks the same key to personal_sign the same shape;
//      EIP-712 binds the digest to (name, version) and the struct's type hash.
//   2. Parity without ESCAPING. Riddler cannot reuse `JSON.stringify` (Elixir
//      map order is not JS insertion order), so JSON parity would rest on two
//      encoders escaping quotes, backslashes, control characters and
//      astral-plane codepoints identically. Under EIP-712 a string member is
//      `keccak256(utf8_bytes)` -- there is no escaping to disagree about.
//
// Drift still does not fail loudly: it surfaces as every honest bid being
// rejected, because the recovered signer stops matching the claimed one. The
// digests are pinned by `@xochi/spec`'s `conformance/solver-bid-v2.json`, which
// both sides are held to, so a change here fails there rather than in production.

import { ethers } from "ethers";
import type { IntentAnnouncement, BidDraft, Bid } from "./types";

// The EIP-712 domain. Pinned client-side and never read off the wire.
//
// No `verifyingContract`: nothing verifies a bid on-chain -- the venue
// ecrecovers off-chain (SOLVER-RFC.md §5.1). No `chainId`: a bid prices a
// cross-chain intent, so there is no single chain it belongs to. `version` is
// the SEALING SCHEME's version, bumped when these bytes change.
//
// Version "2" binds the escrow `orderId`, which hashes the escrow address and
// origin chain id, so an escrow bid is deployment-scoped by its own content. A
// non-escrow auction announces the zero orderId: such a bid is never awardable.
export const SOLVER_BID_DOMAIN: ethers.TypedDataDomain = {
  name: "RiddlerSolver",
  version: "2",
};

export const SOLVER_BID_PRIMARY_TYPE = "SolverBid";

// v2 (SOLVER-RFC §5.1). The bid is the solver's signed demand on the award:
//
//   `validUntilMs`   ABSOLUTE unix ms. The bid stands only until then; the
//                    escrow node refuses a `:winner` FillAuth past it.
//   `minExclusiveMs` the shortest exclusive fill window the solver accepts. The
//                    escrow node computes the winner deadline itself and
//                    refuses `:winner` (the reserve fills) if it cannot grant it.
//
// Together with `orderId` these are what a slash rests on (ESCROW-RFC §6): a
// venue cannot award an order the solver did not bid on, nor shrink the window
// it demanded. `uint64` members; the admissible range is 0..2^53-1 because the
// wire spelling is a bare JSON number (`MAX_BID_MS`).
export const SOLVER_BID_TYPES: Record<string, ethers.TypedDataField[]> = {
  SolverBid: [
    { name: "orderId", type: "bytes32" },
    { name: "auctionId", type: "string" },
    { name: "intentId", type: "string" },
    { name: "output", type: "uint256" },
    { name: "validUntilMs", type: "uint64" },
    { name: "minExclusiveMs", type: "uint64" },
  ],
};

export const SOLVER_BID_TYPE =
  "SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)";

// The orderId a non-escrow auction announces. A bid over it is never awardable.
export const ZERO_ORDER_ID = "0x" + "00".repeat(32);

// The signed struct. `output` stays a decimal string (it does not fit a
// float64) and is coerced to uint256 by the encoder.
export interface SolverBidMessage {
  orderId: string;
  auctionId: string;
  intentId: string;
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
}

export interface SolverBidTypedData {
  domain: ethers.TypedDataDomain;
  types: Record<string, ethers.TypedDataField[]>;
  primaryType: string;
  message: SolverBidMessage;
}

// Canonical decimal: no leading zeros, no sign, no whitespace. The server's own
// check is `\A\d+\z`, which admits `007` -- one uint256, two wire spellings,
// one digest. Refusing the non-canonical spelling keeps "what was signed" and
// "what was sent" in bijection.
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const BYTES32 = /^0x[0-9a-f]{64}$/;

// The widest `validUntilMs` / `minExclusiveMs` this scheme admits: 2^53-1. The
// struct member is `uint64`, but a bare JSON number past 2^53-1 cannot be read
// back exactly, so it is refused rather than rounded into the digest.
export const MAX_BID_MS = Number.MAX_SAFE_INTEGER;

// The server's own admissibility rule for `output` (`\A\d+\z`), which admits
// `007`. Used only by the VERIFIER: a bid spelled that way is one the server
// admitted, and its signature is genuine over the same uint256, so the verifier
// has to reach the recovery step before it can report the spelling separately.
// The signer holds to CANONICAL_UINT instead.
const SERVER_UINT = /^\d+$/;

// The one signature encoding this protocol defines: `0x` followed by 130
// LOWERCASE hex digits, i.e. 65 bytes of `r || s || v`. SOLVER-RFC.md §5.1
// states it and `conformance/solver-bid-v2.schema.json`'s vector `signature`
// declares this exact pattern; exported so `schema.ts` derives its check from
// it rather than retyping the regex, because a second copy is how two
// artifacts that must agree stop agreeing.
//
// A seal must have exactly ONE admissible spelling. ethers 6 recovers the
// same signer from the 132-char form, its 130-char EIP-2098 `compactSerialized`
// twin and the same bytes uppercased (only the high-s twin is refused), so
// without this an auctioneer keying per-solver-per-window idempotency or
// attribution on the signature bytes (the only per-bid unique value it has)
// sees one seal as three distinct admissible bids.
export const CANONICAL_BID_SIGNATURE = /^0x[0-9a-f]{130}$/;

// An unpaired UTF-16 surrogate: a JS-only string that has no UTF-8 encoding.
// Left to `ethers.toUtf8Bytes` this depends on a default error handler, and a
// handler that substitutes U+FFFD would hash bytes the server can never
// produce (Elixir strings are UTF-8 binaries and cannot hold a lone
// surrogate), turning an unencodable id into a digest mismatch nobody can
// explain. Refused here instead, beside the other refusals.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The solver id is the address of the solver key. Distinct from any hot wallet.
export function solverIdFromKey(solverKey: string): string {
  return walletFromKey(solverKey).address;
}

// `new ethers.Wallet` on a malformed key throws an error quoting the key, which
// a top-level handler then prints. Name the problem, never the value.
export function walletFromKey(solverKey: string): ethers.Wallet {
  try {
    return new ethers.Wallet(solverKey);
  } catch {
    throw new Error(
      "solver key must be a 0x-prefixed 32-byte private key (0x + 64 hex digits); value not shown",
    );
  }
}

function checkMs(label: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_BID_MS) {
    throw new Error(
      `bid ${label} must be an integer in 0..${MAX_BID_MS} (2^53-1), got ${String(v)}`,
    );
  }
  return v;
}

// Build the typed data a bid signs over. Validates rather than normalizes: a
// signer that quietly rewrites its input signs something the caller did not ask
// for, and the caller then reports the value it thought it sent.
export function bidTypedData(fields: {
  orderId: string;
  auctionId: string;
  intentId: string;
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
}): SolverBidTypedData {
  const { orderId, auctionId, intentId, output } = fields;
  if (typeof orderId !== "string" || !BYTES32.test(orderId)) {
    throw new Error(`bid orderId must be 0x + 64 lowercase hex, got ${JSON.stringify(orderId)}`);
  }
  if (typeof auctionId !== "string") throw new Error("bid auctionId must be a string");
  if (typeof intentId !== "string") throw new Error("bid intentId must be a string");
  if (LONE_SURROGATE.test(auctionId))
    throw new Error("bid auctionId has an unpaired surrogate; not UTF-8 encodable");
  if (LONE_SURROGATE.test(intentId))
    throw new Error("bid intentId has an unpaired surrogate; not UTF-8 encodable");
  if (typeof output !== "string" || !CANONICAL_UINT.test(output)) {
    throw new Error(
      `bid output must be a canonical decimal uint256 string, got ${JSON.stringify(output)}`,
    );
  }
  if (BigInt(output) > MAX_UINT256) throw new Error(`bid output ${output} exceeds uint256`);
  const validUntilMs = checkMs("validUntilMs", fields.validUntilMs);
  const minExclusiveMs = checkMs("minExclusiveMs", fields.minExclusiveMs);

  return {
    domain: SOLVER_BID_DOMAIN,
    types: SOLVER_BID_TYPES,
    primaryType: SOLVER_BID_PRIMARY_TYPE,
    message: { orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs },
  };
}

// The EIP-712 digest ecrecover consumes: keccak256(0x1901 || domainSeparator ||
// hashStruct(message)).
export function bidDigest(fields: Parameters<typeof bidTypedData>[0]): string {
  const { domain, types, message } = bidTypedData(fields);
  return ethers.TypedDataEncoder.hash(domain, types, message);
}

// Seal + sign a draft into a wire `Bid`. The orderId is the announcement's
// (zero for a non-escrow auction), never the solver's own choice.
export async function signBid(
  wallet: ethers.Wallet,
  announcement: IntentAnnouncement,
  draft: BidDraft,
): Promise<Bid> {
  const fields = {
    orderId: announcement.orderId,
    auctionId: announcement.auctionId,
    intentId: announcement.intentId,
    output: draft.output,
    validUntilMs: draft.validUntilMs,
    minExclusiveMs: draft.minExclusiveMs,
  };
  const { domain, types, message } = bidTypedData(fields);
  const signature = ethers.Signature.from(
    await wallet.signTypedData(domain, types, message),
  ).serialized.toLowerCase();
  return { ...fields, solverId: wallet.address, signature };
}

// Why a bid did not verify. The two classes are kept apart because an
// auctioneer MUST route them differently (RFC §5.1's typed rejections), and
// collapsing them into one boolean mislabels a body defect as a crypto one:
//
//   `bad_signature` / `signer_mismatch` -- the bid is NOT attributable to the
//     claimed `solverId` in the encoding this protocol defines. This is the
//     identity failure (403). Act on it: the bid cannot be admitted and cannot
//     be held against anyone. `bad_signature` covers both a signature that
//     recovers to nobody and one whose BYTES are a re-spelling of a genuine
//     seal (`CANONICAL_BID_SIGNATURE`); the note in `verifyBidDetailed` says
//     why a re-spelled signature is not the `non_canonical` case a re-spelled
//     `output` is.
//   `non_canonical` -- the signature IS genuine and the recovered signer IS the
//     claimed one; only the wire spelling of `output` is refused (400 malformed
//     body). An auctioneer MUST NOT report this as a signature failure: `007`
//     and `7` are the same uint256 and therefore the same digest, so the solver
//     is bound to that price and reporting 403 would hand it a repudiation
//     lever ("your own SDK says my bid was not signed").
//   `unencodable` -- the fields cannot be hashed at all (a lone surrogate, a
//     non-numeric `output`, a malformed orderId, a time past `MAX_BID_MS`), so no digest
//     exists to verify against. Also 400, and no signer is claimed either way.
export type BidVerification =
  | { ok: true; reason: "verified"; signer: string }
  | { ok: false; reason: "unencodable"; signer: null; detail: string }
  | { ok: false; reason: "bad_signature"; signer: null; detail: string }
  | { ok: false; reason: "signer_mismatch"; signer: string; detail: string }
  | { ok: false; reason: "non_canonical"; signer: string; detail: string };

// Verify a bid and report WHY, for the caller that has to answer with a status
// code. The auctioneer MUST run this (RFC §5.1); exposed here so a stub
// auctioneer / test can too.
//
// Verification is against the bid AS RECEIVED, with `output` coerced to its
// canonical decimal before hashing -- not against the subset of bids this SDK
// would agree to SIGN. Those are different questions: answering the second
// under the first's name reports a server-admitted `007` bid as unsigned.
export function verifyBidDetailed(bid: Bid): BidVerification {
  if (typeof bid.output !== "string" || !SERVER_UINT.test(bid.output)) {
    return {
      ok: false,
      reason: "unencodable",
      signer: null,
      detail: `output ${JSON.stringify(bid.output)} is not a decimal integer string`,
    };
  }

  let typedData: SolverBidTypedData;
  const canonicalOutput = BigInt(bid.output).toString();
  try {
    typedData = bidTypedData({ ...bid, output: canonicalOutput });
  } catch (err) {
    return {
      ok: false,
      reason: "unencodable",
      signer: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Refuse a re-spelled signature BEFORE recovery: the 64-byte EIP-2098
  // compact form and non-lowercase hex both recover fine in ethers and are not
  // the encoding this protocol defines (see CANONICAL_BID_SIGNATURE).
  //
  // `bad_signature`, not `non_canonical`: `non_canonical` asserts the
  // signature is genuine and the recovered signer IS the claimed one (which
  // this check cannot produce without recovering through the encoding it
  // refuses), and is a 400 because `007` and `7` are one uint256 -- the bid
  // was admitted and the solver IS bound. Neither holds here: this bid is
  // refused, so there is no award to repudiate, and attribution is defined
  // over 65-byte lowercase `r || s || v`, so bytes in another spelling are not
  // a signature it can attribute to anyone. Grading it a body defect would
  // also invite the auctioneer to correct the body and admit it, the second
  // admissible bid this refusal exists to remove. The malleated high-s twin
  // lands on `bad_signature` one branch down and is the same hazard.
  //
  // Refused, never normalized: lowercasing a signature or expanding a compact
  // one here would make this SDK the thing that manufactures the second
  // admissible spelling.
  if (typeof bid.signature !== "string" || !CANONICAL_BID_SIGNATURE.test(bid.signature)) {
    // The bytes themselves are never echoed -- an auctioneer routes this into a
    // response body and a log. The shape is what tells a solver what to fix.
    const shape =
      typeof bid.signature !== "string"
        ? `is a ${typeof bid.signature}, not a string`
        : /^0x[0-9a-fA-F]{128}$/.test(bid.signature)
          ? "is 64 bytes, the EIP-2098 compact form"
          : /^0x[0-9a-fA-F]{130}$/.test(bid.signature)
            ? "is not lowercase"
            : `is ${bid.signature.length} characters`;
    return {
      ok: false,
      reason: "bad_signature",
      signer: null,
      detail:
        `signature ${shape}; this protocol admits only 0x followed by 130 lowercase hex digits ` +
        "(65-byte r||s||v, RFC §5.1). Refused rather than normalized: one seal has one admissible " +
        "spelling, so re-serialize the signature at the source",
    };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      bid.signature,
    );
  } catch (err) {
    // Includes the malleated high-s twin: ethers refuses to read a
    // non-canonical `s` at all, so it never reaches a recovered address.
    return {
      ok: false,
      reason: "bad_signature",
      signer: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (recovered.toLowerCase() !== String(bid.solverId).toLowerCase()) {
    return {
      ok: false,
      reason: "signer_mismatch",
      signer: recovered,
      detail: `signature recovers to ${recovered}, bid claims ${String(bid.solverId)}`,
    };
  }
  if (!CANONICAL_UINT.test(bid.output)) {
    return {
      ok: false,
      reason: "non_canonical",
      signer: recovered,
      detail: `output ${JSON.stringify(bid.output)} is not canonical decimal; it hashes as ${canonicalOutput}, which is the number the signature commits to`,
    };
  }
  return { ok: true, reason: "verified", signer: recovered };
}

// The yes/no form, for a caller that only wants admissibility: true iff the
// signature recovers to the claimed `solverId` AND the wire fields are the
// canonical spelling of what was signed. A caller that has to REPORT the
// failure should use `verifyBidDetailed` instead -- see the note above on which
// reason is an identity failure and which is a body defect.
export function verifyBid(bid: Bid): boolean {
  return verifyBidDetailed(bid).ok;
}
