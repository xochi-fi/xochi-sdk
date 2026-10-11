# xochi-sdk

TypeScript packages for building on Xochi: ERC-8262 zero-knowledge compliance proofs and the provider attestations they consume, the Xochi trade API client and embeddable widget, network-free intent signing, and the protocol's wire contract with byte-equality conformance vectors. The repo root is a private npm workspace root (`xochi-sdk-workspace`) and publishes nothing; every package lives under `packages/`.

## Packages

| Path                    | npm                 | Purpose                                                                    | Release tag     | Published                   |
| ----------------------- | ------------------- | -------------------------------------------------------------------------- | --------------- | --------------------------- |
| `packages/sdk`          | `@xochi/sdk`        | Generate and verify ERC-8262 ZK compliance proofs; tiers, scoring, XIP-1/2 | `sdk-v*`        | on npm                      |
| `packages/provider`     | `@xochi/provider`   | Compliance-data provider attestations for the signed circuits; daemon      | `provider-v*`   | first publish due           |
| `packages/client`       | `@xochi/client`     | Xochi trade API client: transport, trade state machine, fund-safety checks | `client-v*`     | first publish due           |
| `packages/widget-lib`   | `@xochi/widget-lib` | Embed the Xochi swap widget with an EIP-1193 wallet bridge                 | `widget-lib-v*` | first publish due           |
| `packages/signer`       | `@xochi/signer`     | Network-free EIP-712 signing and pre-sign checks for Xochi intents         | `signer-v*`     | first publish due           |
| `packages/spec`         | `@xochi/spec`       | Protocol spec, wire contract and conformance vectors                       | `spec-v*`       | first publish due           |
| `packages/solver-sdk`   | `@xochi/solver-sdk` | Maker-side sealed-bid RFQ SDK                                              | none yet        | when the solver panel opens |
| `packages/reference`    | `@xochi/reference`  | Network-free fixtures for the spec generators and vector suites            | none            | never (private)             |
| `sdks/{python,go,rust}` | `xochi-conformance` | Byte-parity runners over `conformance.json`, for CI                        | none            | never                       |

Tags publish through `.github/workflows/release.yml`, one package per tag. Each package has its own README: [sdk](packages/sdk/README.md), [provider](packages/provider/README.md) ([daemon](packages/provider/daemon/README.md)), [client](packages/client/README.md), [widget-lib](packages/widget-lib/README.md), [signer](packages/signer/README.md), [spec](packages/spec/README.md), [solver-sdk](packages/solver-sdk/README.md), and [Python](sdks/python/README.md), [Go](sdks/go/README.md), [Rust](sdks/rust/README.md).

## Three kinds of signing

Three things here sign bytes, and they are not interchangeable:

- **`@xochi/signer`: the taker's signer. It moves funds.** EIP-712 Xochi intents, ERC-3009 and Permit2 pull authorizations, plus the pre-sign checks that hold a server quote to the request. A bug here loses money.
- **`@xochi/provider`: a compliance-data provider's attestations. It moves no funds.** Secp256k1 signatures over risk signals that the ERC-8262 signed circuits (0x07, 0x08, 0x09) verify in-circuit, and EIP-712 credential-root publications. `@xochi/sdk` turns them into proofs.
- **`sdks/*` (`xochi-conformance`; Python `xochi_conformance`, Go package `conformance`, Rust crate `xochi-conformance`): CI byte-parity runners, not production.** They reproduce every `@xochi/signer` conformance vector byte-for-byte and reject non-canonical input rather than normalize it.

## Development

Node 22.12+. Install once at the root; every workspace shares the root lockfile.

```bash
npm ci
npm run build          # every workspace, @xochi/signer first (= build:workspaces)
npm run typecheck      # every workspace (= typecheck:workspaces)
npm test               # every workspace's unit tests (= test:workspaces)
npm run format:check   # root json/md; each workspace has its own format:check
```

One package: `npm test -w @xochi/sdk`, `npm run build -w @xochi/client`, and so on (shortcuts: `test:sdk`, `test:provider`, `test:signer`, ...). Proof integration tests need foundry and a compiled [ERC-8262](https://github.com/xochi-fi/ERC-8262) checkout beside this repo (or `ERC_8262_PATH`): `npm run test:integration`. The provider's reference daemon: `npm run daemon -w @xochi/provider`.

Wire artifacts are checked-in contract state; regenerating them is a wire change that lands with the server, never a refresh to make CI pass:

```bash
npm run generate:conformance && npm run generate:fee && git diff --exit-code packages/spec/conformance/conformance.json packages/spec/fee/
npm run generate:solver-bid-v2 && npm run generate:escrow && git diff --exit-code packages/spec/conformance/
(cd packages/spec/wire && shasum -a 256 -c <(echo "$(cat openapi.sha256)  openapi.json"))
```

`scripts/` holds the scheduled producer-drift probes (`npm run verify:openapi`, `verify:spec-version`, `verify:version`, `verify:vectors`); they need `RIDDLER_URL_PROD` (or `RIDDLER_SERVER` naming another `RIDDLER_URL_<NAME>`).

## More

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [LICENSE](LICENSE) (MIT)
