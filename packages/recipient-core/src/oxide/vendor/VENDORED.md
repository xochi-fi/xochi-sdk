# Vendored: Oxide client subset

The recipient tool (xochi-fi/xochi#759) spends and exits OXDAI through Oxide's own client
code: the enclave transport and HPKE sealing, the attestation parser, the TokenOperation
collector, the capsule layout, the token registration and `submit()`. Upstream publishes no
package, so the code is copied here, as pxe-bridge does for its Oxide sender
(xochi-fi/pxe-bridge#84, xochi#744).

|                        |                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                 | https://github.com/aztec-labs-eng/zkmoney-public, `vendor/oxide/yarn-project/`                                                                                                                                                      |
| Commit                 | `8fd198412a956f214639b5782d3a86e3d47ca60e` (2026-10-27)                                                                                                                                                                             |
| Oxide subset           | `3b5e1f7c8f18e24f74d463911b319aac101f0aee` (`EXPORT-MANIFEST.json` `oxidePin`)                                                                                                                                                      |
| Deployment it serves   | Oxide v6 mainnet, manifest `gitSha` `3d8e29dc359023012a91d75538ed757dc9add937` (pinned in `../../corridor.ts`)                                                                                                                      |
| pxe-bridge copy reused | xochi-fi/pxe-bridge `src/oxide/vendor/` at `0e01c17` (main, #85), byte for byte                                                                                                                                                     |
| License                | MIT, Copyright (c) 2026 Aztec Labs: `LICENSE` and `NOTICE` here are upstream's, byte for byte. No file carries an SPDX header, so the MIT license applies to all of them (upstream `NOTICE`). No Solidity (Apache-2.0) is vendored. |

## How it was made

1. `src/oxide/vendor/` of pxe-bridge `0e01c17` was copied unchanged: the files, their two
   mechanical rewrites (`@oxide/<pkg>/<path>.js` to the relative path, `'zod'` to `'zod4'`,
   an npm alias of `zod@4.4.3`) and pxe-bridge's three edits (`fleet_signer.ts`, `types.ts`,
   `token_registration.ts`, each with a header comment). pxe-bridge's `VENDORED.md` lists them.
2. The files `submit()` needs for withdrawals were added from the same upstream commit, with
   the same two rewrites:

| Here                                                  | Upstream                                                  | Status                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oxide-client/l2_operations.ts`                       | `oxide-client/src/l2_operations.ts`                       | **modified**: a signed-withdrawal hook persists recovery data before proving or sending; phase hooks distinguish `simulate`, `hydrate`, `tee-sign`, and `prove`; the direct wallet-simulation boundary replaces raw failures with a privately branded sentinel; the non-vendored node-submit wrapper owns the `pre-send` tx-hash boundary |
| `oxide-client/submitted_withdrawal.ts`                | `oxide-client/src/submitted_withdrawal.ts`                | unmodified                                                                                                                                                         |
| `oxide-client/withdrawal_finalization_request.ts`     | `oxide-client/src/withdrawal_finalization_request.ts`     | unmodified                                                                                                                                                         |
| `oxide-client/withdrawal_in_tx.ts`                    | `oxide-client/src/withdrawal_in_tx.ts`                    | unmodified                                                                                                                                                         |
| `oxide-client/broadcaster_calls.ts`                   | `oxide-client/src/broadcaster_calls.ts`                   | unmodified                                                                                                                                                         |
| `oxide-client/executors/plain_withdrawal_executor.ts` | `oxide-client/src/executors/plain_withdrawal_executor.ts` | **modified**: `readPlainWithdrawalFee` removed with its `@oxide/l1-contracts` and `viem` imports; the tool reads `FEE()` itself (`../../chain.ts`)                 |
| `oxide-lib/l1_operation_calldata.ts`                  | `oxide-lib/src/l1_operation_calldata.ts`                  | unmodified                                                                                                                                                         |
| `oxide-lib/plain_withdrawal_executor.ts`              | `oxide-lib/src/plain_withdrawal_executor.ts`              | unmodified                                                                                                                                                         |
| `oxide-lib/executor.ts`                               | `oxide-lib/src/executor.ts`                               | unmodified                                                                                                                                                         |

`../enclave.ts` (the enclave trust checks and the `FleetRegistry` the modified
`fleet_signer.ts` takes) is pxe-bridge's own code at `0e01c17` (MIT, Copyright (c) 2026 Xochi),
changed only to take its pins from the corridor record (`../pins.ts`).

`tsconfig.json` here compiles the subset under upstream's own compiler options as a project
reference (`npm run typecheck` / `npm run build` run `tsc -b`), so the files need no edits for
the tool's stricter flags.

## Node-only files kept out of the core

The core is platform-neutral (contract C), so nothing here imports a Node builtin:

- `oxide-lib/attestation/nitro_attestation/verify_nitro_attestation.ts` (`node:crypto`) moved,
  byte for byte, to the CLI: `tools/recipient/src/node/vendor/` (its `README.md`). The CLI injects
  it as its `AttestationVerifier`; browsers use `src/attestation/`.
- `oxide-lib/attestation/verify_tee_attestation.ts` was removed: nothing imports it since
  `../enclave.ts` computes the user-data binding itself and checks the verifier's result.

## Not vendored

- The OxideToken artifact and its Noir sources. The tool takes the artifact as a file
  (`--oxide-token-artifact`) and refuses it unless its class id and in-protocol artifact hash
  are the corridor's. pxe-bridge vendors the Noir sources and builds it reproducibly
  (`npm run build:oxide-token` there, toolchain aztec-up 6.0.0).
- The compiled L2 Broadcaster artifact, for exits. zk.money publishes none, but its source is
  public: `../../../contracts/oxide/` holds `noir-projects/{broadcaster_contract, oxide_lib}` from
  the same upstream commit, byte for byte (`Nargo.toml` and `src/`; `oxide_lib` is identical to
  pxe-bridge's copy), with upstream's `LICENSE` and `NOTICE`. `npm run build:broadcaster`
  (`scripts/build-broadcaster.sh`) compiles it with pxe-bridge's toolchain and flags and refuses
  the result unless its class is the deployed `0x24f2762a...78ae`; a native arm64 build on
  2026-11-03 gave exactly that class. `exit` re-checks the class against the live
  `l2Broadcaster` instance before use.
- `@oxide/l1-contracts`: the one L1 view an exit needs (`PlainWithdrawalExecutor.FEE()`) and
  pxe-bridge's TeeRegistry / CertManager / portal views are declared in the tool.

## Updating

Repeat "How it was made" at the pxe-bridge commit that moves the Oxide pin, re-apply the
**modified** rows, and update the deployment pins in `../../corridor.ts` together; then
`npm run typecheck && npm test`. A new Oxide deployment is a new pin, reviewed, never absorbed.
