# xochi-conformance (Rust)

Reproduces every `@xochi/spec` `conformance/conformance.json` signature byte-for-byte, via alloy + k256. Network-free.

```bash
cargo test
```

**Not a production signer**: it rejects non-canonical input (e.g. a short ERC-3009 nonce) instead of normalizing it.
