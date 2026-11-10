import { probeCompatibility } from "./probe.mjs";

const live = process.argv.length === 3 && process.argv[2] === "--live";
const input = live
  ? {
      environment: process.env.PEER_ENVIRONMENT ?? "production",
      address: process.env.PEER_WALLET_ADDRESS,
      amount: process.env.PEER_USDC_ATOMIC,
      currency: process.env.PEER_FIAT_CURRENCY,
      platform: process.env.PEER_PLATFORM,
    }
  : undefined;
const result = await probeCompatibility(input);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (process.argv.length > 2 && !live) process.exitCode = 2;
