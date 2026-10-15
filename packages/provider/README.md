# @xochi/provider

Signing for compliance-data providers in [ERC-8262](https://github.com/xochi-fi/ERC-8262). A
provider signs the risk signals it produced; the signed circuits (`COMPLIANCE_SIGNED` 0x07,
`RISK_SCORE_SIGNED` 0x08, `COMPLIANCE_MULTI_SIGNED` 0x09) verify that secp256k1 signature
in-circuit, and the Oracle accepts only registered `signer_pubkey_hash` values. It also signs
EIP-712 credential-root publications for `publishCredentialRoot`.

Taker signing (intents, ERC-3009, Permit2) is in
[`@xochi/signer`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/signer#readme); proving
is in [`@xochi/sdk`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/sdk#readme) (see
[signed proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/signed-proofs.md)).
Nothing here moves funds.

## Install

```bash
npm install @xochi/provider @aztec/bb.js viem
```

`viem@^2` is a peer dependency; `@aztec/bb.js` provides the `Barretenberg` instance used for
Pedersen hashing. ESM-only (`require()` works on Node 22.12+).

Production key custody uses `DigestSigner`: the package constructs and validates each 32-byte
protocol digest locally and passes only that digest to `signDigest`. One `DigestSigner` object
represents one stable key identity; rotation creates a new object. The adapter exposes copied
32-byte secp256k1 `publicKeyX` / `publicKeyY` coordinates and returns canonical 64-byte `r || s`
with low S. `signDigest` may perform remote I/O; the adapter owns custody authentication, timeout,
cancellation, retry, DER decoding and low-S normalization. Adapter failures propagate to the
caller. The package validates the signature against one copied identity snapshot and derives the
Ethereum recovery bit before returning it. No private-key bytes cross this interface. `label` is a
non-secret diagnostic identifier recorded in private daemon audit failures; do not put secrets in
it.

`PrivateKeyLoader`, `RawPrivateKeyLoader`, `HexPrivateKeyLoader` and `loadLocalSigner` are the
explicitly extractable-key path for tests, development and the reference daemon, not production
custody. `loadPrivateKey()` returns a fresh caller-owned 32-byte buffer; ownership transfers to
`loadLocalSigner`, which may overwrite it immediately and keeps a separate owned copy.
`destroy()` wipes the local signer's owned copy. It cannot wipe immutable strings or copies
retained by callers or loaders.

## Signed signals (0x07 / 0x08)

```typescript
import { Barretenberg } from "@aztec/bb.js";
import { RawPrivateKeyLoader, loadLocalSigner, signSignals } from "@xochi/provider";

const api = await Barretenberg.new();
const signer = await loadLocalSigner(new RawPrivateKeyLoader(privateKeyBytes, "provider-1"));

const signed = await signSignals(api, signer, {
  proofType: 0x07, // 0x07 COMPLIANCE_SIGNED or 0x08 RISK_SCORE_SIGNED
  chainId: 1n, // EVM chain ID of the consuming Oracle
  oracleAddress: BigInt("0x..."), // address of the consuming Oracle (uint160 Field)
  providerSetHash: BigInt("0x..."),
  signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], // length 8, zero-pad inactive
  weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  timestamp: BigInt(Math.floor(Date.now() / 1000)), // the proof must reach the Oracle within 1 h
  submitter: BigInt(account.address),
});
// signed: { signature, pubkeyX, pubkeyY, signerPubkeyHash, payloadHash } as Uint8Array
signer.destroy();
await api.destroy();
```

Pass `signed` as `signedBundle` to `@xochi/sdk`'s `proveComplianceSigned` / `proveRiskScoreSigned`
with the same `chainId`, `oracleAddress`, signals, weights, timestamp and submitter.
`formatSignSignalsResult` renders it as `0x` hex.

## M-of-N slots (0x09)

Each active signer (up to `MAX_PROVIDERS_MULTI` = 5) signs a digest for its own slot:

```typescript
import { signSlotPayload } from "@xochi/provider";

const shared = {
  chainId: 1n,
  oracleAddress: BigInt("0x..."),
  jurisdictionId: 1, // US -> floor on M = 2
  providerSetHash: BigInt("0x..."),
  configHash: BigInt("0x..."),
  signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
  submitter: BigInt(account.address),
};

const slotA = await signSlotPayload(api, keyA, { ...shared, slotIndex: 0 });
const slotB = await signSlotPayload(api, keyB, { ...shared, slotIndex: 1 });
```

Put each result in `proveComplianceMultiSigned`'s `slots` at the index it was signed for (`null` for
inactive). M must meet `MIN_MULTI_PROVIDER_THRESHOLDS` (EU 1, UK 1, US 2, SG 2, UAE 2).

## Credential roots

```typescript
import { signCredentialRoot } from "@xochi/provider";

const { signature, signer: signerAddress } = await signCredentialRoot(signer, {
  chainId: 8453n,
  oracleAddress: "0x...",
  providerId: 1n,
  root: "0x<64 hex>",
  cid: "ipfs://...",
  notBefore: 1790000000n,
  notAfter: 1790003600n,
});
// Register `signerAddress` via setCredentialSigner(providerId, signerAddress);
// a separate publisher EOA submits:
await oracle.publishCredentialRoot(1n, root, cid, notBefore, notAfter, signature);
```

`credentialRootDigest`, `hashPublication`, `buildDomainSeparator` and `cidHash` are exported for
verification.

`signCredentialRoot` is asynchronous because `DigestSigner.signDigest` may call remote custody.

## Rules

- A signature is valid for one proof type: `proofType` must be 0x07 or 0x08, and each type (and 0x09
  slots) has its own domain tag.
- `chainId` and `oracleAddress` are signed; they must equal the consuming Oracle's, or the proof
  fails.
- A 0x09 signature is bound to its `slotIndex`; it does not verify in another slot.
- `submitter` is signed and must be the account that submits the proof.
- The signed `timestamp` must be under 1 hour old when the proof reaches the Oracle.
- The local signer uses deterministic RFC 6979 signing, but generic KMS/HSM `DigestSigner`
  adapters may return different valid low-S signatures for the same digest.
- `signSignalsWithReplayProtection` / `signSlotPayloadWithReplayProtection` return byte-identical
  bundles while a matching `ReplayDb` record is retained, including concurrent attempts.
  `ReplayDb.recordCanonical` must atomically retain and return one winner across every process
  sharing persistent storage; a process-local lock is insufficient. `inserted` is true only when
  that call's candidate became the retained row. Production storage must persist across restarts
  and retain records for the full proof-validity window; eviction or loss can produce another valid
  signature.

Replay rows cross a storage trust boundary. Before releasing a lookup or canonical winner, the
package copies and validates every fixed-length field, the compact low-S signature against the
captured signer and payload, and the signer commitment. Corrupt rows fail closed. The store remains
responsible for durable atomicity and retention; a storage failure after custody signing returns no
bundle, but a later attempt may invoke custody again.

Retrying the same digest is cryptographically safe. A generic adapter may produce different valid
low-S bytes on each attempt, so byte-identical retry output depends on the matching replay record
remaining available. `signCredentialRoot` has no built-in replay ledger; callers that require
byte-identical credential-root retries must retain those results themselves.

## Registering the signer

`computeSignerPubkeyHash(api, signer.publicKeyX, signer.publicKeyY)` gives the
`signer_pubkey_hash`.
Register it once with `oracle.registerSignerPubkeyHash(hash, providerId)` (`@xochi/sdk`); one
registration covers 0x07, 0x08 and 0x09.

## Signing daemon

A reference HTTP daemon that keeps the key out of the proving process ships as source in the repo,
not in this tarball: see
[daemon/README.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/provider/daemon/README.md).

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/provider/CHANGELOG.md).

## License

MIT
