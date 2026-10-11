# Development

Part of the [`@xochi/sdk`](../README.md) reference. Repo-wide commands and the wire-contract gate: the [root README](../../../README.md).

```bash
npm ci                   # at the repo root (npm workspaces), then:
cd packages/sdk          # or run each script from the root with -w @xochi/sdk
npm test                 # unit tests + drift checks (integration excluded via vitest.config.ts); the fee
                         # schedule is checked against the workspace @xochi/spec (packages/spec)
npm run test:integration # proof generation + anvil tests (uses vitest.integration.config.ts)
npm run typecheck        # tsc --noEmit (sources + tests)
npm run format           # prettier --write
npm run format:check     # prettier --check (run in CI / prepublishOnly)
npm run build            # compile to dist/

# Sync circuit artifacts from ERC-8262. Strips debug data (file_map /
# debug_symbols) and exits non-zero, leaving circuits/ untouched, if any
# artifact is missing or its noir_version differs from EXPECTED_NOIR_VERSION.
./scripts/sync-circuits.sh ../../../ERC-8262   # default: an ERC-8262 checkout beside the repo
```

From the repo root, `npm run test:sdk` and `npm run test:integration` run the first two. Integration tests run on anvil and need [foundry](https://book.getfoundry.sh/getting-started/installation) and a compiled [ERC-8262](https://github.com/xochi-fi/ERC-8262) clone beside the repo, or `ERC_8262_PATH`. `abi-drift` and `verifier-vk-drift` in `npm test` read the same checkout and skip locally without it.

The provider-signing integration suite (`test/integration-signed-onchain.test.ts`) runs [`@xochi/provider`](../../provider/README.md)'s reference daemon in-process; `@xochi/provider` is a dev dependency only.

## Known limitations

- **Tier proofs are self-attested** (see [tier-proofs.md](tier-proofs.md)).
