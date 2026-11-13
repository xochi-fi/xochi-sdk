// The live escrow path (SPEC.md §2.3/§5.2, ESCROW-RFC.md §7): `assertEscrowQuoteMatchesRequest`
// over a served Base USDC -> Canton Coin quote. Every refusal case re-seals the venue's side
// (destCommitment, orderId, pull nonce, OpenAuth) around one tampered field, so the guard has
// to catch the tamper itself rather than a stale hash. Keys are throwaway test keys.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import {
  CANTON_COIN_MAINNET,
  CANTON_COIN_TESTNET,
  CANTON_MAINNET_CHAIN_ID,
  CANTON_TESTNET_CHAIN_ID,
  assertCantonDestination,
  assertEscrowQuoteMatchesRequest,
  assertPullMatchesIntent,
  computeDestCommitment,
  computeOrderId,
  signOpenAuth,
  XochiIntentMismatchError,
  type DestOpening,
  type EscrowQuoteOptions,
  type OrderTerms,
  type QuoteRequestParams,
} from "../src";

const OPEN_AUTH_KEY = new ethers.Wallet(ethers.id("xochi-sdk/test/open-auth-a"));
const OTHER_KEY = new ethers.Wallet(ethers.id("xochi-sdk/test/not-an-open-auth-signer"));
const WALLET = new ethers.Wallet(ethers.id("xochi-sdk/test/taker")).address;
const ESCROW = "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb";
const ATTACKER = "0x00000000000000000000000000000000000000aa";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PARTY = "user_5ABd4A02::1220e610231e7aef0de077733b3afb8a413f6784c8f2bb5c6607d311d3ddad2c3f4d";
const OTHER_PARTY = "mallory::1220" + "ab".repeat(32);
const FROM_AMOUNT = "25000000";
const TO_AMOUNT = "1400000000000";

interface Seal {
  opening: DestOpening;
  terms: Omit<OrderTerms, "destCommitment">;
  pull: "erc3009" | "permit2";
  pullTo?: string;
  signerKey?: ethers.Wallet;
  intent?: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

function goodSeal(): Seal {
  return {
    opening: {
      recipient: PARTY,
      toToken: CANTON_COIN_MAINNET,
      toAmount: TO_AMOUNT,
      blinding: ethers.id("blinding-1"),
      intentId: "intent-cc-1",
    },
    terms: {
      depositor: WALLET,
      fromChainId: "8453",
      fromToken: USDC_BASE,
      fromAmount: FROM_AMOUNT,
      toChainId: String(CANTON_MAINNET_CHAIN_ID),
      fillDeadline: String(now() + 1800),
      escrow: ESCROW,
    },
    pull: "erc3009",
  };
}

// What a venue serves for `seal`: a fresh commitment, orderId, pull nonce and OpenAuth.
async function serve(seal: Seal): Promise<Record<string, any>> {
  const terms: OrderTerms = { ...seal.terms, destCommitment: computeDestCommitment(seal.opening) };
  const orderId = computeOrderId(terms);
  const deadline = now() + 600;
  const expiry = deadline;
  const signature = await signOpenAuth(
    seal.signerKey ?? OPEN_AUTH_KEY,
    { chainId: terms.fromChainId, verifyingContract: terms.escrow },
    orderId,
    expiry,
  );
  const to = seal.pullTo ?? terms.escrow;
  const pull_authorization =
    seal.pull === "erc3009"
      ? {
          types: { ReceiveWithAuthorization: [] },
          primaryType: "ReceiveWithAuthorization",
          domain: { chainId: 8453, verifyingContract: USDC_BASE },
          message: {
            from: WALLET,
            to,
            value: FROM_AMOUNT,
            validAfter: 0,
            validBefore: deadline + 60,
            nonce: orderId,
          },
        }
      : {
          types: { PermitWitnessTransferFrom: [] },
          primaryType: "PermitWitnessTransferFrom",
          domain: { chainId: 8453, verifyingContract: PERMIT2 },
          message: {
            permitted: { token: USDC_BASE, amount: FROM_AMOUNT },
            spender: to,
            nonce: "1",
            deadline: deadline + 60,
            witness: { orderId },
          },
        };
  return {
    intent_id: seal.opening.intentId,
    eip712: {
      message: {
        intentId: seal.opening.intentId,
        quoteId: "quote-cc-1",
        wallet: WALLET,
        recipient: PARTY,
        fromChainId: 8453,
        toChainId: CANTON_MAINNET_CHAIN_ID,
        fromToken: USDC_BASE,
        toToken: CANTON_COIN_MAINNET,
        fromAmount: FROM_AMOUNT,
        toAmount: TO_AMOUNT,
        settlementPreference: "public",
        deadline,
        ...seal.intent,
      },
    },
    pull_authorization,
    escrow: {
      address: ESCROW,
      order_id: orderId,
      fill_deadline: String(terms.fillDeadline),
      order_terms: {
        depositor: terms.depositor,
        from_chain_id: String(terms.fromChainId),
        from_token: terms.fromToken,
        from_amount: String(terms.fromAmount),
        to_chain_id: String(terms.toChainId),
        fill_deadline: String(terms.fillDeadline),
        escrow: terms.escrow,
        dest_commitment: terms.destCommitment,
      },
      dest_opening: {
        recipient: seal.opening.recipient,
        to_token: seal.opening.toToken,
        to_amount: String(seal.opening.toAmount),
        blinding: seal.opening.blinding,
        intent_id: seal.opening.intentId,
      },
      open_auth: { expiry: String(expiry), signature },
    },
  };
}

const request: QuoteRequestParams = {
  wallet: WALLET,
  from_chain_id: 8453,
  to_chain_id: CANTON_MAINNET_CHAIN_ID,
  from_token: USDC_BASE,
  to_token: CANTON_COIN_MAINNET,
  from_amount: FROM_AMOUNT,
  recipient_address: PARTY,
};

const opts: EscrowQuoteOptions = {
  expectedEscrows: { 8453: ESCROW },
  minOut: TO_AMOUNT,
  expectedOpenAuthSigners: [OPEN_AUTH_KEY.address],
};

const refuses = (quote: Record<string, any>, o: EscrowQuoteOptions, pattern: RegExp) =>
  expect(() => assertEscrowQuoteMatchesRequest(request, quote, o)).toThrow(pattern);

describe("assertEscrowQuoteMatchesRequest: a valid Canton Coin envelope", () => {
  it.each(["erc3009", "permit2"] as const)("passes over %s and returns the order", async (pull) => {
    const quote = await serve({ ...goodSeal(), pull });
    const order = assertEscrowQuoteMatchesRequest(request, quote, opts);
    expect(order.orderId).toBe(quote.escrow.order_id);
    expect(order.escrow).toBe(ESCROW);
    expect(order.opening.recipient).toBe(PARTY);
    expect(order.fillDeadline).toBe(Number(quote.escrow.fill_deadline));
    expect(order.openAuth.signer).toBe(OPEN_AUTH_KEY.address);
  });

  it("passes without an OpenAuth signer pin", async () => {
    const quote = await serve({ ...goodSeal(), signerKey: OTHER_KEY });
    const { expectedOpenAuthSigners: _, ...unpinned } = opts;
    expect(assertEscrowQuoteMatchesRequest(request, quote, unpinned).openAuth.signer).toBe(
      OTHER_KEY.address,
    );
  });

  it("reproduces the canton-mainnet-destination order-id vector", async () => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../spec/conformance/order-id.json",
    );
    const vectors = JSON.parse(fs.readFileSync(file, "utf8")).vectors as Record<string, any>[];
    const v = vectors.find((x) => x.name === "canton-mainnet-destination")!;
    const quote = await serve({
      opening: v.opening,
      terms: v.terms,
      pull: "erc3009",
      intent: {
        wallet: v.terms.depositor,
        recipient: v.opening.recipient,
        fromToken: v.terms.fromToken,
        fromAmount: v.terms.fromAmount,
        toAmount: v.opening.toAmount,
      },
    });
    quote.pull_authorization.domain.verifyingContract = v.terms.fromToken;
    quote.pull_authorization.message.value = v.terms.fromAmount;
    const order = assertEscrowQuoteMatchesRequest(
      {
        wallet: v.terms.depositor,
        to_chain_id: CANTON_MAINNET_CHAIN_ID,
        to_token: CANTON_COIN_MAINNET,
        recipient_address: v.opening.recipient,
      },
      quote,
      { expectedEscrows: { 8453: v.terms.escrow }, minOut: v.opening.toAmount },
    );
    expect(order.orderId).toBe(v.expected_order_id);
  });
});

describe("assertEscrowQuoteMatchesRequest: binding mismatches refuse", () => {
  it("recipient: an opening for another party", async () => {
    const seal = goodSeal();
    const quote = await serve({ ...seal, opening: { ...seal.opening, recipient: OTHER_PARTY } });
    refuses(quote, opts, /opening\.recipient/);
  });

  it("amount: an opening below the caller's minimum", async () => {
    const seal = goodSeal();
    const quote = await serve({ ...seal, opening: { ...seal.opening, toAmount: "1399999999999" } });
    refuses(quote, opts, /below minOut/);
  });

  it("chain: terms for another destination chain", async () => {
    const seal = goodSeal();
    const quote = await serve({
      ...seal,
      terms: { ...seal.terms, toChainId: String(CANTON_TESTNET_CHAIN_ID) },
    });
    refuses(quote, opts, /toChainId/);
  });

  it("token: an opening for another instrument", async () => {
    const seal = goodSeal();
    const quote = await serve({
      ...seal,
      opening: { ...seal.opening, toToken: CANTON_COIN_TESTNET },
    });
    refuses(quote, opts, /opening\.toToken/);
  });

  it.each(["erc3009", "permit2"] as const)(
    "escrow address: terms and %s pull naming another escrow",
    async (pull) => {
      const seal = goodSeal();
      const quote = await serve({ ...seal, pull, terms: { ...seal.terms, escrow: ATTACKER } });
      refuses(quote, opts, /pinned escrow/);
    },
  );

  it("escrow address: a pull to another address than the pinned terms escrow", async () => {
    const quote = await serve({ ...goodSeal(), pullTo: ATTACKER });
    refuses(quote, opts, /not the pinned escrow/);
  });

  it("an OpenAuth from an unpinned signer", async () => {
    const quote = await serve({ ...goodSeal(), signerKey: OTHER_KEY });
    refuses(quote, opts, /not one of the pinned OpenAuth signers/);
  });

  it("a malformed OpenAuth signature", async () => {
    const quote = await serve(goodSeal());
    quote.escrow.open_auth.signature = "0x1234";
    refuses(quote, opts, /65 bytes/);
  });

  it("an envelope fill_deadline that is not the terms'", async () => {
    const quote = await serve(goodSeal());
    quote.escrow.fill_deadline = String(Number(quote.escrow.fill_deadline) + 1);
    refuses(quote, opts, /fill_deadline/);
  });

  it("an opening for another intent", async () => {
    const quote = await serve({ ...goodSeal(), intent: { intentId: "intent-cc-2" } });
    refuses(quote, opts, /intent_id/);
  });
});

describe("assertEscrowQuoteMatchesRequest: pins", () => {
  it("refuses an origin chain the pin does not cover", async () => {
    const quote = await serve(goodSeal());
    refuses(
      quote,
      { ...opts, expectedEscrows: { 1: ESCROW } },
      /no pinned escrow for origin chain 8453/,
    );
  });

  it("refuses an absent pin", async () => {
    const quote = await serve(goodSeal());
    refuses(
      quote,
      { ...opts, expectedEscrows: undefined as unknown as EscrowQuoteOptions["expectedEscrows"] },
      /expectedEscrows is required/,
    );
  });

  it("refuses an empty OpenAuth signer pin", async () => {
    const quote = await serve(goodSeal());
    refuses(quote, { ...opts, expectedOpenAuthSigners: [] }, /expectedOpenAuthSigners is empty/);
  });

  it("refuses a quote with no envelope", async () => {
    const { escrow: _, ...plain } = await serve(goodSeal());
    refuses(plain, opts, /no escrow envelope/);
  });

  it("keeps assertPullMatchesIntent refusing an escrow envelope", async () => {
    const quote = await serve(goodSeal());
    expect(() => assertPullMatchesIntent(quote)).toThrow(/assertEscrowQuoteMatchesRequest/);
  });
});

describe("Canton chain identity", () => {
  it.each([31337, 30337])("refuses the facade chain id %i as Canton", async (facade) => {
    // A venue consistent with the facade id everywhere: only the Canton rule refuses it.
    const seal = goodSeal();
    const quote = await serve({
      ...seal,
      terms: { ...seal.terms, toChainId: String(facade) },
      intent: { toChainId: facade },
    });
    expect(() =>
      assertEscrowQuoteMatchesRequest({ ...request, to_chain_id: facade }, quote, opts),
    ).toThrow(/facade id, never Canton's chain id/);
    const fail = (m: string) => new Error(m);
    expect(() =>
      assertCantonDestination(
        { toChainId: facade, recipient: PARTY, toToken: CANTON_COIN_MAINNET },
        fail,
      ),
    ).toThrow(/facade id, never Canton's chain id/);
  });

  it("holds each Canton network to its own instrument and a party recipient", () => {
    const fail = (m: string) => new Error(m);
    const mainnet = { toChainId: CANTON_MAINNET_CHAIN_ID, recipient: PARTY };
    expect(() =>
      assertCantonDestination({ ...mainnet, toToken: CANTON_COIN_MAINNET }, fail),
    ).not.toThrow();
    expect(() =>
      assertCantonDestination({ ...mainnet, toToken: CANTON_COIN_TESTNET }, fail),
    ).toThrow(/not an instrument/);
    expect(() =>
      assertCantonDestination(
        { ...mainnet, recipient: WALLET, toToken: CANTON_COIN_MAINNET },
        fail,
      ),
    ).toThrow(/party recipient/);
    expect(() =>
      assertCantonDestination({ toChainId: 8453, recipient: PARTY, toToken: USDC_BASE }, fail),
    ).toThrow(/not a Canton chain id/);
    expect(() =>
      assertCantonDestination({ toChainId: 8453, recipient: WALLET, toToken: USDC_BASE }, fail),
    ).not.toThrow();
  });
});
