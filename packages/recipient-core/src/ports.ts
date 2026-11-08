// Platform ports for the recipient core (xochi-sdk#156). The core is written once against
// these; the CLI (tools/recipient) supplies Node adapters and `src/browser/**` supplies
// browser adapters. Crypto that is identical everywhere (SHA-256, keccak, HKDF via
// @noble/hashes; crypto.getRandomValues; crypto.randomUUID) is deliberately not a port.

/** Wall clock. Core code never calls Date.now() or new Date() directly. */
export interface Clock {
  nowMs(): number;
}

/** The only network primitive: api.xochi.fi, Aztec node JSON-RPC, the enclave, L1 RPC, artifacts. */
export type HttpFetch = typeof fetch;

/**
 * Durable key-value storage. Keys are "/"-separated segments of [a-z0-9][a-z0-9._-]{0,127},
 * at most 512 characters. A journal record naming a tx hash is `put` (resolved) before that
 * tx is broadcast, so every write resolves only once it is durable.
 */
export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | null>;
  /** Atomic create; rejects with KeyExistsError when the key is present. */
  create(key: string, value: Uint8Array): Promise<void>;
  /** Atomic replace: a reader sees the old or the new value, never a torn one. */
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` (which ends with "/"), sorted ascending. */
  list(prefix: string): Promise<string[]>;
}

export class KeyExistsError extends Error {
  constructor(readonly key: string) {
    super(`key already exists: ${key}`);
    this.name = "KeyExistsError";
  }
}

export interface LockHolder {
  id: string;
  nonce: string;
  kind: string;
}

export interface LockLease {
  readonly name: string;
  readonly holder: LockHolder;
  release(): Promise<void>;
}

export interface LockManager {
  /**
   * Exclusive across processes (Node) or tabs and workers (browser, Web Locks). Resolves null
   * while a live holder has it. A dead holder's lock is recoverable: Node by pid liveness, as
   * the CLI does today; the browser because Web Locks drop when the holding tab closes.
   */
  tryAcquire(name: string, holder: LockHolder): Promise<LockLease | null>;
}

export type SealKind = "keystore" | "backup";

/**
 * Passphrase sealing, byte-compatible with tools/recipient/src/sealed.ts:
 * MAGIC (16) || scrypt salt (32) || AES-256-GCM IV (12) || ciphertext || tag (16),
 * scrypt(NFKC(passphrase), salt, N = 2^17, r = 8, p = 1, 32 bytes), AAD = MAGIC.
 */
export interface KeystoreCrypto {
  seal(kind: SealKind, plaintext: Uint8Array, passphrase: string): Promise<Uint8Array>;
  /** Rejects with SealError on a wrong passphrase, a wrong kind or corrupted bytes. */
  open(kind: SealKind, sealed: Uint8Array, passphrase: string): Promise<Uint8Array>;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** Raw artifact JSON. The core validates artifactHash and classId against the corridor pins. */
export interface ArtifactLoader {
  tokenArtifact(): Promise<unknown>;
  broadcasterArtifact(): Promise<unknown>;
}

/** The vendored parser's result, structurally (Buffer is a Uint8Array). */
export interface ParsedNitroAttestation {
  moduleId?: string;
  digest?: string;
  timestamp?: bigint;
  pcr0: Uint8Array;
  pcr1: Uint8Array;
  pcr2: Uint8Array;
  enclavePublicKey?: Uint8Array;
  userData?: Uint8Array;
  nonce?: Uint8Array;
  certificate: Uint8Array;
  caBundle: Uint8Array[];
}

export interface NitroAttestationInput {
  attestationDocument: Uint8Array;
  trustedRootCertificates: Uint8Array[];
  expectedUserData?: Uint8Array;
  expectedNonce?: Uint8Array;
  now?: Date;
}

/**
 * Same accept/reject results as the vendored verify_nitro_attestation.ts on every input an attacker
 * without AWS or NSM keys can build, except where an implementation is deliberately stricter (fail
 * closed; listed in its own header). Async for WebCrypto.
 */
export interface AttestationVerifier {
  verifyNitroAttestation(input: NitroAttestationInput): Promise<ParsedNitroAttestation>;
}

/** The account secrets, exactly the CLI's `AccountSecrets` (0x-prefixed lowercase Fr hex). */
export interface AccountSecrets {
  secret: string;
  salt: string;
}

/** Node: keystore.sealed + passphrase. Browser: the passkey derivation or a PKW1 unwrap. */
export interface RecipientKeySource {
  /** Where the secrets come from: the passkey backup mode is open only to `"passkey"`. */
  readonly kind: "keystore" | "passkey" | "imported";
  accountSecrets(): Promise<AccountSecrets>;
}

export type Log = (line: string) => void;
