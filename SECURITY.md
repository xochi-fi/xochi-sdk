# Security

Report vulnerabilities privately: [GitHub security advisory](https://github.com/xochi-fi/xochi-sdk/security/advisories/new). Do not open a public issue.

## Scope

Highest severity: anything that signs, or lets a caller sign, bytes that move funds.

- `@xochi/signer`: EIP-712 signing, intent/pull/deposit/claim checks, escrow pins
- `@xochi/client`: fund-safety checks in the trade state machine and transport
- `@xochi/solver-sdk`: escrow gateway (fills, claims, nonce handling)
- `@xochi/widget-lib`: postMessage origin checks, RPC allowlist
- `@xochi/sdk`: proof generation, input validation, on-chain clients
- `@xochi/provider`: provider attestation signing, key loading, the reference daemon's auth and signing policy
- `@xochi/spec`: conformance vectors and the wire differ

Out of scope: `sdks/{python,go,rust}` (conformance runners, not production signers) and services not deployed from this repo.

## Supported versions

Latest published version of each package. `@xochi/sdk` 0.3.x is deprecated.
