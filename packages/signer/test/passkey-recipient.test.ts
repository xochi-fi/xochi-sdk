// Passkey recipient keys (xochi-sdk#155, epic xochi#833): the WebAuthn PRF outputs of one
// passkey derive the recipient's Aztec account secrets and the key that wraps an imported
// CLI recipient.
//
// Anchors this repo cannot edit: the decision text's labels (hashed here with node's own
// SHA-256 and HKDF, never @noble/hashes) and its reference values.

import { createHash, hkdfSync } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  AZTEC_FIELD_MODULUS,
  PASSKEY_DERIVATION_V1,
  PASSKEY_PRF_INPUTS,
  PASSKEY_RP_ID,
  PasskeyDerivationError,
  derivePasskeyRecipientKeys,
} from "@xochi/signer";

const sha256 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

// Decision text (epic xochi#833, contract A.3).
const DECIDED = [
  {
    name: "zeros-ones",
    first: new Uint8Array(32),
    second: new Uint8Array(32).fill(1),
    secret: "0x16e61e8361407b35f5355c5a84878cf653f211f0747e0f5070623fcd4a6f7e82",
    salt: "0x09976444a011a99a61e1c10045618355e1a0170df7322cba11d1230c8c916679",
    wrapKey: "0x88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b",
  },
  {
    name: "sha256-labels",
    first: sha256("TEST ONLY prf first"),
    second: sha256("TEST ONLY prf second"),
    secret: "0x25a853a998db29033e2736b012009c2fc43020ed8bb69367683a7c2a8e7af0b6",
    salt: "0x17d0b81b79aa82aab662c3789626002c5b713e92cb2610a978271c73ddedede7",
    wrapKey: "0x1154a7392a60a14f07d534d42df8d0231aff0842ef8b230615b02557ba6f2c94",
  },
];

function refusalOf(fn: () => unknown): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof PasskeyDerivationError)) throw e;
    return { code: e.code, field: e.field };
  }
}

describe("passkey derivation constants", () => {
  it("pins the relying party, version and PRF eval inputs", () => {
    expect(PASSKEY_RP_ID).toBe("xochi.fi");
    expect(PASSKEY_DERIVATION_V1).toBe(1);
    expect(PASSKEY_PRF_INPUTS).toEqual({
      first: hex(sha256("xochi.recipient.passkey.v1/prf/account")),
      second: hex(sha256("xochi.recipient.passkey.v1/prf/wrap")),
    });
    expect(PASSKEY_PRF_INPUTS.first).toBe(
      "0xda78e1a895e2650478d184cb97b68a58a700ebbc2fd12d57a394873c93439dea",
    );
    expect(PASSKEY_PRF_INPUTS.second).toBe(
      "0x76b121dc2850fb29af74dcd8357c9c9fd4992d2990cdcd3144c704220b83fda4",
    );
    expect(Object.isFrozen(PASSKEY_PRF_INPUTS)).toBe(true);
  });
});

describe("derivePasskeyRecipientKeys", () => {
  it.each(DECIDED)("reproduces the decided vector $name", (v) => {
    const keys = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    expect(keys.secret).toBe(v.secret);
    expect(keys.salt).toBe(v.salt);
    expect(keys.wrapKey).toBeInstanceOf(Uint8Array);
    expect(hex(keys.wrapKey)).toBe(v.wrapKey);
    expect(derivePasskeyRecipientKeys({ first: v.first, second: v.second }, 1)).toEqual(keys);
  });

  it.each(DECIDED)("matches node's RFC 5869 HKDF for $name", (v) => {
    const salt = Buffer.from("xochi.recipient.passkey.v1");
    const okm = (ikm: Uint8Array, info: string, length: number) =>
      new Uint8Array(hkdfSync("sha256", ikm, salt, `xochi.recipient.passkey.v1/${info}`, length));
    const field = (b: Uint8Array) =>
      "0x" + (BigInt(hex(b)) % AZTEC_FIELD_MODULUS).toString(16).padStart(64, "0");
    const keys = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    expect(keys.secret).toBe(field(okm(v.first, "account-secret", 64)));
    expect(keys.salt).toBe(field(okm(v.first, "account-salt", 64)));
    expect(hex(keys.wrapKey)).toBe(hex(okm(v.second, "wrap-key", 32)));
  });

  it("returns a fresh wrap key and leaves the PRF outputs untouched", () => {
    const v = DECIDED[1]!;
    const first = v.first.slice();
    const second = v.second.slice();
    const a = derivePasskeyRecipientKeys({ first, second });
    a.wrapKey.fill(0);
    const b = derivePasskeyRecipientKeys({ first, second });
    expect(hex(b.wrapKey)).toBe(v.wrapKey);
    expect(hex(first)).toBe(hex(v.first));
    expect(hex(second)).toBe(hex(v.second));
  });

  it("refuses PRF outputs that are not exactly 32 bytes", () => {
    const ok = new Uint8Array(32);
    const cases: [unknown, unknown, string][] = [
      [new Uint8Array(31), ok, "prf.first"],
      [new Uint8Array(33), ok, "prf.first"],
      [new Uint8Array(0), ok, "prf.first"],
      [undefined, ok, "prf.first"],
      [new Uint8Array(32).buffer, ok, "prf.first"],
      [hex(ok), ok, "prf.first"],
      [Array.from(ok), ok, "prf.first"],
      [ok, new Uint8Array(31), "prf.second"],
      [ok, null, "prf.second"],
    ];
    for (const [first, second, field] of cases) {
      expect(
        refusalOf(() => derivePasskeyRecipientKeys({ first, second } as never)),
        `${field} ${String(first)?.slice(0, 12)}`,
      ).toEqual({ code: "prf_output_invalid", field });
    }
    expect(refusalOf(() => derivePasskeyRecipientKeys(null as never))).toEqual({
      code: "prf_output_invalid",
      field: "prf",
    });
  });

  it("refuses every derivation version but 1", () => {
    const prf = { first: DECIDED[0]!.first, second: DECIDED[0]!.second };
    for (const version of [0, 2, "1", 1.5, null]) {
      expect(refusalOf(() => derivePasskeyRecipientKeys(prf, version as never))).toEqual({
        code: "unsupported_version",
        field: "version",
      });
    }
  });

  it("never copies PRF bytes into a refusal message", () => {
    const first = new Uint8Array(31).fill(0xab);
    let message = "";
    try {
      derivePasskeyRecipientKeys({ first, second: new Uint8Array(32) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("prf.first: prf_output_invalid (expected 32 bytes, got 31)");
    expect(message).not.toMatch(/abab/);
  });
});
