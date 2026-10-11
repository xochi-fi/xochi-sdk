# @xochi/solver-sdk

Maker-side SDK for the Riddler **sealed-bid RFQ**. A solver implements `capabilities`, `quote` and
`fill`; `SolverClient.run` drives discovery -> bid -> award -> fill and does the sealing and signing.

> **Nobody can win yet.** `/solver/*` is served only behind `SOLVER_RFQ_ENABLED` (off on prod).
> Enabled, solvers receive announcements and submit real signed bids, but Riddler awards a third
> party only when it can bind an escrow, so today the venue's reserve wins every auction. `quote`
> runs; `fill` is never reached through the venue. `OnchainEscrowGateway` is live: driven by hand
> it signs and broadcasts real transactions.

Normative contract:
[`SOLVER-RFC.md`](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/SOLVER-RFC.md).
Onboarding (credentials, as-built surprises, rejection codes):
[`MAKER-ONBOARDING.md`](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/solver-sdk/MAKER-ONBOARDING.md).

## Install

```bash
npm install @xochi/solver-sdk
```

## Usage

```ts
import {
  SolverClient,
  SOLVER_RFC_VERSION,
  type Solver,
  type IntentAnnouncement,
} from "@xochi/solver-sdk";

// Nothing you sign carries the corridor, so this index is your only record of
// what you priced. Keep entries until `closesAt + exclusiveWindowMs`.
const live = new Map<string, IntentAnnouncement>();

const solver: Solver = {
  capabilities: () => ({
    solverId, // = your solver key's address
    chains: [8453, 10],
    tokens: ["usdc"],
    settlementTypes: ["public"],
    rfcVersion: SOLVER_RFC_VERSION,
  }),
  // A bid, or null to pass. `minOutput` is the floor, not the reserve.
  quote: async (intent) => {
    live.set(intent.intentId, intent);
    return {
      output: priceIt(intent),
      validUntilMs: intent.closesAt + 2_000, // absolute unix ms
      minExclusiveMs: 30_000, // shortest fill window you accept
    };
  },
  // Called only if you win.
  fill: async (award) => {
    const intent = live.get(award.intentId);
    if (!intent) throw new Error(`award for untracked intent ${award.intentId}`);
    return {
      auctionId: award.auctionId,
      intentId: award.intentId,
      solverId,
      proof: { kind: "tx_hash", chainId: intent.toChainId, txHash: await settle(award) },
    };
  },
};

const client = new SolverClient({
  baseUrl,
  solverKey,
  apiKey,
  onFeedGap: (gap) => log.warn("missed intents", gap),
});
await client.run(solver);
```

Reference solvers, from a repo checkout (the examples are not in the tarball):

```bash
npm run example:solver -w @xochi/solver-sdk             # offline: full loop incl. award + fill
npm run example:solver -w @xochi/solver-sdk -- --live   # against a venue's /solver/* surface
npm run example:escrow -w @xochi/solver-sdk             # escrowed award: prepare -> accept -> fill -> claim
```

## Rules you must follow

- **Version gate.** `run` refuses (`VenueVersionSkewError`, nothing signed) unless
  `capabilities.rfcVersion === SOLVER_RFC_VERSION`; import the constant, never retype it.
- **Bids are SolverBid v2** (RFC §5.1), pinned by `@xochi/spec`'s
  `conformance/solver-bid-v2.json`; sign the announcement's `orderId` verbatim, `validUntilMs` is
  absolute unix ms, `output` is canonical decimal.
- **`minOutput` is admissibility, not the reserve.** A bid at `minOutput + 1` is admissible and
  still loses.
- **Handle `onFeedGap`.** `dropped` and `reset` mean intents you will never see.
- **Escrow flow is `prepare(award, { bid, announcement })` -> `accept` -> `fill`.** Your own
  `bid.output` is the only FillAuth amount ceiling; `award.output` is the venue's word.
- **Persist in `accept`'s `onSigned`.** It is awaited after signing and before the POST; a throw
  stops the POST. The obligation starts when the acceptance is sent; an accepted no-show is
  slashed, so decline rather than skip.
- **One acceptance per `orderId`.** On restart call `restoreAcceptance(prepared)` for every
  persisted order before any award; use `accept(prepared, { resume: true })` only if this process
  may have sent the acceptance before crashing.
- **Drive an accepted fill until it lands.** Call `fill(prepared)` until `confirmed` or
  `already_filled`; retry `not_sent`, thrown reads, `in_doubt` and `reverted` before the deadline;
  stop on `auth_expired`, `fill_auth_mismatch`, `not_accepted`. Then run `claimUntilRefundable`
  regardless.
- **Never resend at a new nonce.** An `in_doubt` or `cancelled` send is resolved with
  `resolveTx(chainId, outcome.hashes ?? outcome.txHash, outcome, effect)`; `cancelled` is not
  final, and a fill is a no-show only on `not_sent`.
- **Send only through the gateway.** It assigns nonces in one queue per `chainId:address`; sends
  from the same key elsewhere can collide. Signers must be local keys (`ethers.Wallet`).
- **One key per solver:** bid signer = FillAuth filler = RiddlerFiller `msg.sender` = bonded
  account.
- **Approve once** with `gateway.ensureAllowance(...)` at startup; never reset an allowance that
  still covers owed fills.
- **State file is held by a renewed lease** (the example's `SOLVER_STATE_FILE.lock`), never a
  pid/hostname liveness check. Your stop grace period must cover the fill/claim drain.
- **Announcements are confidential** and must not be republished.

## API surface

- `SolverClient`, `HttpSolverTransport` (`readTimeoutMs`, `acceptTimeoutMs`, `postTimeoutMs`, all
  10 s), `VenueVersionSkewError`
- `signBid`, `verifyBid`, `verifyBidDetailed`, `solverIdFromKey`, `bidTypedData`, `bidDigest`
- `SOLVER_RFC_VERSION`, `SOLVER_BID_DOMAIN`, `SOLVER_BID_TYPES`, `SOLVER_BID_PRIMARY_TYPE`,
  `MAX_BID_MS`, `ZERO_ORDER_ID`
- Zod wire schemas (`IntentAnnouncementSchema`, `AwardSchema`, `BidSchema`, ...) and
  `parseSolverEvent`
- Escrow: `OnchainEscrowGateway`, `StubEscrowGateway`, `verifyAward`, `requireFillableEscrow`,
  `checkFillWindow`, `verifyAttestation`, `EscrowRefusalError`

Breaking changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/solver-sdk/CHANGELOG.md).
