/**
 * Provider signing daemon entry point.
 *
 * Imported by reference signing daemons and SDK callers that need to mint
 * provider-signed signal bundles for COMPLIANCE_SIGNED / RISK_SCORE_SIGNED
 * proofs. NOT imported in browser circuit-loader paths -- this is a
 * server-side concern.
 *
 * Audit context: closes I-1 (signal honesty) by anchoring screening signals
 * to a registered provider's secp256k1 signature.
 */

export {
  DOMAIN_SIGNED_SIGNALS,
  DOMAIN_SIGNER_PUBKEY,
  bytesToHex,
  computeSignedPayloadHash,
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
  signSignals,
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
  MemoryReplayDb,
  ReplayDetected,
  signSignalsWithReplayProtection,
} from "./replay-db.js";
