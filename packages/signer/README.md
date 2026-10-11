# @xochi/signer

Network-free signing and pre-sign checks for Xochi intents, origin pulls (ERC-3009, Permit2), deposit attestations, stealth claims, ERC-4337 v0.8 UserOps and escrow hashes. Implements [SPEC.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/SPEC.md) and [ESCROW-RFC.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/ESCROW-RFC.md). These sign bytes that move real funds: follow the safety rules.

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

Checks throw on mismatch. Deposit-address routes use `verifyDepositAttestation`, `assertDepositQuoteMatchesRequest` and `recordDepositAddress`; stealth claims use `deriveStealthPrivateKey`, `assertPreparedClaimMatchesRequest` and `signUserOpHash`. See the TSDoc.

## Safety rules

- **Run the value checks before signing.** The signers check schema only (off-schema typed data refuses); `assertIntentMatchesRequest` and `assertPullMatchesIntent` check values.
- **Keep pins where the server can't reach** (build constant, reviewed config). Never read them, or the deposit attestation signer, from `/xochi/capabilities`.
- **`expectedPullRecipients` is the only recipient check**: no pin, or an absent chain, skips it. Drop an outgoing address once a rollover completes.
- **Quotes with an `escrow` envelope refuse**; a recipient pin naming the escrow is no substitute for `assertEscrowBinding`.
- **`exact_output` requires `max_from_amount`.**
- **`signERC3009` is USDC-only**; use `signPermit2` for other tokens.
- **`signUserOpHash` signs raw** (no EIP-191 prefix); only sign a hash `assertPreparedClaimMatchesRequest` recomputed.
- **`recordDepositAddress` needs a store you supply** to refuse an address reused across intents.

## Pull verification

`assertPullMatchesIntent(quote, opts)` holds the origin pull (`pull_authorization`) to the intent `assertIntentMatchesRequest` already verified. It is offline and pure: it takes the recipient pin and the escrow pin, never a chain reader or a settlement pin. `signPullAuthorization` checks shape only (the two real pull schemas); value checks need an intent, so they live here. Undoing any rule below has cost money or nearly did.

Binding the pull to the intent:

- **The pull's domain is as load-bearing as its message.** `domain.chainId` must equal `intent.fromChainId`, unconditionally: an intent missing `fromChainId` refuses with no pin at all. The check is bound to the intent, not a chain-registry lookup, so a chain the server adds does not fail closed. ERC-3009: `verifyingContract` == `intent.fromToken`. Permit2: `verifyingContract` == `PERMIT2_ADDRESS` and `permitted.token` == `intent.fromToken`. Token identity, amount and expiry are compared as well.
- **A quote with a non-null `escrow` envelope refuses** (`assertNoEscrowEnvelope`, also run by `assertDepositQuoteMatchesRequest`). Who an escrow pays is the `orderId` the pull binds (ERC-3009 `nonce`, Permit2 witness), checked only by the SPEC §2.3 binding (`assertEscrowBinding` against a caller-pinned escrow per origin chain), which nothing here wires. A recipient pin naming the escrow is not sufficient. Lift the refusal only by wiring the binding.
- **A pull to a caller-pinned escrow is escrow-bearing with or without the envelope** (SPEC.md §6). `expectedEscrows` (`{ [originChainId]: address }`, either spelling) refuses a `to`/`spender` naming the escrow pinned for `intent.fromChainId`; a blank pin refuses. Never merge it into `expectedPullRecipients`. One resolver, `resolvePinnedEscrow`, reads it for this guard and for `assertEscrowBinding`: keys are positive chain ids in decimal or `0x` hex, trimmed; any other key, or two keys for one chain with different escrows, refuses.

Expiry bound:

- Expiry is bounded by `intent.deadline + pullExpiryBoundSeconds(advertised)`: the **tighter** of the advertised `pull_deadline_buffer_seconds` and the local `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` ceiling (3600 s; prod advertises 300 s). Reading a served number is sound only because it is a minimum: the local ceiling still caps it. An advertised `0` is an outage; an absent or malformed value falls through to the ceiling, never to zero. The intent's own deadline is held to `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS`.
- **Do not tighten `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` to a number read off a live deployment.** The buffer was 1500 s until 2026-08-12; a hardcoded 600 would have refused every honest quote.
- The advertised value is **opt-in and never auto-fetched** (`advertisedPullDeadlineBufferSeconds`, either spelling): nothing on the signing path reads `/xochi/capabilities`; absent means the ceiling.

The recipient pin:

- **`to`/`spender` is checked only against `expectedPullRecipients`** (`{ [fromChainId]: { erc3009?, permit2? } }`, either spelling). Riddler advertises the matrix per chain and method on `/xochi/capabilities` (`pull_recipients`; on prod ERC-3009 is a different solver EOA per chain, Permit2 one universal proxy). That is discovery, never the pin.
- **Absence of a pin skips the check**; an attacker can drop a field from the quote but not an entry from your pin. The chain and method axes grade differently: a chain absent from the pin is unchecked; a chain present but missing the method in use **refuses**. The pin is keyed on `intent.fromChainId` only, never the pull's `domain.chainId`; an intent with no chain refuses, as does a blank pin entry.
- **A method may name a set of accepted values** (`erc3009: [outgoing, incoming]`; `MethodPin`, `pinAccepts`, `describePin`) to cross a solver rollover (Riddler rotates the ERC-3009 EOA per chain). A set is a window, not a configuration: the outgoing value keeps verifying until removed, so a long-lived two-value pin is weaker. An empty list, blank entry or non-string entry refuses, like `{}` and `""`; `pinnedFor` refuses a `null` method too.
- **An ERC-3009 `to` is the payee; a Permit2 `spender` only _may_ pull.** `SignatureTransferDetails.to` is not in the signed struct (`OriginPullWitness` binds an `orderId`), so the refusals say different things.

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/signer/CHANGELOG.md).

## License

MIT
