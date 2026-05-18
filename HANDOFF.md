# Handoff: rename for ERC-8262

The reference implementation has been renamed to drop the project-name from
identifiers visible to the ERC reviewer. The SDK now needs corresponding
updates to stay byte-for-byte parity with the on-chain contracts.

## Background

- Canonical ERC: `github.com/ethereum/ERCs` PR #1747 (ERC-8262, branch
  `add-erc-zk-compliance-oracle`).
- Reference impl: `github.com/xochi-fi/ERC-8262` (renamed from `ERC-8338`).
- The reviewer flagged "Xochi" as product promotion. Contracts have been
  renamed; the SDK keeps its `xochi-sdk` package name for now but its
  hardcoded contract names and the EIP-712 domain string have drifted.

## Contract rename map

| Old                        | New                       |
| -------------------------- | ------------------------- |
| `IXochiZKPVerifier`        | `IERC8262Verifier`        |
| `IXochiZKPOracle`          | `IERC8262Oracle`          |
| `XochiZKPVerifier`         | `ERC8262Verifier`         |
| `XochiZKPOracle`           | `ERC8262Oracle`           |
| `XochiTimelock`            | `Timelock`                |
| `src/XochiZKPVerifier.sol` | `src/ERC8262Verifier.sol` |
| `src/XochiZKPOracle.sol`   | `src/ERC8262Oracle.sol`   |
| `src/XochiTimelock.sol`    | `src/Timelock.sol`        |

## Critical: EIP-712 domain name change

`src/provider/eip712.ts:24` currently has:

```ts
const DOMAIN_NAME_HASH = keccak256(toBytes("XochiZKPOracle"));
```

The Solidity contracts at `src/libraries/EIP712Attestation.sol` and
`src/libraries/EIP712CredentialRoot.sol` now use `keccak256("ERC8262Oracle")`.
Any signature produced by the SDK under the old domain will fail to recover
to the registered signer at `publishCredentialRoot` / `submitCompliance`.

After updating the domain name, the SDK's parity test
(`test/eip712-credential-root.test.ts`) should produce digest
`0x82109ef42010d7a55f19c7b22fb75d1ebf990ec91663fc8c7fa9dd13ead2b3dd` for the
canonical SAMPLE fixture. The matching `forge test` at
`ERC-8262/test/EIP712CredentialRootParity.t.sol` has been updated with this
value already.

## Files needing rename / update

Replace `XochiZKPOracle` -> `ERC8262Oracle`,
`XochiZKPVerifier` -> `ERC8262Verifier`,
`IXochiZKPOracle` -> `IERC8262Oracle`,
`IXochiZKPVerifier` -> `IERC8262Verifier`:

- `src/abis.ts` (comment + any type names)
- `src/oracle.ts`
- `src/errors.ts`
- `src/inputs/risk-score.ts`
- `src/provider/pedersen.ts`
- `src/provider/keystore.ts`
- `src/provider/credential-root-signer.ts`
- `src/provider/eip712.ts` (BOTH comment line 8 AND `DOMAIN_NAME_HASH` line 24)
- `test/integration-oracle.test.ts` (incl. `loadBytecode("XochiZKPOracle.sol", "XochiZKPOracle")`)
- `test/integration-signed-onchain.test.ts`
- `test/integration-settlement.test.ts`

Run a final `grep -rn "Xochi\|XochiZKP" src test` to confirm clean.

## Class rename (optional)

`src/oracle.ts:2` defines a `XochiOracle` client class. Renaming to
`ERC8262Oracle` (TypeScript class) keeps parallel with the contract name but
may break downstream importers. Defer if downstream consumers exist.

## SDK package name

`package.json` still declares `"name": "xochi-sdk"`. The cross-repo references
in `ERC-8262/circuits/shared/src/sig.nr` and `multi_sig.nr` point at this
package by name. If you rename the package (e.g. to `@erc8262/sdk`), update
those `.nr` assertion messages in lockstep -- search the impl repo for
`xochi-sdk` to find them. Otherwise leave the package name alone.

## Verification

After all updates:

```bash
pnpm test                # or npm test / vitest -- run the full suite
grep -rn "Xochi" src test  # expect zero matches (if package renamed)
```

Then push to `xochi-fi/xochi-sdk` (or new repo name if renamed).
