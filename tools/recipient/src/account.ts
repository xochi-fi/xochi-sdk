// The recipient account: a stock `SchnorrAccount` from `@aztec-labs/accounts` 6.0.0
// (class 0x2f7d07db...9d15, `immutablesHash` 0), deployer zero (universal deploy), created
// from secrets generated on this machine. Everything here is local: no node, no network.

import { SchnorrAccountContract } from "@aztec-labs/accounts/schnorr";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { deriveKeys } from "@aztec-labs/aztec.js/keys";
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract";
import { deriveMasterMessageSigningSecretKey } from "@aztec-labs/stdlib/keys";
import { Schnorr } from "@aztec-labs/foundation/crypto/schnorr";
import {
  AZTEC_RECIPIENT_PROFILES,
  recipientMessage,
  verifyRecipientDescriptor,
  verifyRecipientSchnorr,
  type RecipientDescriptor,
} from "@xochi/signer";

import type { Corridor } from "./corridor.js";

/** The two secrets the account derives from. The backup's core; never sent anywhere. */
export interface AccountSecrets {
  secret: string;
  salt: string;
}

export function newAccountSecrets(): AccountSecrets {
  return { secret: Fr.random().toString(), salt: Fr.random().toString() };
}

export interface RecipientAccount {
  secret: Fr;
  salt: Fr;
  signingKey: GrumpkinScalar;
  instance: ContractInstanceWithAddress;
  address: AztecAddress;
  descriptor: RecipientDescriptor;
}

const hex32 = (v: { toString(): string }) => v.toString().toLowerCase();

/**
 * Derives the account and its descriptor, and refuses unless `@xochi/signer` accepts the
 * descriptor under the corridor's profile (`verifyRecipientDescriptor`): the class pin, the
 * points and the address the Worker recomputes.
 */
export async function deriveRecipientAccount(
  secrets: AccountSecrets,
  corridor: Corridor,
): Promise<RecipientAccount> {
  const secret = Fr.fromString(secrets.secret);
  const salt = Fr.fromString(secrets.salt);
  const signingKey = deriveMasterMessageSigningSecretKey(secret);
  const contract = new SchnorrAccountContract(signingKey);
  const artifact = await contract.getContractArtifact();
  const init = await contract.getInitializationFunctionAndArgs();
  if (!init) throw new Error("SchnorrAccountContract 6.0.0 has no initializer");
  const { publicKeys } = await deriveKeys(secret);
  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    constructorArtifact: init.constructorName,
    constructorArgs: init.constructorArgs,
    salt,
    publicKeys,
    deployer: AztecAddress.ZERO,
  });
  const [signingX, signingY] = init.constructorArgs as [Fr, Fr];
  const descriptor: RecipientDescriptor = {
    aztecAddress: hex32(instance.address),
    classId: hex32(instance.currentContractClassId),
    salt: hex32(salt),
    deployer: hex32(Fr.ZERO),
    signingPublicKeyX: hex32(signingX),
    signingPublicKeyY: hex32(signingY),
    npkMHash: hex32(publicKeys.npkMHash),
    ivpkMX: hex32(publicKeys.ivpkM.x),
    ivpkMY: hex32(publicKeys.ivpkM.y),
    ovpkMHash: hex32(publicKeys.ovpkMHash),
    tpkMHash: hex32(publicKeys.tpkMHash),
    mspkMHash: hex32(publicKeys.mspkMHash),
    fbpkMHash: hex32(publicKeys.fbpkMHash),
    network: { ...corridor.network },
  };
  verifyRecipientDescriptor(descriptor, AZTEC_RECIPIENT_PROFILES[corridor.profile]);
  return { secret, salt, signingKey, instance, address: instance.address, descriptor };
}

/**
 * The recipient's Schnorr signature over an EIP-712 digest it computed itself: the
 * account signs `recipientMessage(digest).messageField` (SchnorrAccount's scheme), and the
 * signature is checked with `@xochi/signer` before it is returned.
 */
export async function signRecipientDigest(
  account: RecipientAccount,
  digest: string,
): Promise<string> {
  const { messageField } = recipientMessage(digest);
  const signature = await new Schnorr().constructSignature(
    Fr.fromString(messageField),
    account.signingKey,
  );
  const encoded = `0x${signature.toBuffer().toString("hex")}`;
  const publicKey = {
    x: account.descriptor.signingPublicKeyX,
    y: account.descriptor.signingPublicKeyY,
  };
  if (!verifyRecipientSchnorr(publicKey, messageField, encoded)) {
    throw new Error("the recipient signature does not verify under @xochi/signer");
  }
  return encoded;
}
