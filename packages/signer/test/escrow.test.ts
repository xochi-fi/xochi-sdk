// M6 escrow primitives, order v2 (RESERVED / INERT). Verifies canonical keys,
// the blinded destination commitment, the orderId sensitivity, OpenAuth
// signatures and every rejection path of the escrow-binding guard (SPEC.md
// §2.3, ESCROW-RFC.md §2/§7/§12). Byte-level expectations live in the shared
// vectors (order-id-vectors.test.ts), never inline here.

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  assertEscrowBinding,
  canonicalKey,
  computeDestCommitment,
  computeOrderId,
  deriveDestBlinding,
  fillAcceptanceDigest,
  fillAcceptanceDomainSeparator,
  fillAcceptanceStructHash,
  fillAttestationDomainSeparator,
  fillAuthDigest,
  fillAuthDomainSeparator,
  fillAuthStructHash,
  openAuthDigest,
  openAuthDomainSeparator,
  signFillAcceptance,
  signFillAttestation,
  signFillAuth,
  signOpenAuth,
  signSlashAttestation,
  slashAttestationDigest,
  slashAttestationDomainSeparator,
  slashAttestationStructHash,
  type DestOpening,
  type EscrowBinding,
  type FillAcceptance,
  type FillAuth,
  type OrderTerms,
  type SlashClaim,
} from "@xochi/signer";

const ESCROW = "0x3333333333333333333333333333333333333333";
const SIGNER = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const USDC_OP = "0x0b2c639c533813f4aa9d7837caf62653d097ff85";

const opening: DestOpening = {
  recipient: RECIPIENT,
  toToken: USDC_OP,
  toAmount: "99700000",
  blinding: "0x" + "5a".repeat(32),
  intentId: "intent-0001",
};

const terms: OrderTerms = {
  depositor: SIGNER,
  fromChainId: 8453,
  fromToken: USDC_BASE,
  fromAmount: "100000000",
  toChainId: 10,
  fillDeadline: 1900000000,
  escrow: ESCROW,
  destCommitment: computeDestCommitment(opening),
};
const ORDER_ID = computeOrderId(terms);

describe("canonicalKey", () => {
  it("keys a checksummed and a lowercase EVM address identically", () => {
    expect(canonicalKey(ethers.getAddress(RECIPIENT))).toBe(canonicalKey(RECIPIENT));
    expect(canonicalKey(RECIPIENT)).toBe("0x000000000000000000000000" + RECIPIENT.slice(2));
  });

  it("hashes non-address strings verbatim and case-sensitively", () => {
    expect(canonicalKey("Amulet")).toBe(ethers.id("Amulet"));
    expect(canonicalKey("Amulet")).not.toBe(canonicalKey("amulet"));
  });

  it("rejects the empty string", () => {
    expect(() => canonicalKey("")).toThrow(/empty/);
  });
});

describe("computeDestCommitment", () => {
  const variants: [string, Partial<DestOpening>][] = [
    ["recipient", { recipient: "0x" + "44".repeat(20) }],
    ["toToken", { toToken: "Amulet" }],
    ["toAmount", { toAmount: "99700001" }],
    ["blinding", { blinding: "0x" + "5b".repeat(32) }],
    ["intentId", { intentId: "intent-0002" }],
  ];
  it.each(variants)("changes the orderId when opening.%s changes", (_, change) => {
    const c = computeDestCommitment({ ...opening, ...change });
    expect(c).not.toBe(terms.destCommitment);
    expect(computeOrderId({ ...terms, destCommitment: c })).not.toBe(ORDER_ID);
  });

  it("rejects a zero or short blinding and an empty intentId", () => {
    expect(() => computeDestCommitment({ ...opening, blinding: "0x" + "00".repeat(32) })).toThrow(/non-zero/);
    expect(() => computeDestCommitment({ ...opening, blinding: "0x1234" })).toThrow(/32 bytes/);
    expect(() => computeDestCommitment({ ...opening, intentId: "" })).toThrow(/intentId/);
  });
});

describe("computeOrderId", () => {
  const variants: [string, Partial<OrderTerms>][] = [
    ["depositor", { depositor: "0x" + "12".repeat(20) }],
    ["fromChainId", { fromChainId: 1 }],
    ["fromToken", { fromToken: "0x" + "13".repeat(20) }],
    ["fromAmount", { fromAmount: "100000001" }],
    ["toChainId", { toChainId: 42161 }],
    ["fillDeadline", { fillDeadline: 1900000001 }],
    ["escrow", { escrow: "0x" + "14".repeat(20) }],
    ["destCommitment", { destCommitment: "0x" + "15".repeat(32) }],
  ];
  it.each(variants)("changes when terms.%s changes", (_, change) => {
    expect(computeOrderId({ ...terms, ...change })).not.toBe(ORDER_ID);
  });

  it("is case-insensitive in its address fields", () => {
    expect(
      computeOrderId({ ...terms, fromToken: ethers.getAddress(USDC_BASE), escrow: ethers.getAddress(ESCROW) }),
    ).toBe(ORDER_ID);
  });
});

describe("OpenAuth", () => {
  it("signatures recover to the test signer", async () => {
    // PUBLIC Hardhat/Anvil test key #0. Never fund it.
    const wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const domain = { chainId: 8453, verifyingContract: ESCROW };
    const sig = await signOpenAuth(wallet, domain, ORDER_ID, 1900000000);
    expect(ethers.getBytes(sig).length).toBe(65);
    expect(ethers.recoverAddress(openAuthDigest(domain, ORDER_ID, 1900000000), sig)).toBe(wallet.address);
    expect(ethers.recoverAddress(openAuthDigest(domain, ORDER_ID, 1900000001), sig)).not.toBe(wallet.address);
  });
});

// Riddler's EIP712.uint/1 refuses these, so a signer that coerced them would
// sign a value the venue/contract side never admits ("0x10" -> 16, "" -> 0).
describe.each(["0x10", "", " 5"])("strict uint parsing on every escrow signer, digest and domain (%j)", (bad) => {
  // PUBLIC Hardhat/Anvil test key #0. Never fund it.
  const wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const domain = { chainId: 8453, verifyingContract: ESCROW };
  const badDomain = { chainId: bad, verifyingContract: ESCROW };
  const fa: FillAuth = { fillId: ORDER_ID, filler: wallet.address, to: RECIPIENT, token: USDC_OP, amount: "5", deadline: "1900000000" };
  const claim: SlashClaim = {
    orderId: ORDER_ID,
    solver: wallet.address,
    beneficiary: SIGNER,
    notional: "100000000",
    originChainId: "8453",
    escrow: ESCROW,
    deadline: "1900000000",
  };
  const acc: FillAcceptance = {
    orderId: ORDER_ID,
    originChainId: "8453",
    escrow: ESCROW,
    filler: wallet.address,
    deadline: "1900000000",
    fillAuth: ORDER_ID,
  };
  const UINT = /base-10 uint256/;

  it("OpenAuth: signer expiry and every domain chainId", async () => {
    await expect(signOpenAuth(wallet, domain, ORDER_ID, bad)).rejects.toThrow(UINT);
    await expect(signOpenAuth(wallet, badDomain, ORDER_ID, 1900000000)).rejects.toThrow(UINT);
    expect(() => openAuthDomainSeparator(badDomain)).toThrow(UINT);
    expect(() => openAuthDigest(badDomain, ORDER_ID, 1900000000)).toThrow(UINT);
  });

  it("FillAuth: amount, deadline and domain chainId", async () => {
    for (const a of [{ ...fa, amount: bad }, { ...fa, deadline: bad }]) {
      expect(() => fillAuthStructHash(a)).toThrow(UINT);
      expect(() => fillAuthDigest(domain, a)).toThrow(UINT);
      await expect(signFillAuth(wallet, domain, a)).rejects.toThrow(UINT);
    }
    expect(() => fillAuthDomainSeparator(badDomain)).toThrow(UINT);
    await expect(signFillAuth(wallet, badDomain, fa)).rejects.toThrow(UINT);
  });

  it("FillAttestation: domain chainId", async () => {
    expect(() => fillAttestationDomainSeparator(badDomain)).toThrow(UINT);
    await expect(signFillAttestation(wallet, badDomain, ORDER_ID, RECIPIENT)).rejects.toThrow(UINT);
  });

  it("SlashAttestation: notional, originChainId, deadline and domain chainId", async () => {
    for (const c of [{ ...claim, notional: bad }, { ...claim, originChainId: bad }, { ...claim, deadline: bad }]) {
      expect(() => slashAttestationStructHash(c)).toThrow(UINT);
      expect(() => slashAttestationDigest(domain, c)).toThrow(UINT);
      await expect(signSlashAttestation(wallet, domain, c)).rejects.toThrow(UINT);
    }
    expect(() => slashAttestationDomainSeparator(badDomain)).toThrow(UINT);
    await expect(signSlashAttestation(wallet, badDomain, claim)).rejects.toThrow(UINT);
  });

  it("FillAcceptance: originChainId, deadline and domain chainId", async () => {
    for (const a of [{ ...acc, originChainId: bad }, { ...acc, deadline: bad }]) {
      expect(() => fillAcceptanceStructHash(a)).toThrow(UINT);
      expect(() => fillAcceptanceDigest(domain, a)).toThrow(UINT);
      await expect(signFillAcceptance(wallet, domain, a)).rejects.toThrow(UINT);
    }
    expect(() => fillAcceptanceDomainSeparator(badDomain)).toThrow(UINT);
    await expect(signFillAcceptance(wallet, badDomain, acc)).rejects.toThrow(UINT);
  });
});

describe("assertEscrowBinding", () => {
  const good: EscrowBinding = {
    signer: SIGNER,
    recipient: RECIPIENT,
    toToken: USDC_OP,
    toChainId: 10,
    minOut: "99700000",
    terms,
    opening,
    quotedOrderId: ORDER_ID,
    pullAuth: { kind: "erc3009", to: ESCROW, token: USDC_BASE, amount: "100000000", nonce: ORDER_ID },
    expectedEscrows: { 8453: ESCROW },
  };

  // Re-seals the terms and orderId around a tampered opening, so the guard is
  // forced to catch the tamper on the intent check, not on a hash mismatch.
  const resealed = (o: DestOpening): EscrowBinding => {
    const t = { ...terms, destCommitment: computeDestCommitment(o) };
    const id = computeOrderId(t);
    return { ...good, opening: o, terms: t, quotedOrderId: id, pullAuth: { ...good.pullAuth, nonce: id } as EscrowBinding["pullAuth"] };
  };

  it("accepts a faithful erc3009 and permit2 binding and returns the orderId", () => {
    expect(assertEscrowBinding(good)).toBe(ORDER_ID);
    expect(
      assertEscrowBinding({
        ...good,
        recipient: ethers.getAddress(RECIPIENT),
        pullAuth: { kind: "permit2", spender: ESCROW, token: USDC_BASE, amount: "100000000", witnessOrderId: ORDER_ID },
      }),
    ).toBe(ORDER_ID);
  });

  it("rejects a recipient swap", () => {
    expect(() => assertEscrowBinding(resealed({ ...opening, recipient: "0x" + "66".repeat(20) }))).toThrow(
      /opening.recipient/,
    );
  });

  it("rejects a token swap", () => {
    expect(() => assertEscrowBinding(resealed({ ...opening, toToken: "0x" + "77".repeat(20) }))).toThrow(
      /opening.toToken/,
    );
  });

  it("rejects toAmount below minOut", () => {
    expect(() => assertEscrowBinding(resealed({ ...opening, toAmount: "99699999" }))).toThrow(/below minOut/);
  });

  it("rejects a zero blinding", () => {
    expect(() => assertEscrowBinding({ ...good, opening: { ...opening, blinding: "0x" + "00".repeat(32) } })).toThrow(
      /non-zero/,
    );
  });

  it("rejects a destCommitment that does not open to the opening", () => {
    expect(() => assertEscrowBinding({ ...good, terms: { ...terms, destCommitment: "0x" + "99".repeat(32) } })).toThrow(
      /destCommitment mismatch/,
    );
  });

  it("rejects a quoted orderId that is not the recomputed one", () => {
    expect(() => assertEscrowBinding({ ...good, quotedOrderId: "0x" + "ab".repeat(32) })).toThrow(/orderId mismatch/);
  });

  it("rejects terms naming a different escrow", () => {
    const t = { ...terms, escrow: "0x" + "88".repeat(20) };
    const id = computeOrderId(t);
    expect(() => assertEscrowBinding({ ...good, terms: t, quotedOrderId: id })).toThrow(/pinned escrow/);
  });

  // The finding: every escrow value in a quote is the venue's. A hostile venue
  // names its own EOA as escrow.address AND order_terms.escrow AND the pull `to`,
  // and reseals destCommitment/orderId over the user's real recipient, token,
  // chain and amount. Before the pin, the guard compared those three to each
  // other and returned the orderId.
  it("refuses an attacker-escrow quote that is consistent with itself", () => {
    const ATTACKER = "0x" + "a7".repeat(20);
    const t = { ...terms, escrow: ATTACKER };
    const id = computeOrderId(t);
    const hostile: EscrowBinding = {
      ...good,
      terms: t,
      quotedOrderId: id,
      pullAuth: { kind: "erc3009", to: ATTACKER, token: USDC_BASE, amount: "100000000", nonce: id },
    };
    expect(() => assertEscrowBinding(hostile)).toThrow(/is not the pinned escrow for chain 8453/);
    expect(() =>
      assertEscrowBinding({
        ...hostile,
        pullAuth: { kind: "permit2", spender: ATTACKER, token: USDC_BASE, amount: "100000000", witnessOrderId: id },
      }),
    ).toThrow(/is not the pinned escrow for chain 8453/);
  });

  it("requires the escrow pin and refuses an origin chain it does not cover", () => {
    const without = (pin: unknown) => ({ ...good, expectedEscrows: pin as EscrowBinding["expectedEscrows"] });
    for (const pin of [undefined, null, [], ESCROW]) {
      expect(() => assertEscrowBinding(without(pin))).toThrow(/expectedEscrows is required/);
    }
    expect(() => assertEscrowBinding(without({}))).toThrow(/no pinned escrow for origin chain 8453/);
    expect(() => assertEscrowBinding(without({ 1: ESCROW }))).toThrow(/no pinned escrow for origin chain 8453/);
    // Keys are matched by canonical decimal only; a padded key does not alias 8453.
    expect(() => assertEscrowBinding(without({ "08453": ESCROW }))).toThrow(/no pinned escrow for origin chain 8453/);
  });

  it.each([["blank", ""], ["malformed", "0x1234"], ["zero", "0x" + "00".repeat(20)], ["non-string", 42]])(
    "refuses a %s pinned escrow entry",
    (_, entry) => {
      expect(() =>
        assertEscrowBinding({ ...good, expectedEscrows: { 8453: entry } as unknown as EscrowBinding["expectedEscrows"] }),
      ).toThrow(/pinned escrow for origin chain 8453 is not a non-zero EVM address/);
    },
  );

  it("matches the pin case-insensitively and keyed by terms.fromChainId", () => {
    expect(assertEscrowBinding({ ...good, expectedEscrows: { 1: "0x" + "88".repeat(20), 8453: ethers.getAddress(ESCROW) } })).toBe(
      ORDER_ID,
    );
  });

  it("rejects a pull-auth whose to/spender is not the escrow", () => {
    expect(() => assertEscrowBinding({ ...good, pullAuth: { ...good.pullAuth, to: SIGNER } as EscrowBinding["pullAuth"] })).toThrow(
      /spender\/to/,
    );
    expect(() =>
      assertEscrowBinding({ ...good, pullAuth: { kind: "permit2", spender: SIGNER, token: USDC_BASE, amount: "100000000", witnessOrderId: ORDER_ID } }),
    ).toThrow(/spender\/to/);
  });

  it("rejects a depositor that is not the signer", () => {
    expect(() => assertEscrowBinding({ ...good, signer: "0x" + "55".repeat(20) })).toThrow(/depositor/);
  });

  it("rejects a fromToken that is not the pull-auth token", () => {
    expect(() =>
      assertEscrowBinding({ ...good, pullAuth: { ...good.pullAuth, token: "0x" + "56".repeat(20) } as EscrowBinding["pullAuth"] }),
    ).toThrow(/fromToken/);
  });

  it("rejects a fromAmount that is not the pull-auth amount", () => {
    expect(() =>
      assertEscrowBinding({ ...good, pullAuth: { ...good.pullAuth, amount: "100000001" } as EscrowBinding["pullAuth"] }),
    ).toThrow(/fromAmount/);
  });

  it("rejects an erc3009 nonce that is not the orderId", () => {
    expect(() =>
      assertEscrowBinding({ ...good, pullAuth: { ...good.pullAuth, nonce: "0x" + "cd".repeat(32) } as EscrowBinding["pullAuth"] }),
    ).toThrow(/nonce/);
  });

  it("rejects terms delivering on a chain other than the intent's", () => {
    const t2 = { ...terms, toChainId: 42161 };
    const id = computeOrderId(t2);
    const resealedChain = { ...good, terms: t2, quotedOrderId: id, pullAuth: { ...good.pullAuth, nonce: id } as EscrowBinding["pullAuth"] };
    expect(() => assertEscrowBinding(resealedChain)).toThrow(/toChainId/);
    expect(() => assertEscrowBinding({ ...good, toChainId: undefined as unknown as number })).toThrow(/toChainId/);
    expect(assertEscrowBinding({ ...good, toChainId: "10" })).toBe(ORDER_ID);
  });

  it("rejects a permit2 witness orderId that is not the orderId", () => {
    const p2 = { kind: "permit2", spender: ESCROW, token: USDC_BASE, amount: "100000000" } as const;
    expect(() => assertEscrowBinding({ ...good, pullAuth: { ...p2, witnessOrderId: "0x" + "cd".repeat(32) } })).toThrow(
      /witness orderId/,
    );
    expect(() =>
      assertEscrowBinding({ ...good, pullAuth: p2 as unknown as EscrowBinding["pullAuth"] }),
    ).toThrow(/witness orderId/);
  });

  it.each(["", " 100000000", "0x5f5e100", "1e8", "-1", "100000000.0"])(
    "rejects a non-decimal uint string %j instead of coercing it",
    (bad) => {
      expect(() => assertEscrowBinding({ ...good, minOut: bad })).toThrow(/base-10 uint256/);
      expect(() => computeOrderId({ ...terms, fromAmount: bad })).toThrow(/base-10 uint256/);
      expect(() => computeDestCommitment({ ...opening, toAmount: bad })).toThrow(/base-10 uint256/);
    },
  );

  it("rejects a uint256 overflow and an unsafe number", () => {
    expect(() => computeOrderId({ ...terms, fillDeadline: (1n << 256n).toString() })).toThrow(/uint256/);
    expect(() => computeOrderId({ ...terms, fromAmount: 2 ** 60 })).toThrow(/base-10 uint256/);
  });
});

describe("deriveDestBlinding", () => {
  it("rejects a zero-length key", () => {
    expect(() => deriveDestBlinding(new Uint8Array(0), 8453, ESCROW, "intent-0001")).toThrow(/non-empty/);
    expect(() => deriveDestBlinding("0x", 8453, ESCROW, "intent-0001")).toThrow(/non-empty/);
  });

  it("rejects a non-decimal fromChainId", () => {
    expect(() => deriveDestBlinding("0x01", "0x2105", ESCROW, "intent-0001")).toThrow(/base-10 uint256/);
  });
});
