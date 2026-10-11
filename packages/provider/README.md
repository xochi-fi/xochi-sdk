# @xochi/provider

Signing for compliance-data providers in [ERC-8262](https://github.com/xochi-fi/ERC-8262). A screening provider signs the risk signals it produced. The ERC-8262 signed circuits (`COMPLIANCE_SIGNED` 0x07, `RISK_SCORE_SIGNED` 0x08, `COMPLIANCE_MULTI_SIGNED` 0x09) check that secp256k1 signature in-circuit, and the Oracle accepts only `signer_pubkey_hash` values registered in `_validSignerPubkeyHashes` (audit I-1, signal honesty). The package also signs EIP-712 credential-root publications for `ERC8262Oracle.publishCredentialRoot`, and ships a [reference HTTP signing daemon](daemon/README.md) as source.

What this package is **not**:

- **Not the taker signer.** EIP-712 intent, ERC-3009 and Permit2 signing live in [`@xochi/signer`](../signer).
- **Not the prover.** Proof generation and the input builders live in [`@xochi/sdk`](../sdk). That package takes this one's output (`signedBundle`, `slots`) and does not depend on it.
- **It moves no funds.** A signature here attests to compliance signals or a credential root. It authorizes no transfer.

## Install

```bash
npm install @xochi/provider @aztec/bb.js viem
```

`viem@^2` is a peer dependency. `@aztec/bb.js` is a dependency; install it directly when you construct the `Barretenberg` instance the signers take for Pedersen hashing. ESM-only, with a `default` condition, so `require("@xochi/provider")` works on Node 22.12+.

Keys load through a `KeyLoader`. `RawKeyLoader` and `HexKeyLoader` are for tests and the reference daemon. In production, implement `KeyLoader` over a KMS or HSM.

## Signed signals (0x07 / 0x08): `signSignals`

```typescript
import { Barretenberg } from "@aztec/bb.js";
import { RawKeyLoader, loadSignerKey, signSignals } from "@xochi/provider";

const api = await Barretenberg.new();
const signerKey = await loadSignerKey(new RawKeyLoader(privateKeyBytes, "provider-1"));

const signed = await signSignals(api, signerKey, {
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
```

Pass `signed` as `signedBundle` to `@xochi/sdk`'s `proveComplianceSigned` / `proveRiskScoreSigned` (or `buildComplianceSignedInputs` / `buildRiskScoreSignedInputs`). The prover's `chainId`, `oracleAddress`, signals, weights, timestamp and submitter must equal what was signed, because the circuit recomputes the digest. `formatSignSignalsResult` renders the bundle as `0x` hex.

## M-of-N slots (0x09): `signSlotPayload`

`COMPLIANCE_MULTI_SIGNED` has up to 5 slots (`MAX_PROVIDERS_MULTI`). Each active signer signs a digest for **its own slot**:

```typescript
import { RawKeyLoader, loadSignerKey, signSlotPayload } from "@xochi/provider";

const keyA = await loadSignerKey(new RawKeyLoader(privKeyA, "provider-A"));
const keyB = await loadSignerKey(new RawKeyLoader(privKeyB, "provider-B"));

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

// Slot indices are NOT interchangeable.
const slotA = await signSlotPayload(api, keyA, { ...shared, slotIndex: 0 });
const slotB = await signSlotPayload(api, keyB, { ...shared, slotIndex: 1 });
```

Each result goes into the `slots` array of `@xochi/sdk`'s `proveComplianceMultiSigned` at the index it was signed for, with its `signals` / `weights` as numbers. Pass `null` for inactive slots and the builder pads them.

## Credential roots: `signCredentialRoot`

```typescript
import { signCredentialRoot } from "@xochi/provider";

const { signature, signer } = signCredentialRoot(signerKey, {
  chainId: 8453n,
  oracleAddress: "0x...",
  providerId: 1n,
  root: "0x<64 hex>",
  cid: "ipfs://...",
  notBefore: 1790000000n,
  notAfter: 1790003600n,
});
// signature: 65 bytes r || s || v. signer: the Ethereum address to register
// via setCredentialSigner(providerId, signer).
await oracle.publishCredentialRoot(1n, root, cid, notBefore, notAfter, signature);
```

The digest is EIP-712 `CredentialRootPublication(uint256 providerId,bytes32 root,bytes32 cidHash,uint64 notBefore,uint64 notAfter)` under domain `{ name: "ERC8262Oracle", version: "1", chainId, verifyingContract: oracle }`. It is pinned byte-for-byte to ERC-8262's `EIP712CredentialRoot.sol` by a parity vector. `credentialRootDigest`, `hashPublication`, `buildDomainSeparator` and `cidHash` are exported for verification. The publisher EOA that submits the root is a separate account from the signing key, so a compromised publisher cannot mint roots on its own.

## Domain separation

Each signature is valid for one proof type, one Oracle deployment and, for 0x09, one slot. The rules:

- **Per-proof-type domain tags.** The Pedersen signed-signals digest starts with a domain tag: `DOMAIN_SIGNED_SIGNALS` for 0x07, `DOMAIN_RISK_SIGNED_SIGNALS` for 0x08, `DOMAIN_MULTI_SIGNED_SIGNALS` for 0x09 slots. `proofType` is required, and any value other than 0x07 or 0x08 is refused. A bundle signed for 0x07 therefore fails in 0x08, and the reverse. `DOMAIN_SIGNER_PUBKEY` separates `signer_pubkey_hash` from all three.
- **Chain and Oracle binding (audit F-6).** `chain_id` and `oracle_address` are in every digest, and the Oracle asserts that they equal `block.chainid` and `address(this)`. A signature cannot mint attestations on another chain or another Oracle. A signer/prover mismatch fails with `invalid provider signature on signals`. A signer/Oracle mismatch fails with `PublicInputMismatch`.
- **Slot binding.** The 0x09 slot digest includes `slot_index`, `jurisdiction_id` and `config_hash`. A slot-`i` signature does not verify in slot `j`, and a slot digest never equals a single-signer digest.
- **Submitter binding.** `submitter` is in every digest and is a public input. The Oracle enforces `submitter == msg.sender`, so another account cannot submit a proof built from someone else's bundle.

Signing is deterministic (RFC 6979, low-S). For a ledger that answers an identical retry with the identical signature, use `signSignalsWithReplayProtection` / `signSlotPayloadWithReplayProtection` over a `ReplayDb`. `MemoryReplayDb` is the in-process reference. On-chain, `_usedProofs` stops proof replay.

## Registering the signer

`computeSignerPubkeyHash(api, key.publicKeyX, key.publicKeyY)` gives the `signer_pubkey_hash`. Register it once through `ERC8262Oracle.registerSignerPubkeyHash(hash, providerId)`, available as `oracle.registerSignerPubkeyHash` in `@xochi/sdk`. The same registry covers 0x07, 0x08 and 0x09.

## Daemon

[`daemon/`](daemon/README.md) is a reference HTTP daemon around these signers: `POST /sign`, `/sign-multi`, `/sign-credential-root`, `GET /pubkey-hash`, `/healthz`. It keeps the key out of the proving process, pins one Oracle deployment (`SIGNER_CHAIN_ID`, `SIGNER_ORACLE_ADDRESS`), enforces a timestamp freshness window, scopes credentials per route group, and writes an audit record before it returns a signature. It ships as TypeScript source and is **not** in the npm tarball. From the repo root:

```bash
SIGNER_PRIVATE_KEY_HEX=0x... SIGNER_API_KEY=dev-key \
SIGNER_CHAIN_ID=8453 SIGNER_ORACLE_ADDRESS=0x... \
npm run daemon -w @xochi/provider
```

Endpoints, policy codes, mTLS, the audit log, and production hardening are covered in [daemon/README.md](daemon/README.md).

## Development

```bash
npm install              # at the repo root (npm workspaces), then:
cd packages/provider
npm test                 # unit tests: Noir parity vectors, signer, EIP-712 parity, daemon
npm run typecheck        # tsc --noEmit (sources + tests) and the daemon
npm run format:check     # prettier --check (run in CI / prepublishOnly)
npm run build            # compile to dist/
npm run daemon           # build, then run the reference daemon
```

The Pedersen digests are pinned to ERC-8262's Noir parity tests (`circuits/shared/src/{sig,multi_sig}.nr`, `nargo test parity`). The end-to-end path (daemon, proof, on-chain `submitCompliance`) runs in `@xochi/sdk`'s integration suite.

## License

MIT
