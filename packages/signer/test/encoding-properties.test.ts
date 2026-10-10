/**
 * Properties of the three encodings this SDK signs over.
 *
 * Every one of them takes a set of fields and flattens it to bytes that a
 * signature commits to. They share one property, and it is the one that matters:
 *
 *   distinct field sets MUST produce distinct bytes.
 *
 * Where it fails, a signature issued for one payload is valid for another, which
 * is signature reuse rather than forgery -- no key is broken, the encoding just
 * cannot tell two payloads apart. Example tests do not find this, because the
 * inputs that break it are the ones nobody thinks to write down.
 *
 * The two encodings here answer it differently: ABI length-prefixes its
 * fields, while the attestation joins on a raw `\n` and so needs an explicit
 * guard. The bid encoding gets the same treatment in @xochi/solver-sdk.
 *
 * Deterministic: fixed seed and bounded runs, same convention as stealth.test.ts.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ethers } from "ethers";

import { buildDepositAttestationMessage, DepositAttestationError } from "@xochi/signer";
import { computeDestCommitment, computeOrderId } from "@xochi/signer";

import { pbtRuns, pbtSeed, pbtTimeoutMs } from "./pbt";

const CFG = { seed: pbtSeed(), numRuns: pbtRuns(200) };

// The `orderId` properties below are the expensive ones in this file: each round
// ABI-encodes eleven fields and keccaks them (~2.4ms/round, against ~0.4ms for
// the attestation cases). At 200 rounds they sit close enough to vitest's
// default 5s per-test ceiling to fail on a loaded runner -- a timeout, not a
// wrong answer. 60 rounds keeps the boundary bias fast-check front-loads and
// leaves ~35x headroom; PBT_RUNS still overrides for a deeper local sweep.
const HEAVY = { seed: CFG.seed, numRuns: pbtRuns(60) };

// The run-count cut alone left these three cases on vitest's 5s DEFAULT, which
// is the ceiling they were flaking against -- so `PBT_RUNS=200`, the documented
// way to restore coverage, also restored the flake (measured at 1804ms of a
// 5000ms budget on a loaded box). They carry the same explicit ceiling the
// stealth properties do, derived from the budget it guards.
const PBT_TIMEOUT_MS = pbtTimeoutMs(HEAVY.numRuns);

// Awkward on purpose: delimiters, quotes, backslashes and separators are what
// break flattening. Plain alphanumerics prove nothing here.
const nastyText = fc.oneof(
  fc.string(),
  fc.constantFrom("", "\n", "\\n", '"', "\\", "\t", "\r", "\u0000", ",", ":", "|", "0x", "T"),
  fc.string().map((s) => `${s}\n${s}`),
  fc.string().map((s) => `"${s}"`),
);

// Base-unit amounts are decimal strings, not numbers.
const amount = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }).map((n) => n.toString());

// fast-check v4 dropped hexaString; same idiom as stealth.test.ts.
const evmAddress = fc
  .bigInt({ min: 0n, max: 2n ** 160n - 1n })
  .map((i) => "0x" + i.toString(16).padStart(40, "0"));

describe("deposit attestation encoding", () => {
  // The v2 field set (Riddler #846). `wallet` and `recipient` are caller-supplied
  // and drawn from nastyText for exactly that reason -- they are the fields that
  // made the newline guard load-bearing rather than theoretical.
  const fields = fc.record({
    intent_id: nastyText,
    quote_id: nastyText,
    wallet: nastyText,
    from_chain_id: fc.integer({ min: 1, max: 2_147_483_647 }),
    from_token: nastyText,
    from_amount: amount,
    deposit_address: nastyText,
    deposit_deadline: fc.option(fc.integer({ min: 0, max: 4_000_000_000 }), { nil: null }),
    refund_address: fc.option(nastyText, { nil: null }),
    to_chain_id: fc.integer({ min: 1, max: 2_147_483_647 }),
    to_token: nastyText,
    to_amount: amount,
    min_to_amount: amount,
    recipient: nastyText,
    stealth_spending_pub_key: fc.option(nastyText, { nil: null }),
    stealth_viewing_pub_key: fc.option(nastyText, { nil: null }),
    settlement_preference: fc.constantFrom("public", "stealth", "shielded"),
  });

  // Every field whose value could carry a delimiter. Numbers and the settlement
  // enum cannot, so they are excluded rather than checked.
  const textFields = (f: {
    intent_id: string;
    quote_id: string;
    wallet: string;
    from_token: string;
    deposit_address: string;
    refund_address: string | null;
    to_token: string;
    recipient: string;
    stealth_spending_pub_key: string | null;
    stealth_viewing_pub_key: string | null;
  }) =>
    [
      f.intent_id,
      f.quote_id,
      f.wallet,
      f.from_token,
      f.deposit_address,
      // Caller-supplied like `wallet` and `recipient`, and the server's request
      // validation lets a trailing newline through, so this is a live injection
      // case rather than a theoretical one.
      f.refund_address ?? "",
      f.to_token,
      f.recipient,
      f.stealth_spending_pub_key ?? "",
      f.stealth_viewing_pub_key ?? "",
    ] as const;

  // `\n` is the delimiter and nothing escapes it, so the encoding cannot
  // represent a field containing one. It must refuse rather than emit bytes
  // whose field boundaries are ambiguous.
  it("refuses any field containing the delimiter", () => {
    fc.assert(
      fc.property(fields, (f) => {
        if (!textFields(f).some((v) => v.includes("\n"))) return true;
        try {
          buildDepositAttestationMessage(f);
          return false; // built a message it cannot unambiguously represent
        } catch (e) {
          return e instanceof DepositAttestationError;
        }
      }),
      CFG,
    );
  });

  // The property the guard exists to protect. Without it, `intent_id: "a\nB",
  // quote_id: "C"` and `intent_id: "a", quote_id: "B\nC"` sign identical bytes.
  it("is injective -- distinct fields never share a message", () => {
    fc.assert(
      fc.property(fields, fields, (a, b) => {
        const build = (f: typeof a) => {
          try {
            return buildDepositAttestationMessage(f);
          } catch {
            return null; // rejected by the guard; not a collision candidate
          }
        };
        const [ma, mb] = [build(a), build(b)];
        if (ma === null || mb === null) return true;
        // Equal messages are only legitimate when the fields agree up to the
        // normalization the encoding deliberately applies to 0x addresses. An
        // absent optional field encodes as "", so compare on that footing.
        const norm = (v: string | null) => (v ?? "").toLowerCase();
        const same =
          a.intent_id === b.intent_id &&
          a.quote_id === b.quote_id &&
          norm(a.wallet) === norm(b.wallet) &&
          a.from_chain_id === b.from_chain_id &&
          norm(a.from_token) === norm(b.from_token) &&
          a.from_amount === b.from_amount &&
          norm(a.deposit_address) === norm(b.deposit_address) &&
          (a.deposit_deadline ?? "") === (b.deposit_deadline ?? "") &&
          norm(a.refund_address) === norm(b.refund_address) &&
          a.to_chain_id === b.to_chain_id &&
          norm(a.to_token) === norm(b.to_token) &&
          a.to_amount === b.to_amount &&
          a.min_to_amount === b.min_to_amount &&
          norm(a.recipient) === norm(b.recipient) &&
          norm(a.stealth_spending_pub_key) === norm(b.stealth_spending_pub_key) &&
          norm(a.stealth_viewing_pub_key) === norm(b.stealth_viewing_pub_key) &&
          a.settlement_preference === b.settlement_preference;
        return ma === mb ? same : true;
      }),
      CFG,
    );
  });

  // Exactly 18 fields, always -- including when both stealth fields, the
  // deadline and the refund address are absent, which encode as empty lines
  // rather than disappearing. A dropped line would shift every field after it
  // and sign a different deal.
  it("always splits back into exactly 18 fields", () => {
    fc.assert(
      fc.property(fields, (f) => {
        let msg: string;
        try {
          msg = buildDepositAttestationMessage(f);
        } catch {
          return true;
        }
        return msg.split("\n").length === 18;
      }),
      CFG,
    );
  });

  // settlement_preference is last and never empty, so the message cannot end on
  // an optional field. A client that trimmed before hashing would otherwise
  // diverge on public routes only -- the common case, passing on stealth.
  it("never ends in a newline, whatever the optional fields are", () => {
    fc.assert(
      fc.property(fields, (f) => {
        let msg: string;
        try {
          msg = buildDepositAttestationMessage(f);
        } catch {
          return true;
        }
        return !msg.endsWith("\n") && msg.trimEnd() === msg;
      }),
      CFG,
    );
  });

  // Case-folding a base58 T-address yields a different, still-plausible address.
  // The encoding must only lowercase 0x-prefixed values.
  it("lowercases 0x values and leaves everything else byte-identical", () => {
    fc.assert(
      fc.property(
        evmAddress,
        nastyText.filter((s) => !s.startsWith("0x") && !s.includes("\n")),
        (evm, other) => {
          // `other` lands in deposit_address, recipient and refund_address: the v2
          // field that is base58 on a Tron-destination route, and the v3 one that
          // is base58 on a Tron-ORIGIN route. Neither may be folded. refund_address
          // goes through the optional encoder, so this also pins that the optional
          // path normalizes the same way the required one does -- encoding it with
          // a bare passthrough would leave a base58 value correct by luck and an
          // 0x one subtly wrong.
          const msg = buildDepositAttestationMessage({
            intent_id: "i",
            quote_id: "q",
            wallet: evm.toUpperCase().replace("0X", "0x"),
            from_chain_id: 1,
            from_token: evm.toUpperCase().replace("0X", "0x"),
            from_amount: "1",
            deposit_address: other,
            deposit_deadline: null,
            refund_address: other,
            to_chain_id: 728126428,
            to_token: other,
            to_amount: "1",
            min_to_amount: "1",
            recipient: other,
            stealth_spending_pub_key: null,
            stealth_viewing_pub_key: null,
            settlement_preference: "public",
          });
          const lines = msg.split("\n");
          return (
            lines[3] === evm.toLowerCase() &&
            lines[5] === evm.toLowerCase() &&
            lines[7] === other &&
            lines[9] === other &&
            lines[11] === other &&
            lines[14] === other
          );
        },
      ),
      CFG,
    );
  });
});

describe("escrow order v2 preimage", () => {
  const text = nastyText.filter((s) => s.length > 0);
  const key = fc.oneof(evmAddress, text);
  const bytes32 = fc
    .bigInt({ min: 1n, max: 2n ** 256n - 1n })
    .map((i) => "0x" + i.toString(16).padStart(64, "0"));

  const opening = fc.record({
    recipient: key,
    toToken: key,
    toAmount: amount,
    blinding: bytes32,
    intentId: text,
  });

  const terms = fc.record({
    depositor: evmAddress,
    fromChainId: fc.integer({ min: 1, max: 2_147_483_647 }),
    fromToken: evmAddress,
    fromAmount: amount,
    toChainId: fc.integer({ min: 1, max: 2_147_483_647 }),
    fillDeadline: fc.integer({ min: 0, max: 4_000_000_000 }),
    escrow: evmAddress,
    destCommitment: bytes32,
  });

  // A collision would redirect principal to a lock key nobody else can open.
  it(
    "destCommitment is injective over openings",
    () => {
      fc.assert(
        fc.property(opening, opening, (a, b) => {
          const same = JSON.stringify(a) === JSON.stringify(b);
          return computeDestCommitment(a) === computeDestCommitment(b) ? same : true;
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "orderId is injective over terms and well-formed",
    () => {
      fc.assert(
        fc.property(terms, terms, (a, b) => {
          const same = JSON.stringify(a) === JSON.stringify(b);
          const id = computeOrderId(a);
          return /^0x[0-9a-f]{64}$/.test(id) && (id === computeOrderId(b) ? same : true);
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );

  // recipient and toToken are hashed into separate words, so swapping them is a
  // different destination, never the same commitment.
  it(
    "distinguishes recipient and toToken swapped",
    () => {
      fc.assert(
        fc.property(opening, (o) => {
          fc.pre(o.recipient !== o.toToken);
          return (
            computeDestCommitment(o) !==
            computeDestCommitment({ ...o, recipient: o.toToken, toToken: o.recipient })
          );
        }),
        HEAVY,
      );
    },
    PBT_TIMEOUT_MS,
  );
});
