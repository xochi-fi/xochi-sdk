# @xochi/signer

Network-free signing and checks for Xochi intents, origin pulls, deposit attestations, stealth claims, ERC-4337 v0.8 UserOps and escrow hashes. Implements [SPEC.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/SPEC.md) and [ESCROW-RFC.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/ESCROW-RFC.md). Pass the fetched quote in; sign only after the checks pass. These move real funds: read the safety rules.

## Install

```bash
npm install @xochi/signer
```

ESM + CommonJS with types. Deps: `ethers` v6, `@noble/curves`.

## Usage

```ts
import {
  assertIntentMatchesRequest,
  assertPullMatchesIntent,
  signPullAuthorization,
  signXochiIntent,
} from "@xochi/signer";

const request = { wallet, fromChainId: 8453, toChainId: 10, fromToken, toToken, fromAmount };
const quote = await fetchQuote(request); // your transport

assertIntentMatchesRequest(request, quote); // the intent's values are the ones you asked for
assertPullMatchesIntent(quote, { expectedPullRecipients }); // the pull moves only that intent

const intentSignature = await signXochiIntent(quote.eip712, privateKey);
const pullSignature = await signPullAuthorization(quote.pull_authorization, privateKey);
```

Checks throw on mismatch. Request fields take either spelling (`fromChainId` / `from_chain_id`).

## Exported surface

**Xochi intent signing** (`xochi-signing.ts`)

- `signXochiIntent(eip712, privateKey, { allowedTypes? })`: only `XOCHI_TYPES` (domain `"3"`, no `verifyingContract`) or `allowedTypes`.
- `signPullAuthorization(pull, privateKey)`: only `PULL_AUTHORIZATION_SCHEMAS` (ERC-3009 `ReceiveWithAuthorization`, Permit2 `PermitWitnessTransferFrom`).
- `assertKnownSchema(types, allowed, label)`: exact match on type names, fields, order.

**ERC-3009 / Permit2 pull signing** (`signing.ts`, `permit2.ts`)

- `signERC3009(quote, inputChain, config)`: USDC only (`verifyingContract` is USDC).
- `signPermit2(quote, inputChain, config)`: any ERC-20, `OriginPullWitness`; requires `quote.gasless.orderId`.
- `ERC3009_TYPES`, `PERMIT2_TYPES`, `PERMIT2_ADDRESS` (`0x000000000022D473030F116dDEE9F6B43aC78BA3` on every EVM chain).

**Quote and pull checks** (`intent-verify.ts`)

- `assertIntentMatchesRequest(request, quote)`: including defaults (`recipient` -> `wallet`, `settlementPreference` -> `"public"`).
- `assertFromAmountWithinMax(request, fromAmount, label)`: `exact_output` requires `max_from_amount` as the ceiling.
- `assertPullMatchesIntent(quote, opts)`: domain `chainId`, token, amount, expiry, recipient and escrow pins.
- `assertNoEscrowEnvelope(quote)`, `pullKind`, `pinnedFor`, `pinAccepts`, `describePin`, `pullRecipientWasChecked`, `pullExpiryBoundSeconds`, `requireIntentChainId`, `XochiIntentMismatchError`.
- `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS`, `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS`.

**Deposit-address routes** (`deposit-verify.ts`): unpullable origins (Tron, any non-EVM).

- `verifyDepositAttestation(fields, attestation, expectedSigner)`: byte-exact EIP-191 rebuild; throws on mismatch or absence.
- `assertDepositQuoteMatchesRequest(request, fields, quote)`: all semantic guards, incl. `DEPOSIT_MIN_WINDOW_SECONDS`.
- `recordDepositAddress(store, depositAddress, intentId)`: refuses reuse across intents; you supply `SeenDepositAddressStore`.
- `recipientIsDestinationToken`, `depositAttestationFields`, `buildDepositAttestationMessage`, `recoverDepositAttestationSigner`, `assertDepositPartiesCaseBindable`, `attestationSignerConsistency` (advisory), `DEPOSIT_ATTESTATION_VERSION`.

**Capabilities** (`capabilities.ts`): tolerant parser and accessors for `GET /xochi/capabilities` (`parseCapabilities`, `chainCapability`, `originPullMethod`, `advertisedTokenAddress`, `servedChainKeys`, `chainUnservedReason`, `depositAttestationVersionSkew`, `orderBoundsViolation`, `stealthNotionalFloor`, ...). Same channel as the quote: not a trust anchor, nothing named `assert*`/`verify*`/`check*`.

**Stealth claims** (`stealth.ts`, `claim-verify.ts`)

- `deriveStealthPrivateKey(spendingPriv, viewingPriv, ephemeralPub)`: ERC-5564, local.
- `signUserOpHash(userOpHash, stealthPriv)`: raw ECDSA, **no EIP-191 prefix** (v0.8 SimpleAccount).
- `claimPrepareChallenge`, `signClaimPrepareProof`, `stealthAddressFromPrivateKey`.
- `assertPreparedClaimMatchesRequest(prepared, expected)`: recomputes `userOpHash`, then sender, `execute(token, 0, transfer(recipient, amount))`, chain.

**ERC-4337** (`erc4337.ts`): `computeUserOpHash(op, entryPoint, chainId)` (v0.8 `PackedUserOperation` EIP-712 hash), `computeUserOpDomainSeparator`, `decodeErc20TransferExecute` (only `execute(token, 0, transfer(to, amount))`, else fails closed), `ENTRYPOINT_V08_ADDRESS`.

**Escrow** (`escrow.ts`, `xsp.ts`): inert at this spec version.

- `computeDestCommitment`, `computeOrderId`, `canonicalKey`, `deriveDestBlinding`, OpenAuth / FillAuth / FillAcceptance / fill- and slash-attestation typehashes, digests, signers.
- `assertEscrowBinding(binding)`: SPEC §2.3; recomputes destination commitment and `orderId`, binds quote and pull-auth to your intent and `expectedEscrows`.
- `xsp.ts`: hash-only XSP (obligation/Depository digests, deposit-address derivation).

**Shared**: `sameAddressish`, `sameNumeric`, and the `Hex`, `Eip712Signable`, `SignerConfig`, ... types.

## Safety rules

- **Typed data is validated, never transformed**; `signTypedData` gets the served bytes. Off-schema signables refuse (else your key is a signing oracle).
- **Shape is not value**: the signers check schema only. Run `assertIntentMatchesRequest` and `assertPullMatchesIntent` first.
- **Pins live where the server can't reach** (build constant, reviewed config); don't read them, or the deposit attestation signer, from `/xochi/capabilities`.
  - `expectedPullRecipients` (`{ [originChainId]: { erc3009, permit2 } }`), the only recipient check: no pin or absent chain skips; pinned chain missing the method refuses. Multiple addresses per method cover a solver rollover; drop the old one after cutover.
  - `expectedEscrows` (`{ [originChainId]: escrow }`), used by `assertEscrowBinding` and `assertPullMatchesIntent`. Keys: positive chain id, decimal or `0x` hex, trimmed (`8453`, `"08453"`, `"0x2105"` are one chain). Refuses other keys, conflicting duplicates, blank/malformed/zero values, and any pull whose `to`/`spender` is the pinned escrow.
- **`escrow` envelopes refuse** in `assertPullMatchesIntent` and `assertDepositQuoteMatchesRequest`: the payee is the pull's `orderId`, checked only by `assertEscrowBinding`. A recipient pin naming the escrow doesn't substitute.
- **No `now` injection** (a bypass); tests use fake timers.
- **Pull expiry** ≤ intent deadline + min(advertised `pull_deadline_buffer_seconds`, opt-in and never fetched; `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS`). Advertised `0` is an outage; absent/malformed uses the ceiling.

## Conformance

Pinned byte-for-byte by `@xochi/spec` `conformance/conformance.json`, shared with the Python, Go, Rust signers and `raxol_payments`.

## License

MIT
