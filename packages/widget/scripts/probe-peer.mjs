// Explicitly opt-in, read-only. No raw responses, provider errors or wallet input are printed.
if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  process.stdout.write("Opt in with npm run probe:peer -- --live after building the widget.\n");
  process.exit(0);
}
try {
  const { atomic, validateRampSettlement } = await import("@xochi/client");
  const { getContracts } = await import("@zkp2p/sdk");
  const { fetchPeerCapabilities } = await import("../dist/ramp/peer/discovery.js");
  const environment = process.env.PEER_ENVIRONMENT ?? "production";
  if (!["production", "preproduction", "staging"].includes(environment)) throw new Error();
  const wallet = process.env.PEER_WALLET_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet ?? "")) throw new Error();
  const amount = process.env.PEER_USDC_ATOMIC ?? "25000000";
  if (!/^[1-9][0-9]{0,77}$/.test(amount)) throw new Error();
  const crypto = validateRampSettlement({
    kind: "crypto",
    chain_id: "eip155:8453",
    asset_id: getContracts(8453, environment).addresses.usdc,
    symbol: "USDC",
    decimals: 6,
  });
  if (!crypto) throw new Error();
  for (const direction of ["onramp", "offramp"]) {
    const result = await fetchPeerCapabilities(
      {
        contract_version: "ramp/1",
        kind: "intent",
        direction,
        fiat: { kind: "fiat", currency: "USD", decimals: 6 },
        crypto,
        exact: { side: "crypto", money: { asset: crypto, atomic: atomic(amount) } },
        recipient: wallet,
      },
      { environment, user: wallet },
    );
    process.stdout.write(JSON.stringify({ direction, ...result }, null, 2) + "\n");
  }
} catch {
  process.stdout.write(
    '{"availability":{"state":"availability_unknown","reason_code":"capabilities_unavailable"}}\n',
  );
  process.exitCode = 1;
}
