/**
 * Another person's Stealth meta-address, as the Send tab accepts it.
 *
 * ERC-5564 scheme 1 encodes a recipient as `st:eth:0x` followed by two
 * compressed secp256k1 public keys, spending then viewing (33 bytes each), the
 * form `encodeMetaAddress` in `@xochi/signer` writes. Parsing is strict: the
 * prefix, the exact length, hex only, and both keys must be points on the
 * curve. Anything else is refused with a reason; nothing is repaired.
 *
 * Only public keys are held. The one-time address is derived from them by the
 * existing Stealth settlement (the quote request carries the meta-address, as
 * it does for the wallet's own keys), and the recipient finds the payment with
 * their own keys through the scanner in `lib/stealth.ts`.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { isCompromisedStealthSpendingPubKey } from "@xochi/signer";

/** A parsed meta-address: public keys only, lowercase `0x` hex. */
export interface StealthRecipient {
  /** The canonical `st:eth:0x...` form. */
  encoded: string;
  /** Compressed spending public key (33 bytes). */
  spendingPubKey: string;
  /** Compressed viewing public key (33 bytes). */
  viewingPubKey: string;
}

export type StealthRecipientCheck =
  | { ok: true; recipient: StealthRecipient }
  | { ok: false; error: string };

const PREFIX = "st:eth:0x";
/** Two 33-byte keys, two hex characters per byte. */
const BODY_HEX = 2 * 33 * 2;

function keyError(name: "spending" | "viewing", hex: string): string | null {
  const prefix = hex.slice(0, 2);
  if (prefix !== "02" && prefix !== "03") {
    return `The ${name} key is not a compressed public key (it must start with 02 or 03).`;
  }
  try {
    secp256k1.ProjectivePoint.fromHex(hex);
  } catch {
    return `The ${name} key is not a valid secp256k1 public key.`;
  }
  return null;
}

/**
 * Parse a pasted meta-address. Surrounding whitespace from a paste is ignored;
 * everything between the ends must be exact.
 */
export function parseStealthMetaAddress(input: string): StealthRecipientCheck {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, error: "Paste the recipient's stealth meta-address." };
  }
  if (!value.startsWith(PREFIX)) {
    return {
      ok: false,
      error: "A stealth meta-address starts with st:eth:0x. Ask the recipient for theirs.",
    };
  }
  const body = value.slice(PREFIX.length);
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    return { ok: false, error: "The meta-address has characters that are not hex." };
  }
  if (body.length !== BODY_HEX) {
    return {
      ok: false,
      error: `The meta-address is ${body.length} hex characters after st:eth:0x; it must be ${BODY_HEX}.`,
    };
  }
  const lower = body.toLowerCase();
  const spending = lower.slice(0, BODY_HEX / 2);
  const viewing = lower.slice(BODY_HEX / 2);
  const error = keyError("spending", spending) ?? keyError("viewing", viewing);
  if (error) return { ok: false, error };
  if (isCompromisedStealthSpendingPubKey(spending)) {
    return {
      ok: false,
      error:
        "This meta-address uses a publicly known spending key, so anyone could take a payment to it.",
    };
  }
  return {
    ok: true,
    recipient: {
      encoded: `${PREFIX}${lower}`,
      spendingPubKey: `0x${spending}`,
      viewingPubKey: `0x${viewing}`,
    },
  };
}

/** `st:eth:0x` and the first and last six hex characters. */
export function abbreviateMetaAddress(encoded: string): string {
  const body = encoded.slice(PREFIX.length);
  return body.length <= 12 ? encoded : `${PREFIX}${body.slice(0, 6)}...${body.slice(-6)}`;
}
