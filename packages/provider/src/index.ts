/**
 * `@xochi/provider`: compliance-data provider signing.
 *
 * Imported by signing daemons (see `daemon/`) and provider services that mint
 * provider-signed signal bundles for COMPLIANCE_SIGNED / RISK_SCORE_SIGNED /
 * COMPLIANCE_MULTI_SIGNED proofs and EIP-712 credential-root publications.
 * A server-side concern: never imported by `@xochi/sdk`'s proving paths.
 *
 * Audit context: closes I-1 (signal honesty) by anchoring screening signals
 * to a registered provider's secp256k1 signature.
 */

export {
  DOMAIN_SIGNED_SIGNALS,
  DOMAIN_RISK_SIGNED_SIGNALS,
  SIGNED_SIGNALS_DOMAINS,
  type SignedSignalsProofType,
  DOMAIN_SIGNER_PUBKEY,
  DOMAIN_MULTI_SIGNED_SIGNALS,
  MAX_PROVIDERS_MULTI,
  bytesToHex,
  bytesToHexField,
  computeSignedPayloadHash,
  computeSlotPayloadHash,
  computeSignerPubkeyHash,
  pedersenHash,
  fieldToBytes,
  bytesToBigint,
  coordinateToFields,
} from "./pedersen.js";

export {
  type KeyLoader,
  type SignerKey,
  RawKeyLoader,
  HexKeyLoader,
  loadSignerKey,
  wipeKey,
} from "./keystore.js";

export {
  type SignSignalsRequest,
  type SignSignalsResult,
  type SignSlotRequest,
  signSignals,
  signSlotPayload,
  formatSignSignalsResult,
} from "./signer.js";

export {
  type SignCredentialRootRequest,
  type SignCredentialRootResult,
  signCredentialRoot,
} from "./credential-root-signer.js";

export {
  type CredentialRootPublication,
  CREDENTIAL_ROOT_TYPEHASH,
  buildDomainSeparator,
  hashPublication,
  toTypedDataHash,
  credentialRootDigest,
  cidHash,
} from "./eip712.js";

export {
  type ReplayDb,
  type MemoryReplayDbOptions,
  type LedgeredSignResult,
  MemoryReplayDb,
  signSignalsWithReplayProtection,
  signSlotPayloadWithReplayProtection,
} from "./replay-db.js";
