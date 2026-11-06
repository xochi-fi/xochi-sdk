# Security

Report vulnerabilities privately: [GitHub security advisory](https://github.com/xochi-fi/xochi-sdk/security/advisories/new). Do not open a public issue.

Highest severity: anything that signs, or lets a caller sign, bytes that move funds.

In scope: every package under `packages/`, and `tools/recipient` (the OXDAI recipient operator CLI, which moves funds). Out of scope: `runners/{python,go,rust}` (CI byte-parity runners) and services not deployed from this repo.

Supported: the latest published version of each package, and the latest `tools/recipient` test prerelease. `@xochi/sdk` 0.3.x is deprecated.
