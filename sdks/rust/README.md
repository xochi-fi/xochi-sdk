# xochi-signer (Rust)

Riddler protocol conformance signer. Reproduces every vector in
`@xochi/spec` `conformance/conformance.json` byte-for-byte (SPEC.md 2/8) via
alloy + k256. Network-free.

```bash
cargo test
```

## Scope

A **conformance runner**, not a production signer. It assumes well-formed
fixture input and skips `@xochi/signer`'s input normalization (e.g. ERC-3009
nonce left-padding in `signing.ts`); non-canonical input (e.g. a short nonce) is
**rejected, never mis-signed**. A production port needs normalization and
untrusted-input handling.
