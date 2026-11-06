# xochi-conformance (Rust)

Reproduces every `@xochi/spec` `conformance/conformance.json` signature byte-for-byte, via alloy + k256. Network-free.

```bash
cargo test
```

**Not a production signer**: it rejects non-canonical input instead of normalizing it: a short ERC-3009 nonce, or an integer that is not a non-negative JSON integer or a plain decimal string (no sign, whitespace, separator, hex prefix, exponent, fraction or leading zero).
