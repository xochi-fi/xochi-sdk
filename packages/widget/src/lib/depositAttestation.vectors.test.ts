/**
 * The widget's deposit-attestation path against the PRODUCER's vectors.
 *
 * The widget has no encoder of its own: a live quote is checked by
 * `@xochi/client`'s `checkDepositQuote` and a restored one by
 * `verifyStoredDeposit`, both of which call `@xochi/signer`'s
 * `verifyDepositAttestation` (and its `recipientIsDestinationToken` guard). So
 * this pins the installed signer, through the widget's own dependency tree,
 * against `deposit-attestation-vectors.json`, vendored verbatim from Riddler's
 * `priv/conformance/deposit_attestation.json` (the same file xochi vendors).
 * Never hand-edit it; a failure means the signer and the solver have parted.
 *
 * Riddler#1254: `to_token` and `recipient` can hold a Canton party
 * (`hint::1220<64 hex>`), whose hint is case-sensitive text that may open with
 * `0x`. Only a value that is ENTIRELY 0x-hex is lowercased there, so
 * `0xAlice::...` and `0xalice::...` are two parties with two messages.
 */

import { describe, expect, it } from "vitest";
import {
  buildDepositAttestationMessage,
  recoverDepositAttestationSigner,
  recipientIsDestinationToken,
  type DepositAttestationFields,
} from "@xochi/signer";
import { verifyStoredDeposit } from "@xochi/client";
import vectorFile from "./deposit-attestation-vectors.json";

interface Vector {
  name: string;
  message: string;
  deposit_attestation: string;
  quote: DepositAttestationFields;
}

const FIXTURE = vectorFile as unknown as { version: string; signer: string; vectors: Vector[] };

const vector = (name: string): Vector => {
  const found = FIXTURE.vectors.find((v) => v.name === name);
  if (!found) throw new Error(`no vector ${name}`);
  return found;
};

const CANTON = vector("canton_party_recipient_case_preserved");
const CANTON_FOLDED = vector("canton_party_hint_case_is_a_different_party");

const restore = (v: Vector) =>
  verifyStoredDeposit({ attested: v.quote, attestation: v.deposit_attestation }, FIXTURE.signer, {
    intentId: v.quote.intent_id,
    owner: v.quote.wallet,
  });

describe("deposit attestation: producer conformance vectors", () => {
  it.each(FIXTURE.vectors.map((v) => [v.name, v] as const))(
    "%s: rebuilds the solver's message and recovers its signer",
    (_name, v) => {
      expect(buildDepositAttestationMessage(v.quote)).toBe(v.message);
      expect(recoverDepositAttestationSigner(v.quote, v.deposit_attestation)).toBe(FIXTURE.signer);
    },
  );
});

describe("deposit attestation: Canton party case (Riddler#1254)", () => {
  it("signs a mixed-case 0x-prefixed party verbatim", () => {
    expect(CANTON.quote.recipient).toMatch(/^0xAlice::1220/);
    const lines = buildDepositAttestationMessage(CANTON.quote).split("\n");
    expect(lines[14]).toBe(CANTON.quote.recipient);
    // The 0x-hex wallet in the same message is still folded.
    expect(lines[3]).toBe(CANTON.quote.wallet.toLowerCase());
  });

  it("verifies a restored mixed-case Canton binding through the widget's client", () => {
    expect(restore(CANTON)).toMatchObject({ ok: true });
    expect(restore(CANTON_FOLDED)).toMatchObject({ ok: true });
  });

  it("does not let one party's attestation verify the other party's deal", () => {
    expect(CANTON.message).not.toBe(CANTON_FOLDED.message);
    const swapped = verifyStoredDeposit(
      { attested: CANTON.quote, attestation: CANTON_FOLDED.deposit_attestation },
      FIXTURE.signer,
      { intentId: CANTON.quote.intent_id, owner: CANTON.quote.wallet },
    );
    expect(swapped).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("compares a Canton party to the destination token case-exactly", () => {
    const party = "0xAlice::1220" + "3e".repeat(32);
    expect(recipientIsDestinationToken(party, party)).toBe(true);
    expect(recipientIsDestinationToken(party, party.replace("Alice", "alice"))).toBe(false);
    // An EVM address still matches across checksum case.
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(recipientIsDestinationToken(usdc, usdc.toLowerCase())).toBe(true);
  });
});
