# xochi-conformance (Python)

Reproduces every `@xochi/spec` `conformance/conformance.json` signature byte-for-byte. Network-free.

```bash
uv sync
uv run pytest
```

**Not a production signer**: it rejects non-canonical input (e.g. a short ERC-3009 nonce) instead of normalizing it.
