# xochi-sdk

TypeScript packages for building on Xochi: ERC-8262 ZK compliance proofs, provider attestations, the trade API client and widget, intent signing, and the wire contract.

## Packages

| Path                       | npm                     | Purpose                                                                    | Release tag         | Published                      |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------- | ------------------- | ------------------------------ |
| `packages/sdk`             | `@xochi/sdk`            | Generate and verify ERC-8262 ZK compliance proofs; tiers, scoring, XIP-1/2 | `sdk-v*`            | on npm                         |
| `packages/provider`        | `@xochi/provider`       | Compliance-data provider attestations for the signed circuits; daemon      | `provider-v*`       | first publish due              |
| `packages/client`          | `@xochi/client`         | Xochi trade API client: transport, trade state machine, fund-safety checks | `client-v*`         | first publish due              |
| `packages/widget-lib`      | `@xochi/widget-lib`     | Embed the Xochi swap widget with an EIP-1193 wallet bridge                 | `widget-lib-v*`     | published `0.5.0`              |
| `packages/widget`          | `@xochi/widget`         | Complete React trading widget, iframe configurator, styles and assets      | `widget-v*`         | source extraction; unpublished |
| `packages/signer`          | `@xochi/signer`         | Network-free EIP-712 signing and pre-sign checks for Xochi intents         | `signer-v*`         | first publish due              |
| `packages/spec`            | `@xochi/spec`           | Protocol spec, wire contract and conformance vectors                       | `spec-v*`           | first publish due              |
| `packages/recipient-core`  | `@xochi/recipient-core` | Platform-neutral OXDAI recipient facade and durable journals               | `recipient-core-v*` | not yet published              |
| `packages/solver-sdk`      | `@xochi/solver-sdk`     | Maker-side sealed-bid RFQ SDK                                              | none yet            | when the solver panel opens    |
| `packages/reference`       | `@xochi/reference`      | Network-free fixtures for the spec generators and vector suites            | none                | never (private)                |
| `runners/{python,go,rust}` | `xochi-conformance`     | Byte-parity runners over `conformance.json`, for CI                        | none                | never                          |
| `tools/recipient`          | none                    | OXDAI recipient operator CLI; moves funds; not a workspace                 | `recipient-v*`      | never (GitHub prerelease)      |

Tags publish through `.github/workflows/release.yml`, one package per tag; `recipient-core` installs, gates and publishes from its own directory because it is not a root workspace; `tools/recipient` test artifacts through `recipient-release.yml`. Package READMEs: [sdk](packages/sdk/README.md), [provider](packages/provider/README.md) ([daemon](packages/provider/daemon/README.md)), [client](packages/client/README.md), [widget-lib](packages/widget-lib/README.md), [signer](packages/signer/README.md), [spec](packages/spec/README.md), [solver-sdk](packages/solver-sdk/README.md), [recipient-core](packages/recipient-core/README.md), [recipient](tools/recipient/README.md), [Python](runners/python/README.md), [Go](runners/go/README.md), [Rust](runners/rust/README.md).

The rendered widget's [setup and publication gates](packages/widget/README.md) distinguish private tarball rehearsal from approved publication. The lightweight host loader remains independent of React; private host deployment and rollback records stay outside this public repository.

## Three kinds of signing

- **`@xochi/signer`: the taker's signer. It moves funds.** EIP-712 Xochi intents, ERC-3009 and Permit2 pull authorizations, plus the pre-sign checks that hold a server quote to the request. A bug here loses money.
- **`@xochi/provider`: a compliance-data provider's attestations. It moves no funds.** Secp256k1 signatures over risk signals that the ERC-8262 signed circuits (0x07, 0x08, 0x09) verify in-circuit, and EIP-712 credential-root publications. `@xochi/sdk` turns them into proofs.
- **`runners/*` (`xochi-conformance`): CI byte-parity runners, not production.** Each reproduces every `@xochi/spec` `conformance.json` vector; its README states its input rules.

## Development

Node 22.12+. From the root: `npm ci`, then `npm run build`, `npm run typecheck`, `npm test` (all workspaces, `@xochi/signer` built first); one package with `-w @xochi/<name>`. Proof integration tests (`npm run test:integration`) need foundry and a compiled [ERC-8262](https://github.com/xochi-fi/ERC-8262) checkout beside this repo (or `ERC_8262_PATH`). Checked-in vectors and wire artifacts are contract state: [Who is authoritative](packages/spec/README.md#who-is-authoritative).

## More

- Changelogs: each published package's own `packages/<name>/CHANGELOG.md`
- [SECURITY.md](SECURITY.md)
- [CLAUDE.md](CLAUDE.md): repo rules and invariants
- [LICENSE](LICENSE) (MIT)
