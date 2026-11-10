/**
 * The deposit screen must be a function of the ATTESTED binding alone.
 *
 * This is the behavioural half of the guarantee `attestedEcho.test.ts` checks
 * structurally. That file asserts the JSX is wired to one object; this one
 * asserts the object resolves to the right values, including the case the wiring
 * cannot express: the decimals used to scale the amount the user is told to
 * send.
 *
 * The divergence being closed: the four money-routing lines were attested and
 * the rest of the screen was not, so "Send exactly {amount} {symbol} on {chain}"
 * -- above a warning that the wrong token or network cannot be recovered -- was
 * live panel state sitting under a proven address. See depositScreen.ts.
 */

import { describe, it, expect } from "vitest";
import { buildDepositScreen } from "./depositScreen.js";
import { verifyStoredDeposit, type DepositAttestationFields } from "@xochi/client";
import depositAttestationVectors from "../../lib/deposit-attestation-vectors.json";

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** A Tron-origin deposit binding: 100 USDT (6dp) in, 99.8 USDC (6dp) out. */
const attested = (over: Partial<DepositAttestationFields> = {}): DepositAttestationFields => ({
  intent_id: "xi_1",
  quote_id: "xq_1",
  wallet: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  from_chain_id: 728126428,
  from_token: TRON_USDT,
  from_amount: "100000000",
  deposit_address: "TXYZdepositaddress000000000000000000",
  deposit_deadline: 1_800_000_000,
  refund_address: null,
  to_chain_id: 8453,
  to_token: BASE_USDC,
  to_amount: "99800000",
  min_to_amount: "99300000",
  recipient: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stealth_spending_pub_key: null,
  stealth_viewing_pub_key: null,
  settlement_preference: "public",
  ...over,
});

describe("buildDepositScreen", () => {
  it("resolves every displayed value from the attested binding", () => {
    const view = buildDepositScreen(attested());
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      depositAddress: "TXYZdepositaddress000000000000000000",
      fromAmount: "100000000",
      fromSymbol: "USDT",
      fromChainId: 728126428,
      toSymbol: "USDC",
      toChainId: 8453,
      payoutAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      depositDeadline: 1_800_000_000,
    });
  });

  // The reason the decimals had to move with the rest. `getTokenInfoByAddress`
  // lowercases, which destroys base58, so a Tron token resolved to the 18-decimal
  // default: the same signed amount rendered as "0.0000000001" instead of "100".
  it("scales the amount by the attested token's decimals, not a default", () => {
    const view = buildDepositScreen(attested());
    expect(view?.fromDecimals).toBe(6);
    expect(view?.receivedAmount).toBe("99.8");
  });

  it("renders canonical DAI metadata on the attested Ethereum destination", () => {
    const view = buildDepositScreen(
      attested({
        to_chain_id: 1,
        to_token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        to_amount: "25000000000000000000",
      }),
    );
    expect(view?.toSymbol).toBe("DAI");
    expect(view?.receivedAmount).toBe("25");
  });

  it("refuses unknown deployments rather than inventing token precision", () => {
    expect(
      buildDepositScreen(
        attested({
          to_token: "0x000000000000000000000000000000000000dEaD",
        }),
      ),
    ).toBeNull();
  });

  // Base58 is case-sensitive. A token address folded on the way to the registry
  // resolves to a different token, or to none.
  it("keeps the base58 origin token byte-for-byte when resolving it", () => {
    const view = buildDepositScreen(attested({ from_token: TRON_USDT.toLowerCase() }));
    // Lowercased base58 is not the same address, so it must NOT resolve to USDT
    // with 6 decimals -- the point is that the lookup never folds case itself.
    expect(view?.fromSymbol).not.toBe("USDT");
  });

  it("returns null for a binding with no deposit address", () => {
    expect(buildDepositScreen(attested({ deposit_address: "" }))).toBeNull();
  });

  it("returns null rather than naming a chain this build cannot render", () => {
    expect(buildDepositScreen(attested({ from_chain_id: 999999 }))).toBeNull();
    expect(buildDepositScreen(attested({ to_chain_id: 999999 }))).toBeNull();
  });

  it("returns null on an absent binding", () => {
    expect(buildDepositScreen(null)).toBeNull();
    expect(buildDepositScreen(undefined)).toBeNull();
  });

  // A record persisted before the cutover to @xochi/client carries the old
  // camelCase field set (and `resolvedSettlementType`), with its undefined
  // optionals dropped by the JSON round trip. On its own it renders nothing;
  // `verifyStoredDeposit` renames it and proves Riddler's own signature over it,
  // and the PROVEN binding it hands back is what the screen renders. Built from
  // a server-generated vector, so the signature is the producer's.
  it("renders a pre-cutover camelCase binding once verifyStoredDeposit proves it", () => {
    const vector = depositAttestationVectors.vectors.find(
      (v) => v.name === "tron_usdt_base58_verbatim",
    )!;
    const q = vector.quote;
    const legacy = JSON.parse(
      JSON.stringify({
        attested: {
          intentId: q.intent_id,
          quoteId: q.quote_id,
          wallet: q.wallet,
          fromChainId: q.from_chain_id,
          fromToken: q.from_token,
          fromAmount: q.from_amount,
          depositAddress: q.deposit_address,
          depositDeadline: q.deposit_deadline,
          refundAddress: q.refund_address ?? undefined,
          toChainId: q.to_chain_id,
          toToken: q.to_token,
          toAmount: q.to_amount,
          minToAmount: q.min_to_amount,
          recipient: q.recipient,
          stealthSpendingPubKey: q.stealth_spending_pub_key ?? undefined,
          stealthViewingPubKey: q.stealth_viewing_pub_key ?? undefined,
          resolvedSettlementType: q.settlement_preference,
        },
        attestation: vector.deposit_attestation,
      }),
    );
    expect(buildDepositScreen(legacy.attested)).toBeNull();

    const result = verifyStoredDeposit(legacy, depositAttestationVectors.signer, {
      intentId: q.intent_id,
      owner: q.wallet,
    });
    if (!result.ok) throw new Error(`expected the migrated record to verify: ${result.reason}`);
    const view = buildDepositScreen(result.stored.attested);

    expect(view?.depositAddress).toBe(q.deposit_address);
    expect(view?.fromAmount).toBe(q.from_amount);
    expect(view?.fromSymbol).toBe("USDT");
    expect(view?.fromChainId).toBe(q.from_chain_id);
    expect(view?.toChainId).toBe(q.to_chain_id);
    expect(view?.depositDeadline).toBe(q.deposit_deadline);
  });

  // The payout line is omitted entirely rather than rendered as "0". A zero is a
  // claim about the deal; an absent line is the absence of one.
  it.each([["1.5"], [""], ["0x1f4"], ["-100"], ["1e6"]])(
    "omits the payout estimate when toAmount is %j",
    (toAmount) => {
      expect(buildDepositScreen(attested({ to_amount: toAmount }))?.receivedAmount).toBeUndefined();
    },
  );

  // Same rule the address lines already followed: absent renders nothing rather
  // than falling back to a live value.
  it("passes an unnamed refund or recipient through as undefined", () => {
    const view = buildDepositScreen(attested({ refund_address: "", recipient: "" }));
    expect(view?.refundAddress).toBeUndefined();
    expect(view?.payoutAddress).toBeUndefined();
  });

  it("carries a named refund address verbatim", () => {
    const refund = "TRefundAddress0000000000000000000000";
    expect(buildDepositScreen(attested({ refund_address: refund }))?.refundAddress).toBe(refund);
  });

  // Riddler always sets a deadline on an attested route, but the field is
  // optional on the type, and the countdown treats absent as "no window shown"
  // rather than as a window that never closes.
  it("passes an absent deadline through as undefined", () => {
    expect(buildDepositScreen(attested({ deposit_deadline: null }))?.depositDeadline).toBe(
      undefined,
    );
  });
});
