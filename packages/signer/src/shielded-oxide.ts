// OxideToken registration facts for the enrollment acknowledgement `TokenRegistrationAck`
// (xochi#753, OX-12). PROPOSED: the ack's fields and the rule below await product-owner
// confirmation on xochi#753.
//
// An OXDAI payout reaches a recipient only if the recipient's PXE has registered the
// OxideToken contract at the corridor's token address and run `store_immutables` with the
// token's immutables: the token's own note handler is the only one that accepts its notes,
// and it reads the immutables from a PXE capsule (zkmoney-public `8fd19841`,
// `oxide_token_contract` `delivery.nr:30, 173-265`, `immutables.nr:40-57`).
//
// What is here:
//   - `oxideTokenImmutablesHash`: the token instance's `immutablesHash`
//     (`poseidon2_hash_with_separator(serialize(immutables), DOM_SEP__TOKEN_IMMUTABLES)`,
//     `oxide_token_contract/src/immutables.nr:36`; the client copy is
//     `oxide-lib/src/token_immutables.ts`). The token's address commits to it, so a verifier
//     holding the corridor's immutables learns exactly which value the recipient must have
//     stored.
//   - `OXIDE_TOKEN_CLASS_IDS` and `requiredEnrollmentAcks`: which corridors require the ack.
//     Only a corridor whose token class is an OxideToken class does; every other corridor
//     (the testnet tracer's standard Token) keeps exactly the two-ack set.
//
// `conformance/shielded-recipient.json` `oxideToken` pins the values; aztec-crosscheck holds
// them to the real @aztec-labs 6.0.0 SDK and the deployed OXDAI address.

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { ethers } from "ethers";

import type { RecipientAckType } from "./shielded-recipient-acks";
import {
  assertAztecBytes32,
  evmAddress,
  withRefusalsAs,
  type ShieldedRefusal,
} from "./shielded-values";
import type { Hex } from "./types";

/** `DOM_SEP__TOKEN_IMMUTABLES` (`oxide_lib/src/constants.nr:34`). */
export const OXIDE_TOKEN_IMMUTABLES_SEPARATOR = 0x67a58cb3n;
/** Noir `FieldCompressedString`: at most 31 bytes of UTF-8. */
export const OXIDE_TOKEN_STRING_MAX_BYTES = 31;

/**
 * OxideToken classes whose corridors require `TokenRegistrationAck`. The OXDAI class on
 * Aztec v6 mainnet (`node_getContract(0x11d2...e0a3).currentContractClassId`, equal to
 * zkmoney-public's `EXPECTED_CLASS_ID`). A new OxideToken class is added here, reviewed.
 */
export const OXIDE_TOKEN_CLASS_IDS: readonly Hex[] = [
  "0x27df40f914de0e4368b39b4d02821d42573dfe703502c3e7a44f5254345f3949",
];

/** The corridor token's immutables (`OxideTokenImmutables`), as the manifest records them. */
export interface OxideTokenImmutables {
  /** OxidePortal on L1, 20-byte hex. */
  portal: string;
  /** TeeRegistry on L1, 20-byte hex. */
  teeRegistry: string;
  /** At most 31 bytes of UTF-8. Never the portal's underlying ERC-20 name. */
  name: string;
  /** At most 31 bytes of UTF-8. */
  symbol: string;
  /** u8. */
  decimals: number;
  /** u128, base units; decimal string or bigint. */
  maxNoteAmount: string | bigint;
}

export type OxideRefusal =
  | ShieldedRefusal
  | "string_too_long"
  | "decimals_out_of_range"
  | "max_note_amount_out_of_range";

export class OxideEncodingError extends Error {
  readonly code: OxideRefusal;
  readonly field: string;
  constructor(code: OxideRefusal, field: string, detail: string) {
    super(`${field}: ${code} (${detail})`);
    this.name = "OxideEncodingError";
    this.code = code;
    this.field = field;
  }
}

const refuseOxide = (code: OxideRefusal, field: string, detail: string): never => {
  throw new OxideEncodingError(code, field, detail);
};

/** Noir `FieldCompressedString`: byte 0 is zero, the UTF-8 bytes follow, zero-padded right. */
function fieldCompressedString(field: string, value: string): bigint {
  if (typeof value !== "string") refuseOxide("string_too_long", field, "not a string");
  const bytes = ethers.toUtf8Bytes(value);
  if (bytes.length > OXIDE_TOKEN_STRING_MAX_BYTES) {
    refuseOxide("string_too_long", field, `${bytes.length} bytes, more than 31`);
  }
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - OXIDE_TOKEN_STRING_MAX_BYTES);
  return BigInt(ethers.hexlify(padded));
}

function maxNoteAmount(value: string | bigint): bigint {
  let v: bigint;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) v = BigInt(value);
  else return refuseOxide("max_note_amount_out_of_range", "maxNoteAmount", "not a decimal");
  if (v < 0n || v >= 1n << 128n) {
    refuseOxide("max_note_amount_out_of_range", "maxNoteAmount", "does not fit a u128");
  }
  return v;
}

/** The field list `OxideTokenImmutables::serialize` hashes, in order. */
export function serializeOxideTokenImmutables(immutables: OxideTokenImmutables): bigint[] {
  return withRefusalsAs(
    () => {
      const d = immutables.decimals;
      if (!Number.isInteger(d) || d < 0 || d > 0xff) {
        refuseOxide("decimals_out_of_range", "decimals", "does not fit a u8");
      }
      return [
        BigInt(evmAddress("portal", immutables.portal)),
        BigInt(evmAddress("teeRegistry", immutables.teeRegistry)),
        fieldCompressedString("name", immutables.name),
        fieldCompressedString("symbol", immutables.symbol),
        BigInt(d),
        maxNoteAmount(immutables.maxNoteAmount),
      ];
    },
    (code, field, detail) => new OxideEncodingError(code, field, detail),
  );
}

/** The token instance's `immutablesHash`: `poseidon2([DOM_SEP__TOKEN_IMMUTABLES, ...serialize])`. */
export function oxideTokenImmutablesHash(immutables: OxideTokenImmutables): Hex {
  const fields = serializeOxideTokenImmutables(immutables);
  return ("0x" +
    poseidon2Hash([OXIDE_TOKEN_IMMUTABLES_SEPARATOR, ...fields])
      .toString(16)
      .padStart(64, "0")) as Hex;
}

/** True when `aztecTokenClassId` is an OxideToken class (`OXIDE_TOKEN_CLASS_IDS`). */
export function isOxideTokenClass(aztecTokenClassId: string): boolean {
  const id = withRefusalsAs(
    () => assertAztecBytes32("aztecTokenClassId", aztecTokenClassId),
    (code, field, detail) => new OxideEncodingError(code, field, detail),
  );
  return OXIDE_TOKEN_CLASS_IDS.includes(id);
}

/**
 * The exact enrollment acknowledgement set, in order, for a corridor whose token has class
 * `aztecTokenClassId` (a trusted corridor input, never the request's): an OxideToken
 * corridor adds `TokenRegistrationAck` after the two acks every corridor requires.
 */
export function requiredEnrollmentAcks(aztecTokenClassId: string): RecipientAckType[] {
  return isOxideTokenClass(aztecTokenClassId)
    ? ["BackupPersistenceAck", "SenderRegistrationAck", "TokenRegistrationAck"]
    : ["BackupPersistenceAck", "SenderRegistrationAck"];
}
