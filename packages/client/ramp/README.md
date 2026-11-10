# ramp/1

Canonical public JSON wire contract for independently approved Peer and optional
Xochi ramp legs. Source availability is not package publication, hosted iframe
permission, live provider availability, or verified execution.

`contract.schema.json` defines the structural contract; `conformance.json` contains
synthetic, runtime-neutral inputs and expected semantic outcomes. Neither contains
live offers, provider credentials, or executable transactions. TypeScript bindings
are inferred from the runtime schemas and checked against the JSON Schema with the
same vectors. Regenerate the structural artifact with `npm run generate:ramp -w
@xochi/client`. Raxol can consume these JSON artifacts directly; its Elixir binding
and cross-runtime execution remain cross-repository gates, not an SDK harness.

## Messages

Every message has `contract_version: "ramp/1"` and a required `kind`:
`offer`, `intent`, `preview`, `snapshot`, `command`, or `error`. Every JSON field is
snake_case. TypeScript uses the same wire names; there is no second camelCase wire
schema. Unknown required discriminants fail closed. Bounded unknown optional
fields are discarded, never forwarded. `parseRamp(unknown)` is the public boundary:
it performs structural and semantic checks and returns sanitized data or only
`invalid_request` / `unsupported_version`. The individual schemas describe shapes;
do not substitute shape validation for `parseRamp`.

Amounts are unsigned base-10 **atomic unit strings**, matching
`/^(0|[1-9][0-9]*)$/` over the entire string (including rejecting trailing newlines).
`atomic(string | bigint)` returns an exact branded string. Numbers, signs,
decimals, exponents, whitespace and leading zeroes are rejected. Fiat currency
and decimals, and crypto chain/contract/decimals, must be validated against live
provider configuration. A symbol is never asset identity. Phase 1 settlement is
Base USDC; the contract itself is provider-neutral vocabulary, not a capability
allowlist. Bounds must use their stated asset and satisfy minimum <= maximum.

Availability states: `available` (with `valid_until`), `setup_required`
(`requirement_codes`), `temporarily_unavailable` (`reason_code`, optional
`retry_after`), `not_supported`, and `availability_unknown` (`reason_code`).
An offer's expiry must follow its observation. Parsing a structurally available
offer **does not authorize execution**: discovery/preview must independently
establish a fresh live response, exact corridor/bounds/region/rail, Base USDC
identity, and current requirements. Static metadata and stale responses cannot
enable a rail. Full discovery normalization belongs to #169.

## Independent leg semantics

Snapshots contain mandatory `peer`, optional `xochi`, explicit `leg_order`, a
canonical unsigned integer-string `revision`, and a checked derived `terminal`.
Onramp ordering is Peer then optional Xochi; offramp ordering is optional Xochi
then Peer. Peer-only ordering is `["peer"]`.

Each leg has its own state, `recoverable` flag, optional bounded failure code and
public transaction hash. States: `not_started`, `quoted`, `approval_required`,
`action_required`, `processing`, `completed`, `failed`, `in_doubt`, `refunded`,
`skipped`. `rampOutcome()` derives overall state, never mutates a successful leg,
and only marks terminal when every requested leg is terminal. Completed Peer /
failed Xochi and completed prerequisite Xochi / failed Peer are partial success,
not atomic rollback. A skipped optional route does not erase Peer completion.
In-doubt is nonterminal and allows only `check_status`, never approve, execute,
requote, skip, or execute-again. Provider-specific reconciliation can be added
only through a reviewed contract change; recovery codes do not grant resubmission.

Commands carry `operation_id`, target `leg`, bounded `action`, and
`context: { expected_revision, idempotency_key }`, plus optional quote/disclosure
bindings. `checkRampCommand` is a pure preflight, **not an executor or durable
idempotency store**. An exact command replay with its retained receipt is
recognized before stale revision checking; reuse of a key for different content,
wrong operation, or stale revision conflicts. New actions require current
revision, an existing leg, an allowed action, and a nonterminal target. Retain
idempotency receipts for the operation lifetime; after uncertain submission,
reconcile rather than invent another key or operation. Replays return the stored
receipt snapshot; revision conflicts return the latest sanitized snapshot.
Persisted orchestration, transitions, atomic command reservation and execution
remain #171. Every signature and transaction approval remains caller-owned.

## Secret boundary

Only locally minted, non-authorizing references belong in public identifier
fields. Never copy provider session/order handles into them. Public requests,
fixtures, snapshots, examples, widget events, logs and telemetry must exclude
Peer cookies/OAuth codes, payment credentials/handles, identity documents or
attributes, proof material/session IDs, bearer URLs/recovery tokens, raw provider
responses/errors, wallet private keys/signatures, and Xochi read tokens. A string
matching a reference regex does not make a provider secret public. Caller and
adapter ownership of this boundary is mandatory; these schemas are not a
credential classifier. Never log input or schema diagnostics from an untrusted
provider. Public errors contain bounded codes, not raw provider messages.

The contract contains no wallet signer, browser dependency, provider transport,
new bridge, or hosted implementation. Peer adapters belong in `@xochi/widget`;
the existing iframe/wallet bridge remains in `@xochi/widget-lib`.
