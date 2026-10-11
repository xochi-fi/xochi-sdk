# Security

Report vulnerabilities privately: [GitHub security advisory](https://github.com/xochi-fi/xochi-sdk/security/advisories/new). Do not open a public issue.

Highest severity: anything that signs, or lets a caller sign, bytes that move funds.

Every package under `packages/` is in scope. Out of scope: `conformance/{python,go,rust}` (conformance runners, not production signers) and services not deployed from this repo.

Supported: the latest published version of each package. `@xochi/sdk` 0.3.x is deprecated.
