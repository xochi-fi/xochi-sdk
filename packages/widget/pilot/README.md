# Robinhood Testnet sponsorship pilot

The widget exposes the 46630 USDG origin and 421614 USDG destination only with `development: true`, `originSponsorshipTestnet: true` and a trusted origin adapter. An exact public corridor still needs live venue capabilities. The approval-only pilot can instead take a genuine Riddler quote ID issued to the owner under the configured quote credential. The browser's normal quote and execute endpoints require independent venue support for this corridor.

Run the terminal wallet with a disposable owner key, the approved testnet venue, and its independently confirmed verifying paymaster. Keep the key local. The factory sender only supports Send. First Permit2 approval uses the already delegated owner and expects a quote for the exact amount and sender.

```sh
node --import tsx packages/widget/pilot/robinhood.ts init /tmp/pilot-owner.key
node --import tsx packages/widget/pilot/robinhood.ts inventory /tmp/pilot-owner.key
node --import tsx packages/widget/pilot/robinhood.ts delegate /tmp/pilot-owner.key /tmp/pilot-gas-payer.key
node --import tsx packages/widget/pilot/robinhood.ts send /tmp/pilot-owner.key 1000000 RECIPIENT
node --import tsx packages/widget/pilot/robinhood.ts approve /tmp/pilot-owner.key 1000000 QUOTE_ID
node --import tsx packages/widget/pilot/robinhood.ts status /tmp/pilot-owner.key CHECKPOINT_FILE
```

`delegate` uses a separate, funded testnet-only payer key to keep the asset holder's native balance at zero. `send`, `approve`, and `status` require `ITEM143_PILOT_VENUE` and `ITEM143_VERIFYING_PAYMASTER`. `ITEM143_TESTNET_RPC` overrides the official public RPC. The terminal wallet checks the chain ID, requires a user confirmation for each signature and saves the operation hash before submit. Use the checkpoint for read-only recovery. A success requires the venue status, the matching EntryPoint event from the chain RPC, and the expected token and native balance or allowance changes.
