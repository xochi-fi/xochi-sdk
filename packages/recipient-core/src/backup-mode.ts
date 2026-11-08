// How the recipient keeps its keys, as the BackupPersistenceAck states it (claim contracts v1,
// section B). The mode IS the `backupFormatId`: a sealed backup file (format v1, commitment =
// keccak256 of the sealed bytes, as the CLI has always acknowledged) or the passkey itself
// (format passkey v1, commitment over the credential, rp id and derivation version). The
// Worker recomputes the passkey commitment from `backup_passkey`.
//
// The passkey constants are owned by @xochi/signer (xochi-sdk#155); they are computed here, pinned
// to the contract vectors, until the core depends on a signer that exports them.

import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import * as signer from "@xochi/signer";

export const BACKUP_FORMAT_PASSKEY_V1_NAME = "xochi.shielded.backup-format.passkey.v1";
export const BACKUP_FORMAT_PASSKEY_V1_ID: Hex = keccak256(toHex(BACKUP_FORMAT_PASSKEY_V1_NAME));
export const PASSKEY_BACKUP_COMMITMENT_TAG: Hex = keccak256(
  toHex("xochi.shielded.passkey-backup-commitment.v1"),
);
export const PASSKEY_RP_ID = "xochi.fi";
export const PASSKEY_DERIVATION_V1 = 1;

/**
 * Whether the resolved @xochi/signer signs the passkey format: 0.8.0 (xochi-sdk#155) exports
 * `BACKUP_FORMAT_PASSKEY_V1_ID` and its `hashRecipientAck` accepts it; 0.7.0 refuses it with
 * `backup_format_mismatch`.
 */
export function signerSignsPasskeyBackup(): boolean {
  return Reflect.get(signer, "BACKUP_FORMAT_PASSKEY_V1_ID") === BACKUP_FORMAT_PASSKEY_V1_ID;
}

export type BackupMode =
  | { mode: "sealed_file"; commitment: Hex }
  | { mode: "passkey"; credentialIdHash: Hex; rpId: "xochi.fi"; derivationVersion: 1 };

/** The enrollment request's `backup_passkey` member (wire, xochi#835). */
export interface WireBackupPasskey {
  credential_id_hash: string;
  rp_id: string;
  derivation_version: number;
}

/** What the BackupPersistenceAck names, and the request member a passkey binding adds. */
export interface BackupAcknowledgement {
  backupCommitment: string;
  backupFormatId: string;
  backupPasskey?: WireBackupPasskey;
}

export function backupAcknowledgement(mode: BackupMode): BackupAcknowledgement {
  if (mode.mode === "sealed_file") {
    return { backupCommitment: mode.commitment, backupFormatId: signer.BACKUP_FORMAT_V1_ID };
  }
  if (!/^0x[0-9a-f]{64}$/.test(mode.credentialIdHash) || BigInt(mode.credentialIdHash) === 0n) {
    throw new Error("passkey credential id hash must be a nonzero lowercase bytes32");
  }
  if (mode.rpId !== PASSKEY_RP_ID) {
    throw new Error(`passkey rp id must be ${PASSKEY_RP_ID}`);
  }
  if (mode.derivationVersion !== PASSKEY_DERIVATION_V1) {
    throw new Error(`passkey derivation version must be ${PASSKEY_DERIVATION_V1}`);
  }
  const backupCommitment = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }],
      [
        PASSKEY_BACKUP_COMMITMENT_TAG,
        mode.credentialIdHash,
        keccak256(toHex(mode.rpId)),
        mode.derivationVersion,
      ],
    ),
  );
  return {
    backupCommitment,
    backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID,
    backupPasskey: {
      credential_id_hash: mode.credentialIdHash,
      rp_id: mode.rpId,
      derivation_version: mode.derivationVersion,
    },
  };
}
