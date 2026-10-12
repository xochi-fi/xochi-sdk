# xochi-conformance (Go)

Reproduces every `@xochi/spec` `conformance/conformance.json` signature byte-for-byte, via go-ethereum. Network-free.

```bash
go test ./...
```

**Not a production signer**: it rejects non-canonical input (e.g. a short ERC-3009 nonce) instead of normalizing it.
