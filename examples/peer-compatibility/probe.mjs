import {
  apiGetQuote,
  createPeerExtensionSdk,
  getContracts,
  getPaymentMethodsCatalog,
  getSpreadOracleConfig,
  resolveFiatCurrencyBytes32,
  validateOracleFeedsOnChain,
  Zkp2pClient,
} from "@zkp2p/sdk";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  BASE_USDC,
  extensionAvailability,
  quoteObservation,
  report,
  validInput,
} from "./compatibility.mjs";

const CURATOR = {
  production: "https://api.zkp2p.xyz",
  preproduction: "https://api-preprod.zkp2p.xyz",
  staging: "https://api-staging.zkp2p.xyz",
};

export async function probeCompatibility(input) {
  const extension = createPeerExtensionSdk();
  const checks = {
    buyer_tee_api_surface_present:
      typeof extension.authenticate === "function" &&
      typeof extension.onMetadataMessage === "function",
    maker_api_surface_present: [
      "registerPayeeDetails",
      "prepareCreateDeposit",
      "createDeposit",
    ].every((name) => typeof Zkp2pClient.prototype[name] === "function"),
  };
  let onramp;
  try {
    onramp = extensionAvailability(await extension.getState());
  } catch {
    onramp = { state: "availability_unknown", reason_code: "extension_probe_failed" };
  }
  const results = (offramp) => [
    report("onramp", onramp, checks),
    report("offramp", offramp, checks),
  ];
  if (input === undefined) {
    return results({ state: "availability_unknown", reason_code: "live_capability_not_checked" });
  }
  if (!validInput(input)) {
    onramp = { state: "availability_unknown", reason_code: "invalid_probe_input" };
    return results(onramp);
  }
  try {
    const { addresses } = getContracts(8453, input.environment);
    const catalog = getPaymentMethodsCatalog(8453, input.environment);
    const corridor = catalog[input.platform];
    if (
      !corridor?.currencies?.includes(resolveFiatCurrencyBytes32(input.currency)) ||
      !getSpreadOracleConfig(input.currency)
    ) {
      onramp = { state: "not_supported", reason_code: "corridor_not_in_sdk_catalog" };
      return results(onramp);
    }
    if (
      addresses.usdc?.toLowerCase() !== BASE_USDC ||
      !addresses.orchestratorV4 ||
      /^0x0{40}$/i.test(addresses.orchestratorV4)
    ) {
      onramp = { state: "not_supported", reason_code: "base_usdc_v4_not_configured" };
      return results(onramp);
    }
    const publicClient = createPublicClient({
      chain: base,
      transport: http("https://mainnet.base.org", { timeout: 15000, retryCount: 0 }),
    });
    const [chainId, code, currencies] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBytecode({ address: addresses.orchestratorV4 }),
      validateOracleFeedsOnChain(publicClient),
    ]);
    checks.live_v4_code_present = chainId === 8453 && typeof code === "string" && code !== "0x";
    checks.live_oracle_readable = currencies.has(input.currency);
    if (!checks.live_v4_code_present || !checks.live_oracle_readable) {
      onramp = { state: "temporarily_unavailable", reason_code: "v4_or_oracle_unavailable" };
      return results(onramp);
    }
    const response = await apiGetQuote(
      {
        paymentPlatforms: [input.platform],
        fiatCurrency: input.currency,
        user: input.address,
        recipient: input.address,
        destinationChainId: 8453,
        destinationToken: addresses.usdc,
        escrowAddresses: [addresses.escrowV2],
        amount: input.amount,
        isExactFiat: false,
        quotesToReturn: 1,
        includeNearbyQuotes: false,
        mode: "eligible",
        quotePreference: "EXCLUSIVE_BUYER_TEE",
      },
      CURATOR[input.environment],
      15000,
    );
    const observation = quoteObservation(response, input, addresses.orchestratorV4, Date.now());
    checks.live_buyer_tee_quote_observed = observation === "fresh_quote_observed";
    if (observation !== "fresh_quote_observed") {
      onramp = { state: "availability_unknown", reason_code: `peer_quote_${observation}` };
    } else if (onramp.state !== "setup_required") {
      onramp = {
        state: "availability_unknown",
        reason_code: "v4_readiness_and_corridor_bounds_unproven",
      };
    }
    return results({
      state: "setup_required",
      requirement_codes: ["maker_payee_registration", "maker_live_eligibility"],
    });
  } catch {
    // Provider errors can contain payee details, request bodies or bearer URLs.
    // Return a bounded error code, never the provider error or its cause.
    onramp = { state: "temporarily_unavailable", reason_code: "peer_live_probe_failed" };
    return results(onramp);
  }
}
