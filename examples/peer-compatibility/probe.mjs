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
  let extensionState;
  try {
    extensionState = extensionAvailability(await extension.getState());
  } catch {
    extensionState = { state: "availability_unknown", reason_code: "extension_probe_failed" };
  }
  const results = (onramp, offramp) => [
    report("onramp", onramp, checks),
    report("offramp", offramp, checks),
  ];
  // Input, corridor, Base USDC/V4 and oracle are prerequisites of both directions. The
  // extension state and the Buyer TEE quote are onramp-only and never reported as offramp.
  const bothDirections = (availability) => results(availability, availability);
  if (input === undefined) {
    return results(extensionState, {
      state: "availability_unknown",
      reason_code: "live_capability_not_checked",
    });
  }
  if (!validInput(input)) {
    return bothDirections({ state: "availability_unknown", reason_code: "invalid_probe_input" });
  }
  let addresses;
  try {
    addresses = getContracts(8453, input.environment).addresses;
    const catalog = getPaymentMethodsCatalog(8453, input.environment);
    const corridor = Object.hasOwn(catalog, input.platform) ? catalog[input.platform] : undefined;
    if (
      !corridor?.currencies?.includes(resolveFiatCurrencyBytes32(input.currency)) ||
      !getSpreadOracleConfig(input.currency)
    ) {
      return bothDirections({ state: "not_supported", reason_code: "corridor_not_in_sdk_catalog" });
    }
    if (
      addresses.usdc?.toLowerCase() !== BASE_USDC ||
      !addresses.orchestratorV4 ||
      /^0x0{40}$/i.test(addresses.orchestratorV4)
    ) {
      return bothDirections({ state: "not_supported", reason_code: "base_usdc_v4_not_configured" });
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
      return bothDirections({
        state: "temporarily_unavailable",
        reason_code: "v4_or_oracle_unavailable",
      });
    }
  } catch {
    // Provider errors can contain payee details, request bodies or bearer URLs.
    // Return a bounded error code, never the provider error or its cause.
    return bothDirections({
      state: "temporarily_unavailable",
      reason_code: "peer_live_probe_failed",
    });
  }
  const offramp = {
    state: "setup_required",
    requirement_codes: ["maker_payee_registration", "maker_live_eligibility"],
  };
  let observation;
  try {
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
    observation = quoteObservation(response, input, addresses.orchestratorV4, Date.now());
  } catch {
    // Same bounded-code rule as above; a failed Buyer TEE quote says nothing about offramp.
    return results(
      { state: "temporarily_unavailable", reason_code: "peer_quote_request_failed" },
      offramp,
    );
  }
  checks.live_buyer_tee_quote_observed = observation === "fresh_quote_observed";
  if (observation !== "fresh_quote_observed") {
    return results(
      { state: "availability_unknown", reason_code: `peer_quote_${observation}` },
      offramp,
    );
  }
  return results(
    extensionState.state === "setup_required"
      ? extensionState
      : { state: "availability_unknown", reason_code: "v4_readiness_and_corridor_bounds_unproven" },
    offramp,
  );
}
