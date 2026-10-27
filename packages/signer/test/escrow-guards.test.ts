// @xochi/signer does not run the escrow binding (SPEC.md §2.3) on the pull or deposit
// paths, so it refuses anything escrow-bearing there, and it does not fold the case of a
// `0x`-prefixed value that is not hex (a Canton party id). How the `expectedEscrows` pin
// itself is read (key spellings, padding, duplicate keys) is pinned once, in
// escrow.test.ts, since one resolver serves both guards.

import { describe, it, expect } from "vitest";
import {
  assertDepositPartiesCaseBindable,
  buildDepositAttestationMessage,
  assertDepositQuoteMatchesRequest,
  assertNoEscrowEnvelope,
  assertPullMatchesIntent,
  DepositQuoteMismatchError,
  deriveFillSalt,
  pinAccepts,
  sameAddressish,
  XochiIntentMismatchError,
  type DepositAttestationFields,
} from "../src";

const ESCROW = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PARTY = "0xAlice::1220" + "ab".repeat(32);
const SWAPPED = "0xalice::1220" + "ab".repeat(32);

function erc3009Quote(fromChainId: unknown, to: string): Record<string, any> {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  return {
    eip712: { message: { fromChainId, fromAmount: "1000000", fromToken: TOKEN, deadline } },
    pull_authorization: {
      types: { ReceiveWithAuthorization: [] },
      domain: { chainId: 8453, verifyingContract: TOKEN },
      message: { to, value: "1000000", validBefore: deadline },
    },
  };
}

describe("assertNoEscrowEnvelope", () => {
  it("refuses a present envelope and passes null / absent", () => {
    expect(() => assertNoEscrowEnvelope({ escrow: { order_id: "0x01" } })).toThrow(
      XochiIntentMismatchError,
    );
    expect(() => assertNoEscrowEnvelope({ escrow: null })).not.toThrow();
    expect(() => assertNoEscrowEnvelope({})).not.toThrow();
    expect(() => assertPullMatchesIntent({ ...erc3009Quote(8453, OTHER), escrow: {} })).toThrow(
      XochiIntentMismatchError,
    );
  });
});

describe("expectedEscrows pull guard", () => {
  const chainSpellings: unknown[] = [8453, "8453", "0x2105", "08453", " 8453", "8453 "];

  it.each(chainSpellings)("refuses a pull to the pinned escrow on fromChainId %j", (chain) => {
    expect(() =>
      assertPullMatchesIntent(erc3009Quote(chain, OTHER), { expectedEscrows: { 8453: ESCROW } }),
    ).not.toThrow();
    expect(() =>
      assertPullMatchesIntent(erc3009Quote(chain, ESCROW), { expectedEscrows: { 8453: ESCROW } }),
    ).toThrow(XochiIntentMismatchError);
  });

  it("refuses an unusable pin rather than skipping the check", () => {
    expect(() =>
      assertPullMatchesIntent(erc3009Quote(8453, OTHER), { expectedEscrows: { 8453: "" } }),
    ).toThrow(XochiIntentMismatchError);
  });

  it("ignores a pin for another chain", () => {
    expect(() =>
      assertPullMatchesIntent(erc3009Quote(8453, ESCROW), { expectedEscrows: { 1: ESCROW } }),
    ).not.toThrow();
  });
});

describe("Canton-aware address comparison", () => {
  it("folds hex case only", () => {
    expect(sameAddressish(ESCROW.toUpperCase().replace("0X", "0x"), ESCROW)).toBe(true);
    expect(sameAddressish(PARTY, SWAPPED)).toBe(false);
    expect(sameAddressish(PARTY, PARTY)).toBe(true);
    expect(pinAccepts([PARTY], SWAPPED)).toBe(false);
    expect(pinAccepts([OTHER, PARTY], PARTY)).toBe(true);
  });

  it("refuses a 0x-prefixed non-hex deposit party", () => {
    for (const name of ["recipient", "wallet", "refund_address"]) {
      expect(() => assertDepositPartiesCaseBindable({ [name]: PARTY })).toThrow(
        DepositQuoteMismatchError,
      );
    }
    expect(() =>
      assertDepositPartiesCaseBindable({ recipient: ESCROW, wallet: OTHER, refund_address: null }),
    ).not.toThrow();
  });

  it("encodes a 0x-prefixed Canton party case-exactly in the attestation digest", () => {
    const quote = (recipient: string) =>
      ({
        intent_id: "xi_canton01",
        quote_id: "xq_canton01",
        wallet: TOKEN,
        from_chain_id: 728126428,
        from_token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        from_amount: "1000000",
        deposit_address: "TJYeasTPa6gpEEfYGfp5LQjWXmdZQBpLzX",
        deposit_deadline: 1750000000,
        refund_address: null,
        to_chain_id: 253340876,
        to_token: "DSO::1220" + "cd".repeat(32),
        to_amount: "1",
        min_to_amount: "1",
        recipient,
        stealth_spending_pub_key: null,
        stealth_viewing_pub_key: null,
        settlement_preference: "public",
      }) as DepositAttestationFields;

    const upper = buildDepositAttestationMessage(quote(PARTY)).split("\n");
    const lower = buildDepositAttestationMessage(quote(SWAPPED)).split("\n");
    expect(upper[14]).toBe(PARTY);
    expect(lower[14]).toBe(SWAPPED);
    // The 0x-hex wallet beside it still folds.
    expect(upper[3]).toBe(TOKEN.toLowerCase());

    // Only to_token and recipient take the hex-only rule. A non-hex 0x stealth key
    // (unvalidated on a public route, so a served shape) keeps the plain fold, and so
    // its bytes are what the server signed before Riddler#1254.
    const keyed = buildDepositAttestationMessage({
      ...quote(OTHER),
      stealth_spending_pub_key: PARTY,
      stealth_viewing_pub_key: "0xDead Beef",
    }).split("\n");
    expect(keyed[15]).toBe(PARTY.toLowerCase());
    expect(keyed[16]).toBe("0xdead beef");
  });
});

describe("deposit quote escrow refusal", () => {
  const fields = {
    from_amount: "1000000",
    recipient: OTHER,
    wallet: OTHER,
    refund_address: null,
    deposit_deadline: Math.floor(Date.now() / 1000) + 600,
  } as unknown as DepositAttestationFields;

  it("refuses a deposit quote carrying an escrow envelope", () => {
    expect(() =>
      assertDepositQuoteMatchesRequest({}, fields, { escrow: { order_id: "0x01" } }),
    ).toThrow(DepositQuoteMismatchError);
    expect(() => assertDepositQuoteMatchesRequest({}, fields, { escrow: null })).not.toThrow();
    expect(() => assertDepositQuoteMatchesRequest({}, fields)).not.toThrow();
  });

  it("refuses a Canton-hinted party through the deposit check", () => {
    const canton = { ...fields, recipient: PARTY } as DepositAttestationFields;
    expect(() => assertDepositQuoteMatchesRequest({}, canton)).toThrow(DepositQuoteMismatchError);
  });
});

describe("deriveFillSalt", () => {
  it("rejects an empty key", () => {
    const id = "0x" + "01".repeat(32);
    expect(() => deriveFillSalt("0x", id)).toThrow(/non-empty/);
    expect(() => deriveFillSalt(new Uint8Array(0), id)).toThrow(/non-empty/);
    expect(deriveFillSalt("0x01", id)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
