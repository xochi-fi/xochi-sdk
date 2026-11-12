# Vendored: the Node-only Nitro attestation verifier

`nitro_attestation/verify_nitro_attestation.ts` is upstream's file, byte for byte (VENDORED, same
source, commit and MIT license as `../../core/oxide/vendor/VENDORED.md`; its SHA-256 is pinned by
`packages/recipient-core/test/attestation/verifier.test.ts`). It imports `node:crypto`, so it lives
in the CLI, not the platform-neutral core; `../attestation.ts` wraps it as the CLI's
`AttestationVerifier`. `nitro_attestation/parsers.ts` is not vendored: it re-exports the core's
vendored parser so the verifier's `./parsers.js` import resolves unchanged. It compiles in
`tsconfig.vendor.json` under upstream's compiler options and is excluded from `prettier`.
