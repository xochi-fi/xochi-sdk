# riddler-signer (Python)

Conformance signer for the Riddler protocol. Reproduces every vector in
`@xochi/spec` `conformance/conformance.json` byte-for-byte (SPEC.md §2/§8).

```bash
uv sync
uv run pytest
```

## Scope

This is a **conformance runner**, not a production signing SDK. It proves signer
parity by reproducing the frozen fixture byte-for-byte; it assumes well-formed
fixture input and does **not** replicate the reference signer's input
normalization (e.g. the ERC-3009 nonce left-padding in `@xochi/signer`'s
`signing.ts`). Non-canonical input (e.g. a short nonce) is **rejected loudly,
never silently mis-signed**. A production port must add input normalization and
untrusted-input handling before signing real quotes.
