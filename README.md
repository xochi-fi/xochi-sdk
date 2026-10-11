# xochi-sdk

TypeScript packages for building on Xochi: ERC-8262 zero-knowledge compliance proofs, the Xochi trade API client and embeddable widget, network-free intent signing, and the protocol's wire contract with byte-equality conformance vectors. The repo root is a private npm workspace root and publishes nothing; every package lives under `packages/`.

## Packages

| Path                  | npm                 | Purpose                                                                    | Release tag                         |
| --------------------- | ------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| `packages/sdk`        | `@xochi/sdk`        | Generate and verify ERC-8262 ZK compliance proofs; tiers, scoring, XIP-1/2 | `sdk-v*` (on npm)                   |
| `packages/client`     | `@xochi/client`     | Xochi trade API client: transport, trade state machine, fund-safety checks | `client-v*` (first publish due)     |
| `packages/widget-lib` | `@xochi/widget-lib` | Embed the Xochi swap widget with an EIP-1193 wallet bridge                 | `widget-lib-v*` (first publish due) |
| `packages/signer`     | `@xochi/signer`     | Network-free EIP-712 signing and pre-sign checks for Xochi intents         | `signer-v*` (first publish due)     |
| `packages/spec`       | `@xochi/spec`       | Protocol spec, wire contract and conformance vectors                       | `spec-v*` (first publish due)       |
| `packages/solver-sdk` | `@xochi/solver-sdk` | Maker-side sealed-bid RFQ SDK                                              | none until the solver panel opens   |
| `packages/reference`  | `@xochi/reference`  | Network-free fixtures for the spec generators and vector suites            | never (private)                     |

Each package has its own README. Tags publish through `.github/workflows/release.yml`, one package per tag.

## Conformance ports

`sdks/python`, `sdks/go` and `sdks/rust` reproduce every `packages/spec/conformance/conformance.json` vector byte-for-byte. They are conformance ports, not production signers; each has its own README and CI job.

## Development

Node 22.12+. Install once at the root; every workspace shares the root lockfile.

```bash
npm ci
npm run build          # every workspace, @xochi/signer first (= build:workspaces)
npm run typecheck      # every workspace (= typecheck:workspaces)
npm test               # every workspace's unit tests (= test:workspaces)
npm run format:check   # root json/md; each workspace has its own format:check
```

One package: `npm test -w @xochi/sdk`, `npm run build -w @xochi/client`, and so on. Proof integration tests need foundry and a compiled [ERC-8262](https://github.com/xochi-fi/ERC-8262) checkout beside this repo (or `ERC_8262_PATH`): `npm run test:integration`.

Wire artifacts are checked-in contract state; regenerating them is a wire change that lands with the server, never a refresh to make CI pass:

```bash
npm run generate:conformance && npm run generate:fee && git diff --exit-code packages/spec/conformance/conformance.json packages/spec/fee/
npm run generate:solver-bid-v2 && npm run generate:escrow && git diff --exit-code packages/spec/conformance/
```

`scripts/` holds the scheduled producer-drift probes (`npm run verify:openapi`, `verify:spec-version`, `verify:version`, `verify:vectors`).

## More

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [LICENSE](LICENSE) (MIT)
