// The riddler-sdk#150 guards: this SDK does not run the escrow binding (SPEC.md §2.3) on
// the pull or deposit paths, so it refuses anything escrow-bearing there, and it does not
// fold the case of a `0x`-prefixed value that is not hex (a Canton party id).

import { describe, it, expect } from "vitest";
import {
  assertDepositPartiesCaseBindable,
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

  it.each(["0x2105", "08453", " 8453"])("honors a non-canonical pin key %j", (key) => {
    const opts = { expectedEscrows: { [key]: ESCROW } as Record<string, string> };
    expect(() => assertPullMatchesIntent(erc3009Quote(8453, ESCROW), opts)).toThrow(
      XochiIntentMismatchError,
    );
  });

  it.each([` ${ESCROW}`, `${ESCROW} `, ESCROW.toUpperCase().replace("0X", "0x")])(
    "matches a pin spelled %j",
    (pin) => {
      expect(() =>
        assertPullMatchesIntent(erc3009Quote(8453, ESCROW), { expectedEscrows: { 8453: pin } }),
      ).toThrow(XochiIntentMismatchError);
      expect(() =>
        assertPullMatchesIntent(erc3009Quote(8453, OTHER), { expectedEscrows: { 8453: pin } }),
      ).not.toThrow();
    },
  );

  it.each(["", "  ", "0xnope", "0x" + "0".repeat(40)])("refuses an unusable pin %j", (pin) => {
    expect(() =>
      assertPullMatchesIntent(erc3009Quote(8453, OTHER), { expectedEscrows: { 8453: pin } }),
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
