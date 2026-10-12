/**
 * Fail-closed pin for origin-pull authorizations (recipient + amount).
 *
 * The user's wallet signs the pull `to` (ERC-3009) / `spender` (Permit2) and the
 * amount (`value` / `permitted.amount`) the solver served. A forged or MITM'd
 * quote could name an attacker recipient or inflate the amount; the pin binds the
 * recipient to an operator allowlist AND the amount to the intended input BEFORE
 * signing. Permit2 has no on-chain recipient guard, so its recipient is always
 * fail-closed; ERC-3009 binds `to` in the signature + enforces msg.sender == to,
 * so it stays bounded unless a hard pin is requested. Mirrors the raxol agent-side
 * pin.
 */

import { describe, it, expect } from "vitest";
import { validateSolverPin, validatePayoutPin, type SolverPinConfig } from "./solverPin.js";
import type { Eip712TypedData } from "../shared/index.js";

const SOLVER = "0x0000000000000000000000000000000000005011";
// Distinct address class: the verified XochiPullPermit2 contract is the Permit2
// `spender`, NOT the solver EOA. Mirrors prod 0xE9B0...2f53.
const PERMIT2_CONTRACT = "0x00000000000000000000000000000000e9b02f53";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const TOKEN = "0x0000000000000000000000000000000000000001";

// The intended input amount every honest pull must match.
const AMOUNT = 1000000n;

function erc3009Pull(to: string, value = "1000000"): Eip712TypedData {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: SOLVER },
    types: { ReceiveWithAuthorization: [{ name: "to", type: "address" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: "0xabc", to, value },
  };
}

function permit2Pull(spender: string, amount = "1000000"): Eip712TypedData {
  return {
    domain: { name: "Permit2", version: "1", chainId: 8453, verifyingContract: ATTACKER },
    types: { PermitWitnessTransferFrom: [{ name: "spender", type: "address" }] },
    primaryType: "PermitWitnessTransferFrom",
    message: { spender, nonce: "1", deadline: "9999999999", permitted: { token: TOKEN, amount } },
  };
}

const open: SolverPinConfig = { erc3009Allowlist: [], permit2Allowlist: [], requirePin: false };
const hardPin: SolverPinConfig = { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true };
// Prod-shaped pin: ERC-3009 `to` is the solver EOA; Permit2 `spender` is the
// verified XochiPullPermit2 contract. Separate address classes.
const pinned: SolverPinConfig = {
  erc3009Allowlist: [SOLVER.toLowerCase()],
  permit2Allowlist: [PERMIT2_CONTRACT.toLowerCase()],
  requirePin: true,
};

describe("validateSolverPin", () => {
  describe("ERC-3009 (to is signature-bound + msg.sender == to)", () => {
    it("accepts an unpinned `to` when no allowlist and no hard pin", () => {
      expect(validateSolverPin(erc3009Pull(ATTACKER), open, AMOUNT)).toEqual({ ok: true });
    });

    it("rejects an unpinned `to` when requirePin is set", () => {
      const r = validateSolverPin(erc3009Pull(SOLVER), hardPin, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_to" });
    });

    it("accepts a pinned `to` (case-insensitive)", () => {
      expect(validateSolverPin(erc3009Pull(SOLVER.toUpperCase()), pinned, AMOUNT)).toEqual({
        ok: true,
      });
    });

    it("rejects a `to` outside the allowlist", () => {
      const r = validateSolverPin(erc3009Pull(ATTACKER), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_to" });
    });
  });

  describe("Permit2 (spender chooses recipient; always fail-closed)", () => {
    it("rejects when no allowlist is configured", () => {
      const r = validateSolverPin(permit2Pull(SOLVER), open, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_spender" });
    });

    it("accepts a pinned spender (the XochiPullPermit2 contract, case-insensitive)", () => {
      expect(
        validateSolverPin(permit2Pull(PERMIT2_CONTRACT.toUpperCase()), pinned, AMOUNT),
      ).toEqual({
        ok: true,
      });
    });

    it("rejects a spender outside the allowlist", () => {
      const r = validateSolverPin(permit2Pull(ATTACKER), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_spender" });
    });

    it("rejects the solver EOA as a Permit2 spender (role confusion)", () => {
      // The ERC-3009 recipient EOA must never satisfy the Permit2 spender pin.
      const r = validateSolverPin(permit2Pull(SOLVER), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_spender" });
    });
  });

  describe("recipient classes are disjoint (no cross-method impersonation)", () => {
    it("rejects the XochiPullPermit2 contract as an ERC-3009 `to`", () => {
      const r = validateSolverPin(erc3009Pull(PERMIT2_CONTRACT), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_to" });
    });
  });

  describe("amount binding", () => {
    it("rejects an ERC-3009 pull whose value exceeds the intended input", () => {
      const r = validateSolverPin(erc3009Pull(SOLVER, "5000000"), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_amount" });
    });

    it("rejects a Permit2 pull whose permitted.amount exceeds the intended input", () => {
      const r = validateSolverPin(permit2Pull(PERMIT2_CONTRACT, "5000000"), pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_amount" });
    });

    it("rejects a pull whose amount is missing or unparseable", () => {
      const noAmount = {
        ...permit2Pull(PERMIT2_CONTRACT),
        message: { spender: PERMIT2_CONTRACT, nonce: "1", deadline: "9" },
      } as Eip712TypedData;
      const r = validateSolverPin(noAmount, pinned, AMOUNT);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ field: "pull_amount" });
    });

    it("checks recipient before amount (recipient failure takes precedence)", () => {
      const r = validateSolverPin(erc3009Pull(ATTACKER, "5000000"), pinned, AMOUNT);
      expect(r).toMatchObject({ field: "pull_to" });
    });
  });

  it("rejects an unrecognized pull authorization type", () => {
    const bogus = {
      domain: { name: "x", version: "1", chainId: 8453, verifyingContract: SOLVER },
      types: { TransferWithAuthorization: [] },
      primaryType: "TransferWithAuthorization",
      message: { to: SOLVER },
    } as Eip712TypedData;

    const r = validateSolverPin(bogus, pinned, AMOUNT);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ field: "pull_type" });
  });
});

// ============================================================
// Destination leg
// ============================================================

const WALLET = "0x1111111111111111111111111111111111111111";
const TRON_RECIPIENT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function intentPayload(over: Record<string, unknown> = {}): Eip712TypedData {
  return {
    domain: { name: "Xochi", version: "3", chainId: 8453 },
    types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
    primaryType: "XochiIntent",
    message: {
      intentId: "xi_1",
      quoteId: "q_1",
      wallet: WALLET,
      recipient: WALLET,
      fromAmount: "1000000",
      toAmount: "998000",
      ...over,
    },
  };
}

describe("validatePayoutPin", () => {
  // The user can read a wallet prompt and see what LEAVES their wallet. They
  // cannot see what comes back or who receives it, which is why these two fields
  // are pinned to the client's own rendered quote rather than to the payload.
  it("accepts a payload matching the quoted output and the connected wallet", () => {
    expect(validatePayoutPin(intentPayload(), { toAmount: "998000", recipient: WALLET })).toEqual({
      ok: true,
    });
  });

  it("rejects a payout undercutting what was rendered", () => {
    const r = validatePayoutPin(intentPayload({ toAmount: "1" }), {
      toAmount: "998000",
      recipient: WALLET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("payout_amount");
  });

  it("rejects a payout INFLATED above what was rendered", () => {
    // Not obviously an attack, but it means the payload and the screen disagree,
    // and we do not know which one the backend will honor. Fail closed either way.
    const r = validatePayoutPin(intentPayload({ toAmount: "999999999" }), {
      toAmount: "998000",
      recipient: WALLET,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a substituted recipient", () => {
    const r = validatePayoutPin(intentPayload({ recipient: ATTACKER }), {
      toAmount: "998000",
      recipient: WALLET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("payout_recipient");
  });

  it("compares an EVM recipient case-insensitively", () => {
    const r = validatePayoutPin(
      intentPayload({ recipient: WALLET.toUpperCase().replace("0X", "0x") }),
      {
        toAmount: "998000",
        recipient: WALLET,
      },
    );
    expect(r).toEqual({ ok: true });
  });

  it("compares a non-EVM recipient verbatim (base58 is case-sensitive)", () => {
    expect(
      validatePayoutPin(intentPayload({ recipient: TRON_RECIPIENT }), {
        toAmount: "998000",
        recipient: TRON_RECIPIENT,
      }),
    ).toEqual({ ok: true });

    const r = validatePayoutPin(intentPayload({ recipient: TRON_RECIPIENT.toLowerCase() }), {
      toAmount: "998000",
      recipient: TRON_RECIPIENT,
    });
    expect(r.ok).toBe(false);
  });

  // Stealth settlement is live, and its payout lands at a one-time counterfactual
  // SimpleAccount rather than the connected wallet. If Riddler put that stealth
  // address in the signed `recipient`, this pin would reject every stealth swap
  // at the prompt.
  //
  // It does not. Riddler's recipient_address/1 (adapter/quote.ex) is
  // unconditional -- request recipient if non-empty, else the wallet -- and has no
  // stealth branch. The stealth-specific value is `recipient_commitment`, which
  // rides on the RFQ announcement to the solver panel, NOT on the signed intent.
  // Xochi sends no recipient_address on an EVM route, so a stealth intent signs
  // the wallet. Pinned here so a future change upstream fails loudly in CI rather
  // than silently at users' wallets.
  it("accepts a stealth-route payload, which signs the wallet, not the stealth address", () => {
    expect(
      validatePayoutPin(intentPayload({ settlementPreference: "stealth", recipient: WALLET }), {
        toAmount: "998000",
        recipient: WALLET,
      }),
    ).toEqual({ ok: true });
  });

  it("compares amounts by value, not by spelling", () => {
    // A false negative here blocks a legitimate swap at the wallet prompt, so
    // equal values in different formats must pass.
    for (const served of ["0998000", 998000, "998000"]) {
      expect(
        validatePayoutPin(intentPayload({ toAmount: served }), {
          toAmount: "998000",
          recipient: WALLET,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("handles an 18-decimal payout beyond Number.MAX_SAFE_INTEGER", () => {
    const wei = "1000000000000000000";
    expect(
      validatePayoutPin(intentPayload({ toAmount: wei }), { toAmount: wei, recipient: WALLET }),
    ).toEqual({ ok: true });
    // One unit short must still reject at that magnitude.
    const short = "999999999999999999";
    expect(
      validatePayoutPin(intentPayload({ toAmount: short }), { toAmount: wei, recipient: WALLET })
        .ok,
    ).toBe(false);
  });

  it("refuses when the expected recipient is unknown", () => {
    // Rather than casting the caller's `string | undefined` away. Not knowing who
    // the payout is for is the worst case to sign blind in.
    const r = validatePayoutPin(intentPayload(), { toAmount: "998000", recipient: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("payout_recipient");
  });

  it("fails closed on a missing or unreadable payout field", () => {
    for (const bad of [{ toAmount: undefined }, { toAmount: null }, { toAmount: {} }]) {
      const r = validatePayoutPin(intentPayload(bad), { toAmount: "998000", recipient: WALLET });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe("payout_amount");
    }
    for (const bad of [{ recipient: undefined }, { recipient: "" }, { recipient: 5 }]) {
      const r = validatePayoutPin(intentPayload(bad), { toAmount: "998000", recipient: WALLET });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe("payout_recipient");
    }
  });
});
