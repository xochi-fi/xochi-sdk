# xochi-conformance (Python)

Reproduces every `@xochi/spec` `conformance/conformance.json` signature byte-for-byte. Network-free.

```bash
uv sync --locked
uv run pytest
```

**Not a production signer**: it rejects non-canonical input instead of normalizing it: a short ERC-3009 nonce, or an integer that is not a non-negative JSON integer or a plain decimal string (no sign, whitespace, separator, hex prefix, exponent, fraction or leading zero).
