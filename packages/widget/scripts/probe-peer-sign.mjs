// Read-only production auth observation. Never submits a transaction or spends funds.
if (process.argv[2] !== "--live" || process.argv.length !== 3) {
  process.stdout.write("Opt in with node packages/widget/scripts/probe-peer-sign.mjs --live\n");
  process.exit(0);
}
const result = {
  observedAt: new Date().toISOString(),
  environment: "production",
  endpoint: "/v3/sign",
  wallet: "public burn address",
  transactionsSubmitted: 0,
  fundsSpentAtomic: "0",
};
try {
  const { getContracts, getPaymentMethodsCatalog, resolveFiatCurrencyBytes32 } =
    await import("@zkp2p/sdk");
  const addresses = getContracts(8453, "production").addresses;
  const user = "0x000000000000000000000000000000000000dEaD";
  const response = await fetch("https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      fiatCurrency: "USD",
      user,
      recipient: user,
      destinationChainId: 8453,
      destinationToken: addresses.usdc,
      escrowAddresses: [addresses.escrowV2],
      exactTokenAmount: "1000000",
      paymentPlatforms: ["wise", "revolut", "chime"],
      mode: "eligible",
      quotePreference: "EXCLUSIVE_BUYER_TEE",
    }),
  });
  result.quoteHttpStatus = response.status;
  const raw = await response.json();
  const q = raw?.responseObject?.quotes?.[0];
  if (!response.ok || !q?.intent?.payeeDetails || !q?.intent?.depositId) {
    result.observation = "no_executable_quote_for_auth_probe";
  } else {
    const catalog = getPaymentMethodsCatalog(8453, "production");
    const signed = await fetch("https://api.zkp2p.xyz/v3/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        processorName: q.intent.processorName,
        payeeDetails: q.intent.payeeDetails,
        depositId: String(q.intent.depositId),
        amount: q.signalIntentAmount,
        toAddress: user,
        paymentMethod: catalog[q.intent.processorName].paymentMethodHash,
        fiatCurrency: resolveFiatCurrencyBytes32("USD"),
        conversionRate: q.conversionRate,
        chainId: "8453",
        orchestratorAddress: addresses.orchestratorV4,
        escrowAddress: addresses.escrowV2,
        callerAddress: user,
        referralFees: [],
      }),
    });
    result.signHttpStatus = signed.status;
    // Discard response material; only bounded observations leave this process.
    const body = await signed.json();
    result.curatorSigned = signed.ok && body?.success === true;
    result.linkedSessionRequired = signed.status === 401 || signed.status === 403;
    result.observation = result.curatorSigned
      ? "unauthenticated_signing_accepted_for_probe"
      : result.linkedSessionRequired
        ? "authenticated_setup_required"
        : "signing_declined_auth_requirement_unproven";
  }
} catch {
  result.observation = "read_unavailable_auth_requirement_unproven";
}
process.stdout.write(JSON.stringify(result) + "\n");
