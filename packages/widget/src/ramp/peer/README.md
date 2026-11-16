# Peer discovery and preview

The standalone exports `fetchPeerCapabilities`, `normalizePeerQuotes`,
`normalizePeerMakerEvidence`, and `previewPeerOffer` live in the trusted widget
runtime. The discovery exports do not execute payments or retain
provider payloads. The S5 maker adapter described below wires them into S4
and owns maker protocol and account semantics.

The dependency is exactly `@zkp2p/sdk@0.15.0-rc.11`, matching the approved
compatibility example. No Cash dependency or second SDK graph is introduced.
`peerConfiguration` validates the SDK's Base USDC address, chain and decimals;
symbols cannot establish identity. The SDK environment selects the matching
curator, escrow and V4 orchestrator. Staging still settles on Base chain 8453.

## Buyer

Discovery calls `apiGetQuotesBestByPlatform` with eligible Buyer TEE quotes.
Preview re-reads the selected rail via `apiGetQuote`. The live response must
match Base USDC identity/precision, requested fiat, exact amount, recipient,
rail/payment method, deployment and expiry. Canonical USD money uses the
provider's **six-decimal quote precision**, not the rounded formatted string
(e.g. `25996971` USD atomic = USD 25.996971). The SDK's exact-fiat request takes
an exact decimal string; exact-token requests take atomic strings. Other fiat
currencies/precisions remain unsupported until their wire precision is verified.
No money passes through a JS number.

A quote establishes **only the exact requested amount**. Offers have singleton
minimum/maximum bounds on the quoted side; the implementation never infers a
wider corridor from a quote or static metadata. Request another quote to change
amount or exact side. Provider expiry is capped at 30 seconds locally; malformed,
undated or expired responses fail closed. A long provider TTL never extends
the local 30-second freshness window. Explicit user
region constraints remain unknown for buyer quotes: the SDK request has no region
eligibility field, and a fiat's `countryCode` cannot prove a user's eligibility.

A preview rechecks the complete request binding (including recipient/region),
availability, asset and bounds, then obtains fresh data. All successful previews
get new widget-minted quote IDs. A changed capability revision returns
`quote_changed` **with a replacement preview**, which requires a fresh review;
it never silently accepts the prior quote. Revisions include sanitized economics,
provider expiry and request identity. There is no execute function here.
Mobile web returns `setup_required` with `peer_desktop_extension_or_app` and
makes no buyer quote request. Mobile browser detection cannot be overridden by a
host flag; a host can also narrow with `mobileWeb: true`. This implementation
does not start intents or present held payouts as confirmed settlement.
Disclosure codes include the expired/unverifiable fiat refund limitation.
Extension/payment interaction remains required; a fresh available quote is not
an assertion that a payment has been made or approved. Required dispute stake
is represented as `setup_required`.

## Maker boundary

The default reader discovers candidate platform names only from a fresh live
Peer response. It never treats buyer availability/rates or the packaged rail
catalog as authorization to create a maker deposit. Without authoritative maker
evidence, every candidate remains `availability_unknown` with a bounded code.
No live platform names means no maker offers.

S5 can provide the trusted `reads.makerEvidence(intent, rail, user)` callback.
It must **perform new provider/protocol reads on each invocation** and return only:

- `observed_at`, `valid_until`, `rail`, `currency: "USD"`, `chain_id`, `asset_id`,
  `decimals: 6`, and the exact `region` constraint (or omit when unconstrained).
- An exact positive net fiat-atomic/USDC-atomic `rate: {numerator, denominator}`,
  including all fee effects, from a current oracle/provider observation.
- `bounds: {minimum, maximum}` in USDC atomic units, from live protocol/API
  deposit limits. Caller-chosen deposit/intent ranges and packaged constants do
  not establish protocol bounds.
- An explicit `fees` array of `{code, atomic}` in USDC units, including an empty
  array only when a live read establishes no fees.
- `credential: "verified" | "missing" | "unknown"` and, for verification,
  `wallet` matching the public connected user. The callback retains all payee and
  credential identifiers locally and never includes them in its return value.

All inputs are revalidated. Evidence expires after at most 30 seconds, must
match rail/currency/asset/region/wallet, and must include coherent positive live
bounds/rate. Missing connected user or seller credential is `setup_required`
when the other evidence is established; unknown credential state or any other
unproven prerequisite remains `availability_unknown`. Buyer quotes cannot
populate this port. These are trusted I/O dependencies, not caller-authored UI
capabilities; do not bridge them or substitute static/cached data.

Maker preview is an **estimate, never a locked rate or guaranteed fill**. The
result wrapper has `estimate: true`, and disclosure codes include
`maker_estimate` and `asynchronous_partial_fills`. Cash proceeds round down and
required USDC rounds up using bigint rational arithmetic. S5 must establish the
execution price/fees, approval and lifecycle separately.

The selected SDK README states that its readiness reader verifies the V3
manifest only and that V4 readiness awaits a new manifest (lines 560–561).
These functions use the SDK's validated deployment identity and live quotes;
they do not claim full V4 manifest certification. Maker live eligibility/bounds
remain an integration gap until S5 supplies authoritative reads. Keep both
limitations in deployment and release review.

## Fixture and opt-in probe

`fixtures/usd-best-by-platform.json` was recorded from the public production
curator on 2026-11-16 using a public burn address and an exact 25 USDC request.
Only allowlisted economics, deployment/token identity, currency, platform and
expiry were retained. The recipient is the synthetic public burn address;
no provider IDs, payment handles, sessions, credentials, proofs, raw responses
or errors are recorded. Unit tests pin their clock relative to this expired
recording and use in-memory read implementations. Maker gate tests use explicit
synthetic evidence, not a claimed live maker capability recording.

Build prerequisite workspace packages and the widget, then opt in explicitly:

```sh
npm run build -w @xochi/signer
npm run build -w @xochi/client
npm run build -w @xochi/widget-lib
npm run build -w @xochi/widget
# Public address only; never a wallet key or provider session.
PEER_WALLET_ADDRESS=0x000000000000000000000000000000000000dEaD \
  npm run probe:peer -w @xochi/widget -- --live
```

The script prints only normalized USD/Base USDC offers for both directions.
The burn-address probe is read-only and does not establish a real user's setup.
The default maker reader intentionally prints unknown availability. Optional
`PEER_ENVIRONMENT` and canonical `PEER_USDC_ATOMIC` narrow the request. No request
is made without `--live`; CI never invokes the live probe.

## Maker execution (S5)

`createPeerOfframpProvider({io, discovery, store})` implements `RampProvider` for
`offramp`. Use it with S4's `createRampClient`. The discovery reader must supply
fresh maker evidence as described above; `io.readiness` independently checks the
oracle/feed pause, identity attestation and seller setup. Wise, PayPal and Alipay
always require attestation. Unknown seller setup fails closed. An explicit Seller
Autopilot/credential refusal becomes `setup_required` on subsequent discovery,
with `capability_unavailable` in the bounded ramp snapshot and `setup_required`
as the safe `orderStatus().reason`; no exception text escapes.

The separate `createSDKMakerIO` port accepts only registration and unsigned SDK
preparation methods. Registration uses the SDK's `POST /v2/makers/create` path;
creation reuses its private payee hash. Approval encodes an exact Base USDC ERC-20
allowance for the environment's escrow. Partial withdrawal uses `removeFunds.prepare`;
full withdrawal uses `withdrawDeposit.prepare`. Execution terms (live intent bounds
and the SDK's 18-decimal conversion rate) must come from the trusted provider/oracle
read layer, with an explicit expiry. No catalog limit or buyer rate authorizes a
maker transaction. Current effective rates can include ARM oracle pricing; a stale
feed pauses execution. This port never configures a guessed ARM policy or Autopilot
workaround.

The application supplies the trusted read ports for account/ARM readiness,
allowance, chain receipts, deposit state and indexed fills/withdrawals. These are
required dependencies, not a default live maker-read implementation: no dedicated
public maker capability endpoint exists, and maker reads may need an approved
provider API key. `reconcile` must compare a confirmed transaction's sender, chain,
target, calldata and value against the expected unsigned transaction, and extract
only its own deposit ID from the escrow receipt. Unknown receipts remain pending.
`deposit` must validate owner, escrow/asset identity, confirmed chain state and
indexer coherence; missing, stale or inconsistent observations must throw. Its
`remaining` includes active-intent reservations; `unmatched` excludes reservations
and fees. `filled` is gross USDC debited by verified fills, including protocol fees.
Remaining + filled + withdrawn must equal the original deposit. Payment-pending
intents are never fills. SDK read exceptions must not be logged by the application.

The trusted UI/wallet sequence is:

1. Discover, preview and review the `maker_estimate` and asynchronous partial-fill
   disclosures. The estimate is approximate, never a locked rate or ETA.
2. Call `setOwnAccount(operationId, account, "own_account")` with the user's own
   payment account, then explicitly approve the preview through the ramp client.
   Third-party payees are out of scope; this declaration is not a technical ownership
   attestation for rails that do not provide one.
3. `interact` prepares one named wallet action. `takeUnsignedPlan` returns it once
   for explicit review/signing by the caller's wallet and immediately records
   uncertainty. Actions are `approve_usdc`, `create_deposit`, or `withdraw_unmatched`.
   No method broadcasts, signs or receives a private key. Wallet calldata is
   wallet-only material; never forward it through host callbacks or bridge events.
4. Report the public transaction hash with `recordSubmission`, then reconcile
   `check_status`. A confirmed allowance requests another explicit `interact` for
   deposit creation. If the wallet definitively rejected before broadcast, call
   `recordWalletRejection`; a missing hash alone is never evidence of rejection.
5. Poll `orderStatus` to rebuild `awaiting_buyer`, `matched`, `delivering`,
   `delivered`, or `returned`. Pending phases map to `processing`, verified complete
   delivery to `completed`, and withdrawal/partial-fill plus return to `refunded`.
   A returned order may already have verified partial fills; it is not a reversal
   of those payments. Unknown status maps to `in_doubt` with reconciliation only.
6. Review a distinct withdrawal amount and call `prepareWithdrawal` with a new
   command context. Its unsigned plan requires another explicit wallet approval.
   Active intents block full closure but permit the unmatched partial amount;
   funds/reservations are checked again at wallet handoff. A rejected full close
   returns bounded `active_intent_blocks_withdrawal` in the safe order reason.

`PeerMakerPrivateStore` holds mappings, registration data and command receipts in
module-private memory. Reusing it across provider instances resumes the existing
deposit; its JSON representation is empty. It has no public mapping accessors.
The raw account is discarded after deposit confirmation. It is **not durable across
a page/process reload**: the host must keep the trusted runtime alive or supply a
future protected persistence integration; sanitized public snapshots alone cannot
recover provider handles or authorize recreation. Do not serialize this object,
put payees into browser storage, or rebuild a deposit from a public snapshot.
Public snapshots contain only the widget-minted operation reference and bounded
states/codes. `orderStatus` adds only safe phase/reason enums.

The in-memory maker/SDK implementations exercise the same ports without signing,
network calls, sleeps or mocking libraries. They use the sanitized recorded S2
quote fixture for candidate rails and explicitly synthetic maker facts; they are
not evidence of live seller eligibility or an executed cash-out. No live deposit
was performed. Staging is Base mainnet and requires coordinator approval before
spending, with at most 2 USDC for the approved check.
