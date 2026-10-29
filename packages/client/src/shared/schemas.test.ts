/**
 * Quote/Execute wire contract tests.
 *
 * Pins the canonical snake_case agent contract (mirrored in
 * public/openapi.yaml) so it cannot silently drift back to camelCase, and
 * guards the signature-safety invariant: the `eip712` value passes through
 * verbatim, with its EIP-712 standard keys (camelCase) intact.
 */

import { describe, it, expect } from "vitest";
import {
  ExecuteResponseSchema,
  FeeBreakdownSchema,
  QuoteResponseSchema,
  recipientAddress,
  REFERRAL_NEUTRAL_NOTE,
} from "./schemas.js";

const INTENT_ID = "xi_3a94fb5a37cf16d62a3799b359c20428";
const QUOTE_ID = "xq_4ae6611fd08313507696cb2b834cc229";

const eip712 = {
  domain: {
    name: "Xochi",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x1111111111111111111111111111111111111111",
  },
  types: {
    Intent: [
      { name: "intentId", type: "string" },
      { name: "wallet", type: "address" },
    ],
  },
  primaryType: "Intent",
  message: { intentId: "abc", wallet: "0x2222222222222222222222222222222222222222" },
};

const pullAuthorization = {
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  types: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: {
    from: "0x2222222222222222222222222222222222222222",
    to: "0x3333333333333333333333333333333333333333",
    value: "1000000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: "0x" + "0".repeat(64),
  },
};

const permit2PullAuthorization = {
  domain: {
    name: "Permit2",
    chainId: 8453,
    verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  types: {
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "OriginPullWitness" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    OriginPullWitness: [{ name: "orderId", type: "bytes32" }],
  },
  primaryType: "PermitWitnessTransferFrom",
  message: {
    permitted: {
      token: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      amount: "1000000",
    },
    spender: "0x3333333333333333333333333333333333333333",
    nonce: "0",
    deadline: "1793289630",
    witness: { orderId: "0x" + "ab".repeat(32) },
  },
};

const canonicalQuote = {
  success: true,
  intent_id: INTENT_ID,
  quote_id: QUOTE_ID,
  can_solve: true,
  to_amount: "1000000",
  min_to_amount: "995000",
  xochi_fee: "2000",
  xochi_fee_rate: "0.20%",
  estimated_gas_cost: "0.12",
  expiry: "2026-06-21T13:00:30.000Z",
  gasless: true,
  payment_method: "erc3009",
  route: { hops: 1 },
  eip712,
  settlement_options: [{ type: "public", available: true }],
};

// A fully-populated fee_breakdown exactly as Riddler emits it (snake_case wire
// shape, economics.md Part 1). Real values from a Base->Arbitrum USDC standard-tier
// quote: 1000 USDC in, 22 bps (8 solver / 6 venue / 8 routing), no price impact.
// gas_floor is the live network minimum (fill_cost x 1.3), independent of the bps
// layers.
const feeBreakdown = {
  tier: "standard",
  asset_class: "stable",
  gas_floor: { amount: "22664", usd: "0.022663" },
  solver_fee_bps: 8,
  solver_fee: "800000",
  price_impact_bps: 0,
  price_impact: "0",
  venue_fee_bps: 6,
  venue_fee: "600000",
  routing_fee_bps: 8,
  routing_fee: "800000",
  total_bps: 22,
  total_fee: "2200000",
  total_usd: "2.200000",
  surplus_share_pct: 15,
};

describe("QuoteResponseSchema (snake_case wire contract)", () => {
  it("accepts the canonical snake_case response", () => {
    expect(QuoteResponseSchema.safeParse(canonicalQuote).success).toBe(true);
  });

  it("accepts a named referral", () => {
    const r = QuoteResponseSchema.safeParse({
      ...canonicalQuote,
      referral: { code: "ALICE", name: "Alice" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts the neutral referral line", () => {
    const parsed = QuoteResponseSchema.parse({
      ...canonicalQuote,
      referral: { neutral: true, note: REFERRAL_NEUTRAL_NOTE },
    });
    expect(parsed.referral).toEqual({ neutral: true, note: REFERRAL_NEUTRAL_NOTE });
  });

  it("rejects a neutral referral with another note, a false flag, or mixed keys", () => {
    for (const referral of [
      { neutral: true, note: "Someone earns a fee." },
      { neutral: false, note: REFERRAL_NEUTRAL_NOTE },
      { neutral: true, note: REFERRAL_NEUTRAL_NOTE, code: "ALICE" },
      { code: "ALICE", name: "Alice", neutral: true },
    ]) {
      expect(QuoteResponseSchema.safeParse({ ...canonicalQuote, referral }).success).toBe(false);
    }
  });

  it("preserves eip712 standard keys verbatim (signature safety)", () => {
    const parsed = QuoteResponseSchema.parse(canonicalQuote);
    expect(parsed.eip712?.domain.chainId).toBe(8453);
    expect(parsed.eip712?.domain.verifyingContract).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(parsed.eip712?.primaryType).toBe("Intent");
  });

  it("rejects the legacy camelCase response shape", () => {
    const camel = {
      success: true,
      intentId: "11111111-1111-1111-1111-111111111111",
      quoteId: "22222222-2222-2222-2222-222222222222",
      canSolve: true,
      expiry: "2026-06-21T13:00:30.000Z",
    };
    expect(QuoteResponseSchema.safeParse(camel).success).toBe(false);
  });

  it("allows an unsolvable quote to omit eip712/to_amount/payment_method", () => {
    const unsolvable = {
      success: true,
      intent_id: INTENT_ID,
      quote_id: QUOTE_ID,
      can_solve: false,
      expiry: "2026-06-21T13:00:30.000Z",
      error: "no_route",
    };
    expect(QuoteResponseSchema.safeParse(unsolvable).success).toBe(true);
  });

  it("rejects an unknown payment_method", () => {
    expect(
      QuoteResponseSchema.safeParse({ ...canonicalQuote, payment_method: "venmo" }).success,
    ).toBe(false);
  });

  it("accepts a pull_authorization and preserves its eip712 keys verbatim", () => {
    const withPull = { ...canonicalQuote, pull_authorization: pullAuthorization };
    const result = QuoteResponseSchema.safeParse(withPull);
    expect(result.success).toBe(true);
    const parsed = QuoteResponseSchema.parse(withPull);
    expect(parsed.pull_authorization?.primaryType).toBe("ReceiveWithAuthorization");
    expect(parsed.pull_authorization?.domain.verifyingContract).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });

  it("accepts Permit2 typed data whose domain omits version", () => {
    const withPull = { ...canonicalQuote, pull_authorization: permit2PullAuthorization };
    const result = QuoteResponseSchema.safeParse(withPull);
    expect(result.success).toBe(true);
    const parsed = QuoteResponseSchema.parse(withPull);
    expect(parsed.pull_authorization).toEqual(permit2PullAuthorization);
    expect(parsed.pull_authorization?.domain.version).toBeUndefined();
  });

  it("preserves the versioned XochiIntent v3 domain", () => {
    const versionedIntent = {
      ...eip712,
      domain: {
        name: "Xochi",
        version: "3-prod",
        chainId: 8453,
        salt: "0x" + "cd".repeat(32),
      },
      primaryType: "XochiIntent",
    };
    const parsed = QuoteResponseSchema.parse({ ...canonicalQuote, eip712: versionedIntent });
    expect(parsed.eip712).toEqual(versionedIntent);
  });
});

describe("FeeBreakdownSchema (itemized layer split from Riddler)", () => {
  it("accepts the populated snake_case fee_breakdown", () => {
    expect(FeeBreakdownSchema.safeParse(feeBreakdown).success).toBe(true);
  });

  it("rides on a solvable QuoteResponse and passes through gas_floor.usd", () => {
    const withBreakdown = { ...canonicalQuote, fee_breakdown: feeBreakdown };
    expect(QuoteResponseSchema.safeParse(withBreakdown).success).toBe(true);
    expect(QuoteResponseSchema.parse(withBreakdown).fee_breakdown?.gas_floor.usd).toBe("0.022663");
  });

  // The layer amounts carry no denomination of their own, so the token they are
  // measured in has to be stated beside them, never inferred from the mere
  // presence of `fee_breakdown`.
  it("carries the fee denomination as a sibling of fee_breakdown", () => {
    const withDenomination = {
      ...canonicalQuote,
      fee_breakdown: feeBreakdown,
      fee_denomination: "origin",
    };
    expect(QuoteResponseSchema.parse(withDenomination).fee_denomination).toBe("origin");
    expect(
      QuoteResponseSchema.safeParse({ ...withDenomination, fee_denomination: "destination" })
        .success,
    ).toBe(true);
    // Closed vocabulary: these two spellings and nothing else.
    expect(
      QuoteResponseSchema.safeParse({ ...withDenomination, fee_denomination: "input" }).success,
    ).toBe(false);
  });

  // Absent means unknown, never a silent default to origin.
  it("stays optional so an absent denomination is representable", () => {
    expect(QuoteResponseSchema.parse(canonicalQuote).fee_denomination).toBeUndefined();
  });

  it("accepts an ACP-origin split with the routing layer zeroed", () => {
    // ACP intents already pay the 8-bps Raxol routing cut via the job budget, so
    // Riddler drops the routing layer: routing_fee_bps 0, total 22 -> 14 bps.
    const acp = {
      ...feeBreakdown,
      routing_fee_bps: 0,
      routing_fee: "0",
      total_bps: 14,
      total_fee: "1400000",
      total_usd: "1.400000",
    };
    expect(FeeBreakdownSchema.safeParse(acp).success).toBe(true);
  });

  // The five layer amounts are base-unit integers, and every consumer feeds them
  // straight to `BigInt` to reconcile the parts against `total_fee`; a bare
  // string would parse clean and then throw (or, for "", read as 0n and itemize
  // a free trade). The producer emits `Integer.to_string` of a non-negative
  // integer for all five, so the digits-only rule describes what is served.
  it.each(["0.5", "", "1.2e3", "abc", "-5", "0x10", " 100"])(
    "rejects a layer amount that is not base units (%s)",
    (bad) => {
      for (const field of ["solver_fee", "price_impact", "venue_fee", "routing_fee", "total_fee"]) {
        expect(FeeBreakdownSchema.safeParse({ ...feeBreakdown, [field]: bad }).success).toBe(false);
      }
    },
  );

  it("rejects a fee_breakdown missing gas_floor (drift caught)", () => {
    const noFloor: Record<string, unknown> = { ...feeBreakdown };
    delete noFloor.gas_floor;
    expect(FeeBreakdownSchema.safeParse(noFloor).success).toBe(false);
  });

  it("rejects a camelCase fee_breakdown (snake_case wire contract)", () => {
    const camel = {
      tier: "standard",
      assetClass: "stable",
      gasFloor: { amount: "22664", usd: "0.022663" },
      solverFeeBps: 8,
    };
    expect(FeeBreakdownSchema.safeParse(camel).success).toBe(false);
  });
});

describe("ExecuteResponseSchema (snake_case wire contract)", () => {
  it("accepts the canonical snake_case execute response", () => {
    const exec = {
      success: true,
      intent_id: INTENT_ID,
      status: "executing",
      tx_hash: "0xdeadbeef",
    };
    expect(ExecuteResponseSchema.safeParse(exec).success).toBe(true);
  });

  it("rejects the legacy camelCase execute response", () => {
    const camel = { success: true, intentId: "x", status: "executing", txHash: "0x" };
    expect(ExecuteResponseSchema.safeParse(camel).success).toBe(false);
  });

  it("accepts per-leg hashes and the in-doubt reconciling flag", () => {
    const exec = {
      success: true,
      intent_id: INTENT_ID,
      status: "executing",
      tx_hash: "0xorigin",
      receiving_tx_hash: "0xfill",
      bridge_tx_hash: "0xbridge",
      reconciling: true,
    };
    expect(ExecuteResponseSchema.safeParse(exec).success).toBe(true);
  });
});

describe("QuoteResponseSchema (unsolvable + unavailable branches)", () => {
  it("unsolvable-200 carries error_category + detail + empty settlement_options", () => {
    const body = {
      success: true,
      intent_id: INTENT_ID,
      quote_id: QUOTE_ID,
      can_solve: false,
      expiry: "2026-06-21T13:00:30.000Z",
      error: "Amount below the solver minimum.",
      error_category: "below_minimum",
      detail: "min_notional_usd:1",
      settlement_options: [],
    };
    expect(QuoteResponseSchema.safeParse(body).success).toBe(true);
  });

  it("unavailable-503 body (success:false, empty options)", () => {
    const body = {
      success: false,
      intent_id: INTENT_ID,
      quote_id: QUOTE_ID,
      can_solve: false,
      expiry: "2026-06-21T13:00:30.000Z",
      error: "Solver temporarily unavailable",
      settlement_options: [],
    };
    expect(QuoteResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects an unknown key on the quote response (strict)", () => {
    const body = {
      success: true,
      intent_id: INTENT_ID,
      quote_id: QUOTE_ID,
      can_solve: false,
      expiry: "2026-06-21T13:00:30.000Z",
      bogus: true,
    };
    expect(QuoteResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("ExecuteResponseSchema (success + 502 failed branches)", () => {
  it("failed-502 body (success:false + intent_id + status + error)", () => {
    const body = {
      success: false,
      intent_id: INTENT_ID,
      status: "failed",
      error: "solver rejected",
    };
    expect(ExecuteResponseSchema.safeParse(body).success).toBe(true);
  });

  it("settling-200 body (reconciling, note_commitment/stealth fields)", () => {
    const body = {
      success: false,
      intent_id: INTENT_ID,
      status: "settling",
      tx_hash: "0xorigin",
      reconciling: true,
      note_commitment: "0xnote",
      error: "settlement_pending",
    };
    expect(ExecuteResponseSchema.safeParse(body).success).toBe(true);
  });
});

// Non-EVM (Tron) surface of the response contract (from schemas.tron.test.ts).

const TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
const TRON_RECIPIENT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const EVM_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC

describe("recipientAddress", () => {
  it("accepts EVM and Tron addresses", () => {
    expect(recipientAddress.safeParse(EVM_USDC).success).toBe(true);
    expect(recipientAddress.safeParse(TRON_RECIPIENT).success).toBe(true);
  });
});

describe("QuoteResponseSchema (deposit route)", () => {
  const base = {
    success: true,
    intent_id: "xi_c49d01385d818f83d599a6a9786def99",
    quote_id: "xq_cd23a3e99facd99790fcefaa9ad1f102",
    can_solve: true,
    expiry: "2030-01-01T00:00:00Z",
  };

  it("accepts deposit_address + deposit_attestation + deposit_deadline", () => {
    const result = QuoteResponseSchema.safeParse({
      ...base,
      deposit_address: TRON_USDC,
      deposit_attestation: "0x" + "ab".repeat(65),
      deposit_deadline: 1893456000,
    });
    expect(result.success).toBe(true);
  });

  // The response echoes the destination recipient for non-EVM routes and must
  // preserve the base58 value verbatim (never lowercased) for the client's
  // fail-closed echo assertion.
  it("preserves a recipient_address echo verbatim", () => {
    const result = QuoteResponseSchema.safeParse({ ...base, recipient_address: TRON_RECIPIENT });
    expect(result.success).toBe(true);
    expect(result.success && result.data.recipient_address).toBe(TRON_RECIPIENT);
  });
});
