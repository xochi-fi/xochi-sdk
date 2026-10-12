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

## License

MIT
