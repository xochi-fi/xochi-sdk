/**
 * The escrow flow end to end through the machine (Base USDC -> Canton Coin):
 * an escrow quote binds to the caller's pin or is refused, the pull it signs
 * pays only the pinned escrow, the execute carries both signatures, and the
 * status poll reads as the progress a UI shows. No mocks: the venue's OpenAuth
 * is a real EIP-712 signature by a throwaway key, signed with viem so the digest
 * is checked against an implementation other than `@xochi/signer`'s.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANTON_COIN_MAINNET,
  CANTON_MAINNET_CHAIN_ID,
  computeDestCommitment,
  computeOrderId,
  type OrderTerms,
} from "@xochi/signer";
import {
  RIDDLER_ESCROW_ABI,
  escrowProgress,
  escrowRefundCall,
  escrowRefundableAt,
  parseEscrowLock,
} from "./escrow.js";
import type { MachineConfig } from "./machine/machine.js";
import { escrowMinOut } from "./machine/quoteChecks.js";
import { validateSwapParams } from "./machine/validateRequest.js";
import {
  decodeEscrowStatus,
  type EscrowStatusData,
  type QuoteRequest,
  type QuoteResponse,
} from "./machine/wire.js";
import {
  AMOUNT,
  ATTACKER,
  CONFIG,
  Session,
  T0,
  USDC_BASE,
  WALLET,
  apiCalls,
  ctx,
  erc3009Pull,
  intentTypedData,
  only,
  quote,
  statusData,
  walletCalls,
} from "./machine/test/session.js";

const ESCROW = "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb";
const PARTY = "user_5ABd4A02::1220e610231e7aef0de077733b3afb8a413f6784c8f2bb5c6607d311d3ddad2c3f4d";
const CC_OUT = "1400000000000";
/** Throwaway test key standing in for the venue's OpenAuth signer. */
const OPEN_AUTH = privateKeyToAccount(
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const INTENT_DEADLINE = Math.floor(T0 / 1000) + 3600;
const FILL_DEADLINE = INTENT_DEADLINE + 1800;

const ESCROW_CONFIG: MachineConfig = {
  ...CONFIG,
  escrows: { 8453: ESCROW },
  openAuthSigners: [OPEN_AUTH.address],
};

const cantonCtx = () =>
  ctx({
    toChainId: CANTON_MAINNET_CHAIN_ID,
    toToken: CANTON_COIN_MAINNET,
    recipientAddress: PARTY,
  });

/** A served Canton escrow quote whose venue side is sealed around `escrow`. */
async function cantonQuote(escrow: Hex = ESCROW): Promise<QuoteResponse> {
  const opening = {
    recipient: PARTY,
    toToken: CANTON_COIN_MAINNET,
    toAmount: CC_OUT,
    blinding: ("0x" + "5a".repeat(32)) as Hex,
    intentId: "xi_1",
  };
  const terms: OrderTerms = {
    depositor: WALLET,
    fromChainId: "8453",
    fromToken: USDC_BASE,
    fromAmount: AMOUNT,
    toChainId: String(CANTON_MAINNET_CHAIN_ID),
    fillDeadline: String(FILL_DEADLINE),
    escrow,
    destCommitment: computeDestCommitment(opening),
  };
  const orderId = computeOrderId(terms);
  const expiry = INTENT_DEADLINE;
  const signature = await OPEN_AUTH.signTypedData({
    domain: { name: "RiddlerEscrow", version: "1", chainId: 8453, verifyingContract: escrow },
    types: {
      OpenAuth: [
        { name: "orderId", type: "bytes32" },
        { name: "expiry", type: "uint256" },
      ],
    },
    primaryType: "OpenAuth",
    message: { orderId, expiry: BigInt(expiry) },
  });
  const pull = erc3009Pull(escrow);
  return quote({
    toAmount: CC_OUT,
    recipientAddress: PARTY,
    eip712Data: intentTypedData({
      intentId: "xi_1",
      toChainId: CANTON_MAINNET_CHAIN_ID,
      toToken: CANTON_COIN_MAINNET,
      toAmount: CC_OUT,
      recipient: PARTY,
    }),
    pullAuthorization: { ...pull, message: { ...pull.message, nonce: orderId } },
    escrow: {
      address: escrow,
      order_id: orderId,
      fill_deadline: String(FILL_DEADLINE),
      order_terms: {
        depositor: terms.depositor,
        from_chain_id: "8453",
        from_token: USDC_BASE,
        from_amount: AMOUNT,
        to_chain_id: String(CANTON_MAINNET_CHAIN_ID),
        fill_deadline: String(FILL_DEADLINE),
        escrow,
        dest_commitment: terms.destCommitment,
      },
      dest_opening: {
        recipient: opening.recipient,
        to_token: opening.toToken,
        to_amount: opening.toAmount,
        blinding: opening.blinding,
        intent_id: opening.intentId,
      },
      open_auth: { expiry: String(expiry), signature },
    },
  });
}

describe("escrow quote through the machine", () => {
  it("signs a pinned Canton Coin escrow quote and pulls only to the pinned escrow", async () => {
    const s = new Session(cantonCtx(), ESCROW_CONFIG);
    s.quoteWith(await cantonQuote());
    expect(s.intent.status).toBe("quoted");

    const intent = only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData"));
    expect(intent.purpose).toBe("intent");
    const approval = only(
      walletCalls(
        s.send({
          type: "SignReplied",
          flow: intent.flow,
          purpose: "intent",
          result: { ok: true, signature: "0xintent" },
        }),
        "ensureApproval",
      ),
    );
    const pull = only(
      walletCalls(
        s.send({
          type: "ApprovalReplied",
          flow: approval.flow,
          result: { ok: true, approved: true },
        }),
        "signTypedData",
      ),
    );
    expect(pull.purpose).toBe("pull");
    expect(pull.typedData.message.to).toBe(ESCROW);

    const fx = s.send({
      type: "SignReplied",
      flow: pull.flow,
      purpose: "pull",
      result: { ok: true, signature: "0xpull" },
    });
    expect(only(apiCalls(fx, "execute")).request).toMatchObject({
      signature: "0xintent",
      pullSignature: "0xpull",
    });
    expect(s.intent.status).toBe("executing");
  });

  it("refuses an escrow quote when no escrow is pinned", async () => {
    const s = new Session(cantonCtx(), CONFIG);
    s.quoteWith(await cantonQuote());
    expect(s.intent.status).toBe("failed");
    expect(s.intent.quote).toBeNull();
  });

  it("refuses an escrow quote sealed around an unknown escrow", async () => {
    const s = new Session(cantonCtx(), ESCROW_CONFIG);
    s.quoteWith(await cantonQuote(ATTACKER));
    expect(s.intent.status).toBe("failed");
  });

  it("still treats `escrow: null` as escrow off", () => {
    const s = new Session(ctx(), ESCROW_CONFIG);
    s.quoteWith({ ...quote(), escrow: null });
    expect(s.intent.status).toBe("quoted");
  });

  it("keeps the polled escrow fields, and an attested update id once seen", async () => {
    const s = new Session(cantonCtx(), ESCROW_CONFIG);
    s.quoteWith(await cantonQuote());
    const exec = signAndExecute(s);
    s.send({
      type: "ExecuteReplied",
      flow: exec.flow,
      result: { ok: true, response: { success: true, intentId: "xi_1", status: "executing" } },
    });
    const reply = (escrow: EscrowStatusData | undefined) => {
      const poll = s.model.poll;
      if (!poll) throw new Error("no poll armed");
      s.send({
        type: "StatusReplied",
        gen: poll.gen,
        attempt: poll.polls,
        result: { ok: true, status: statusData({ status: "executing", escrow }) },
      });
    };
    const open: EscrowStatusData = {
      address: ESCROW,
      orderId: "0x01",
      fillDeadline: FILL_DEADLINE,
      wireStatus: "executing",
      cantonUpdateId: null,
    };

    expect(s.intent.escrow).toBeNull();
    reply(open);
    expect(s.intent.escrow).toEqual(open);
    reply({ ...open, cantonUpdateId: "1220ab" });
    expect(s.intent.escrow?.cantonUpdateId).toBe("1220ab");
    reply(undefined);
    expect(s.intent.escrow?.cantonUpdateId).toBe("1220ab");
    reply(open);
    expect(s.intent.escrow).toEqual({ ...open, cantonUpdateId: "1220ab" });
  });
});

/** Sign a held escrow quote through to its execute call. */
function signAndExecute(s: Session) {
  const intent = only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData"));
  const approval = only(
    walletCalls(
      s.send({
        type: "SignReplied",
        flow: intent.flow,
        purpose: "intent",
        result: { ok: true, signature: "0xintent" },
      }),
      "ensureApproval",
    ),
  );
  const pull = only(
    walletCalls(
      s.send({
        type: "ApprovalReplied",
        flow: approval.flow,
        result: { ok: true, approved: true },
      }),
      "signTypedData",
    ),
  );
  return only(
    apiCalls(
      s.send({
        type: "SignReplied",
        flow: pull.flow,
        purpose: "pull",
        result: { ok: true, signature: "0xpull" },
      }),
      "execute",
    ),
  );
}

describe("Canton requests", () => {
  const base: Partial<QuoteRequest> = {
    wallet: WALLET,
    fromChainId: 8453,
    toChainId: CANTON_MAINNET_CHAIN_ID,
    fromToken: USDC_BASE,
    toToken: CANTON_COIN_MAINNET,
    fromAmount: AMOUNT,
    deadline: Math.floor(Date.now() / 1000) + 600,
    slippageBps: 50,
    settlementPreference: "public",
    recipientAddress: PARTY,
  };

  it("accepts chain 253340876 with a party recipient and Canton Coin", () => {
    expect(validateSwapParams(base, Date.now())).toEqual({ isValid: true, errors: [] });
  });

  it.each([31337, 30337])("refuses the gateway facade id %i as Canton", (facade) => {
    const result = validateSwapParams(
      { ...base, toChainId: facade as QuoteRequest["toChainId"] },
      Date.now(),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/facade id, never Canton's chain id/);
  });

  it("refuses an EVM recipient, another instrument, or non-public settlement", () => {
    const errors = (over: Partial<QuoteRequest>) =>
      validateSwapParams({ ...base, ...over }, Date.now()).errors.join(" ");
    expect(errors({ recipientAddress: WALLET })).toMatch(/party recipient/);
    expect(errors({ toToken: USDC_BASE })).toMatch(/not an instrument/);
    expect(errors({ settlementPreference: "stealth" })).toMatch(/settlement must be public/);
  });
});

describe("escrowMinOut", () => {
  it("takes the request's slippage off the signed toAmount, rounding as Riddler does", () => {
    expect(escrowMinOut("10000", 50)).toBe(9950n);
    expect(escrowMinOut("1999", 50)).toBe(1990n);
    expect(() => escrowMinOut(undefined, 50)).toThrow();
  });
});

describe("escrow status", () => {
  const body = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    escrow: { address: ESCROW, order_id: "0x01", fill_deadline: String(FILL_DEADLINE) },
    ...extra,
  });
  const REFUNDABLE_AT = escrowRefundableAt(FILL_DEADLINE, 14_400);

  it("decodes the escrow fields, and nothing without them", () => {
    expect(decodeEscrowStatus(body("executing", { cantonUpdateId: "1220ab" }))).toEqual({
      address: ESCROW,
      orderId: "0x01",
      fillDeadline: FILL_DEADLINE,
      wireStatus: "executing",
      cantonUpdateId: "1220ab",
    });
    expect(decodeEscrowStatus({ status: "executing" })).toBeUndefined();
    expect(
      decodeEscrowStatus({ status: "executing", escrow: { order_id: "0x01" } }),
    ).toBeUndefined();
  });

  it.each([
    ["pending", {}, FILL_DEADLINE, "awaiting_open"],
    ["executing", {}, FILL_DEADLINE, "awaiting_delivery"],
    ["executing", { canton_update_id: "1220ab" }, FILL_DEADLINE, "delivered"],
    ["executing", { canton_update_id: "1220ab" }, REFUNDABLE_AT, "refundable"],
    ["refund_pending", {}, FILL_DEADLINE, "refundable"],
    ["completed", {}, REFUNDABLE_AT, "claimed"],
    ["refunded", {}, REFUNDABLE_AT, "refunded"],
    ["expired", {}, FILL_DEADLINE, "expired"],
    ["someday", {}, FILL_DEADLINE, "unknown"],
  ] as const)("%s %j at %i reads %s", (status, extra, nowSec, want) => {
    const decoded = decodeEscrowStatus(body(status, extra))!;
    expect(escrowProgress(decoded, { refundableAt: REFUNDABLE_AT, nowSec })).toBe(want);
  });

  it("parses a lock and builds the permissionless refund", () => {
    const lock = parseEscrowLock([
      WALLET,
      BigInt(REFUNDABLE_AT),
      10,
      1,
      USDC_BASE,
      253340876n,
      ATTACKER,
      25n,
    ]);
    expect(lock).toMatchObject({ status: "open", refundableAt: REFUNDABLE_AT, amount: 25n });
    expect(() => parseEscrowLock([WALLET, 0n, 0, 9, USDC_BASE, 0n, ATTACKER, 0n])).toThrow();

    const orderId = ("0x" + "ab".repeat(32)) as Hex;
    const call = escrowRefundCall(ESCROW, orderId);
    expect(call.to).toBe(ESCROW);
    expect(decodeFunctionData({ abi: RIDDLER_ESCROW_ABI, data: call.data })).toEqual({
      functionName: "refund",
      args: [orderId],
    });
  });
});
