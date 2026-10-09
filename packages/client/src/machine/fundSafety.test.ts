/**
 * The `@riddler/signer` checks the machine runs at quote ingest, driven through
 * `update` exactly as a host drives it. No mocks: deposit attestations are real
 * EIP-191 signatures by published Anvil test keys, and every refusal is read off
 * the model and the effects.
 *
 * The signer bounds deadlines against the wall clock and takes no `now`, so the
 * served deadlines here are built from `Date.now()` where the bound matters, and
 * from the fixtures' past T0 where only "not too far ahead" is asserted.
 */

import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildDepositAttestationMessage, type DepositAttestationFields } from "@riddler/signer";
import { TRON_CHAIN_ID } from "../shared/index.js";
import type { MachineConfig } from "./machine.js";
import { verifyStoredDeposit } from "./deposit.js";
import type { QuoteResponse } from "./wire.js";
import {
  AMOUNT,
  ATTACKER,
  CONFIG,
  SOLVER,
  TO_AMOUNT,
  WALLET,
  WETH_ARBITRUM,
  Session,
  apiCalls,
  ctx,
  erc3009Pull,
  intentTypedData,
  logs,
  only,
  quote,
  walletCalls,
} from "./test/session.js";

/** Anvil account 0 and 1: public test keys, not secrets. */
const ATTESTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ATTESTER = privateKeyToAccount(ATTESTER_KEY).address;

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DEPOSIT_ADDRESS = "TCwnBmvhtqLpBiKrFEfMzXWCq1YB2sPX8N";
const REFUND = "TQ5NMqJjHEuBSyqAJqiZKYHRLmVYFvQvsP";
const MIN_TO_AMOUNT = "497500000000000";

const REFUSED_QUOTE = "This quote did not match the requested trade, so it cannot be signed.";
const REFUSED_DEPOSIT = "This deposit route is not available right now.";

// ============================================================
// Signable (pull-route) quotes
// ============================================================

describe("intent checked against the request at ingest", () => {
  it("accepts the honest quote and signs it", () => {
    const s = new Session();
    s.quoteWith(quote());
    expect(s.intent.status).toBe("quoted");
    expect(only(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).purpose).toBe(
      "intent",
    );
  });

  it.each([
    ["recipient", { recipient: ATTACKER }],
    ["wallet", { wallet: ATTACKER }],
    ["fromAmount", { fromAmount: "2000000" }],
    ["fromToken", { fromToken: ATTACKER }],
    ["toChainId", { toChainId: 10 }],
    ["settlementPreference", { settlementPreference: "stealth" }],
  ])("refuses an intent whose %s differs from the request", (field, over) => {
    const s = new Session();
    const fx = s.quoteWith(quote({ eip712Data: intentTypedData(over) }));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.quote).toBeNull();
    expect(s.intent.error).toBe(REFUSED_QUOTE);
    expect(logs(fx, "error")).toContain(
      "[useIntent] Refusing a quote that does not match the request:",
    );
    const logged = fx.find(
      (e) => e.type === "Emit" && e.event.kind === "log" && e.event.level === "error",
    );
    expect(JSON.stringify(logged)).toContain(`intent ${field}`);
    // Nothing to sign: Confirm finds no quote.
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toHaveLength(0);
  });

  it("refuses an intent deadline more than an hour past the wall clock", () => {
    const s = new Session();
    s.quoteWith(
      quote({ eip712Data: intentTypedData({ deadline: Math.floor(Date.now() / 1000) + 7200 }) }),
    );
    expect(s.intent.status).toBe("failed");
    expect(s.intent.error).toBe(REFUSED_QUOTE);
  });

  it("keeps the held quote when a silent refresh is refused", () => {
    // A refresh under an open confirm surface is silent; a refused one must not
    // replace the quote the user is reading, and must not sign either.
    const s = new Session(ctx({ paused: true }));
    s.quoteWith(quote());
    const refresh = only(
      apiCalls(s.send({ type: "TimerFired", timer: "refresh" }, 55_000), "quote"),
    );
    s.send({
      type: "QuoteReplied",
      flight: refresh.flight,
      result: {
        ok: true,
        quote: quote({ quoteId: "xq_2", eip712Data: intentTypedData({ recipient: ATTACKER }) }),
      },
    });
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.quoteId).toBe("xq_1");
  });
});

describe("origin pull checked against the intent at ingest", () => {
  it("refuses a pull on another chain", () => {
    const pull = erc3009Pull();
    const s = new Session();
    s.quoteWith(quote({ pullAuthorization: { ...pull, domain: { ...pull.domain, chainId: 10 } } }));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.error).toBe(REFUSED_QUOTE);
  });

  it("refuses a pull for more than the intent moves", () => {
    const s = new Session();
    s.quoteWith(quote({ pullAuthorization: erc3009Pull(SOLVER, "1000001") }));
    expect(s.intent.status).toBe("failed");
  });

  it("refuses a pull that outlives the intent by more than the ceiling", () => {
    const pull = erc3009Pull();
    const s = new Session();
    s.quoteWith(
      quote({
        pullAuthorization: {
          ...pull,
          message: {
            ...pull.message,
            validBefore: Number(intentTypedData().message.deadline) + 3601,
          },
        },
      }),
    );
    expect(s.intent.status).toBe("failed");
  });

  const pinned: MachineConfig = {
    ...CONFIG,
    pullRecipients: { 8453: { erc3009: SOLVER, permit2: ATTACKER } },
  };

  it("accepts a pull to the pinned recipient", () => {
    const s = new Session(ctx(), pinned);
    s.quoteWith(quote({ pullAuthorization: erc3009Pull() }));
    expect(s.intent.status).toBe("quoted");
  });

  it("refuses a pull to an address the caller did not pin, before any prompt", () => {
    // The machine's own solver allowlist would also refuse this, but only after
    // signature 1, at the approval step. The pin refuses it at ingest.
    const s = new Session(ctx(), {
      ...pinned,
      solverPin: { ...CONFIG.solverPin, erc3009Allowlist: [ATTACKER.toLowerCase()] },
    });
    const fx = s.quoteWith(quote({ pullAuthorization: erc3009Pull(ATTACKER) }));
    expect(s.intent.status).toBe("failed");
    expect(JSON.stringify(fx)).toContain("pull_mismatch");
  });

  it("refuses a pinned chain that names no pin for the method served", () => {
    const s = new Session(ctx(), { ...CONFIG, pullRecipients: { 8453: { permit2: SOLVER } } });
    s.quoteWith(quote({ pullAuthorization: erc3009Pull() }));
    expect(s.intent.status).toBe("failed");
  });
});

// ============================================================
// Deposit routes
// ============================================================

const depositCtx = () =>
  ctx({ fromChainId: TRON_CHAIN_ID, fromToken: TRON_USDT, refundAddress: REFUND });

function signedFields(over: Partial<DepositAttestationFields> = {}): DepositAttestationFields {
  return {
    intent_id: "xi_dep1",
    quote_id: "xq_dep1",
    wallet: WALLET,
    from_chain_id: TRON_CHAIN_ID,
    from_token: TRON_USDT,
    from_amount: AMOUNT,
    deposit_address: DEPOSIT_ADDRESS,
    deposit_deadline: Math.floor(Date.now() / 1000) + 1800,
    refund_address: REFUND,
    to_chain_id: 42161,
    to_token: WETH_ARBITRUM,
    to_amount: TO_AMOUNT,
    min_to_amount: MIN_TO_AMOUNT,
    recipient: WALLET,
    stealth_spending_pub_key: null,
    stealth_viewing_pub_key: null,
    settlement_preference: "public",
    ...over,
  };
}

async function attest(
  fields: DepositAttestationFields,
  key: `0x${string}` = ATTESTER_KEY,
): Promise<string> {
  return privateKeyToAccount(key).signMessage({ message: buildDepositAttestationMessage(fields) });
}

function depositQuote(
  fields: DepositAttestationFields,
  attestation: string | undefined,
): QuoteResponse {
  return quote({
    intentId: fields.intent_id,
    quoteId: fields.quote_id,
    toAmount: fields.to_amount,
    minToAmount: fields.min_to_amount,
    paymentMethod: "deposit",
    gasless: false,
    eip712Data: undefined,
    depositAddress: fields.deposit_address,
    depositAttestation: attestation,
    depositDeadline: fields.deposit_deadline ?? undefined,
    settlementType: "public",
  });
}

/** Allocate a Tron deposit route and answer it with `served`. */
function allocate(s: Session, served: QuoteResponse) {
  s.send({ type: "QuoteRequested", amount: AMOUNT });
  const session = only(
    walletCalls(s.send({ type: "AllocateRequested", key: "k1", ref: "r1" }), "ensureSession"),
  );
  const call = only(
    apiCalls(s.send({ type: "SessionReplied", flight: session.flight, result: "ok" }), "quote"),
  );
  return s.send({ type: "QuoteReplied", flight: call.flight, result: { ok: true, quote: served } });
}

const DEPOSIT_CONFIG: MachineConfig = { ...CONFIG, depositAttestationSigner: ATTESTER };

describe("deposit attestation verified by the signer at ingest", () => {
  it("accepts a route attested by the pinned signer and stores the verified binding", async () => {
    const fields = signedFields();
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    const attestation = await attest(fields);
    allocate(s, depositQuote(fields, attestation));
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.attestedDeposit).toEqual({ attested: fields, attestation });
    expect(s.model.seenDepositAddresses).toEqual({ [DEPOSIT_ADDRESS]: "xi_dep1" });
    // No signature on a deposit route: Confirm reveals the address.
    s.send({ type: "SignRequested" });
    expect(s.intent.status).toBe("awaiting_deposit");
  });

  it("refuses every deposit route when no signer is pinned", async () => {
    const fields = signedFields();
    const s = new Session(depositCtx(), CONFIG);
    allocate(s, depositQuote(fields, await attest(fields)));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.error).toBe(REFUSED_DEPOSIT);
  });

  it("refuses an attestation by another key", async () => {
    const fields = signedFields();
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(s, depositQuote(fields, await attest(fields, OTHER_KEY)));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.attestedDeposit).toBeNull();
  });

  it("refuses a quote whose served terms differ from the signed ones", async () => {
    const signed = signedFields();
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(s, depositQuote({ ...signed, to_amount: "1" }, await attest(signed)));
    expect(s.intent.status).toBe("failed");
  });

  it("refuses a genuine attestation for a different refund address", async () => {
    // Replaying the victim's request with an attacker's refund address yields a
    // genuine signature over a different deal; the request side rebuilds REFUND.
    const theirs = signedFields({ refund_address: "TJYeasTPa6gpEEfYGfp5LQjWXmdZQBpLzX" });
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(s, depositQuote(theirs, await attest(theirs)));
    expect(s.intent.status).toBe("failed");
  });

  it("refuses an absent or malformed attestation", async () => {
    const fields = signedFields();
    const absent = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(absent, depositQuote(fields, undefined));
    expect(absent.intent.status).toBe("failed");

    // A 64-byte EIP-2098 compact signature: recoverable in general, never served.
    const compact = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(compact, depositQuote(fields, "0x" + "ab".repeat(64)));
    expect(compact.intent.status).toBe("failed");
  });

  it("refuses a route whose attested window is under a minute", async () => {
    const fields = signedFields({ deposit_deadline: Math.floor(Date.now() / 1000) + 30 });
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(s, depositQuote(fields, await attest(fields)));
    expect(s.intent.status).toBe("failed");
  });

  it("refuses a route served under another settlement type, naming it", async () => {
    const fields = signedFields();
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    const fx = allocate(s, {
      ...depositQuote(fields, await attest(fields)),
      settlementType: "stealth",
    });
    expect(s.intent.status).toBe("failed");
    expect(JSON.stringify(fx)).toContain(
      "quote resolved settlement type stealth but public was requested",
    );
  });

  it("refuses an address re-issued under another intent, with the reuse copy", async () => {
    const first = signedFields();
    const s = new Session(depositCtx(), DEPOSIT_CONFIG);
    allocate(s, depositQuote(first, await attest(first)));
    expect(s.intent.status).toBe("quoted");

    const second = signedFields({ intent_id: "xi_dep2", quote_id: "xq_dep2" });
    s.send({ type: "ResetRequested" });
    allocate(s, depositQuote(second, await attest(second)));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.error).toBe(
      "We were given a deposit address that was already in use. Reload the page and try again.",
    );
  });
});

describe("verifyStoredDeposit (resume)", () => {
  it("accepts a stored binding for its own intent and owner", async () => {
    const fields = signedFields();
    const stored = { attested: fields, attestation: await attest(fields) };
    expect(
      verifyStoredDeposit(stored, ATTESTER, {
        intentId: "xi_dep1",
        owner: WALLET.toUpperCase().replace("0X", "0x"),
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a binding transplanted into another owner's record", async () => {
    const fields = signedFields();
    const stored = { attested: fields, attestation: await attest(fields) };
    expect(verifyStoredDeposit(stored, ATTESTER, { intentId: "xi_dep1", owner: ATTACKER }).ok).toBe(
      false,
    );
    expect(verifyStoredDeposit(stored, ATTESTER, { intentId: "xi_other", owner: WALLET }).ok).toBe(
      false,
    );
  });

  it("refuses a tampered stored field, and does not apply the deposit window", async () => {
    const fields = signedFields({ deposit_deadline: Math.floor(Date.now() / 1000) - 600 });
    const attestation = await attest(fields);
    expect(
      verifyStoredDeposit({ attested: fields, attestation }, ATTESTER, {
        intentId: "xi_dep1",
        owner: WALLET,
      }),
    ).toEqual({ ok: true });
    const tampered = {
      attested: { ...fields, deposit_address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf" },
      attestation,
    };
    expect(verifyStoredDeposit(tampered, ATTESTER, { intentId: "xi_dep1", owner: WALLET }).ok).toBe(
      false,
    );
    expect(
      verifyStoredDeposit({ attested: fields, attestation }, null, {
        intentId: "xi_dep1",
        owner: WALLET,
      }).ok,
    ).toBe(false);
  });
});
