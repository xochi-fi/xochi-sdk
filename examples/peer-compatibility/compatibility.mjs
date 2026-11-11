const ADDRESS = /^0x[0-9a-fA-F]{40}(?![\s\S])/;
const POSITIVE_ATOMIC = /^[1-9][0-9]*(?![\s\S])/;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export function validInput(input) {
  return (
    input !== null &&
    typeof input === "object" &&
    ["production", "preproduction", "staging"].includes(input.environment) &&
    typeof input.address === "string" &&
    ADDRESS.test(input.address) &&
    !/^0x0{40}$/i.test(input.address) &&
    typeof input.amount === "string" &&
    input.amount.length <= 78 &&
    POSITIVE_ATOMIC.test(input.amount) &&
    BigInt(input.amount) <= (1n << 256n) - 1n &&
    typeof input.currency === "string" &&
    /^[A-Z]{3}(?![\s\S])/.test(input.currency) &&
    typeof input.platform === "string" &&
    /^[a-z][a-z0-9_]{0,31}(?![\s\S])/.test(input.platform)
  );
}

export function extensionAvailability(state) {
  switch (state) {
    case "needs_install":
      return { state: "setup_required", requirement_codes: ["peer_extension_install"] };
    case "needs_connection":
      return { state: "setup_required", requirement_codes: ["peer_extension_connection"] };
    case "ready":
      return { state: "availability_unknown", reason_code: "live_capability_not_checked" };
    default:
      return { state: "availability_unknown", reason_code: "unknown_extension_state" };
  }
}

export function quoteObservation(response, input, orchestrator, now) {
  const body = response?.responseObject;
  if (response?.success !== true || !Array.isArray(body?.quotes)) return "invalid_response";
  if (
    body.token?.chainId !== 8453 ||
    body.token?.decimals !== 6 ||
    typeof body.token?.token !== "string" ||
    body.token.token.toLowerCase() !== BASE_USDC ||
    body.fiat?.currencyCode !== input.currency ||
    typeof body.orchestratorAddress !== "string" ||
    body.orchestratorAddress.toLowerCase() !== orchestrator.toLowerCase()
  )
    return "invalid_response";
  const expiry = typeof body.quoteExpiresAt === "string" ? Date.parse(body.quoteExpiresAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now) return "expired_or_undated";
  if (body.quotes.length === 0) return "no_liquidity";
  const matched = body.quotes.some(
    (quote) =>
      quote !== null &&
      typeof quote === "object" &&
      quote.tokenAmount === input.amount &&
      quote.intent?.processorName === input.platform &&
      quote.intent?.fiatCurrencyCode === input.currency &&
      quote.intent?.chainId === "8453" &&
      typeof quote.intent?.orchestratorAddress === "string" &&
      quote.intent.orchestratorAddress.toLowerCase() === orchestrator.toLowerCase(),
  );
  return matched ? "fresh_quote_observed" : "invalid_response";
}

export function report(direction, availability, checks = {}) {
  return {
    contract_version: "ramp/1",
    provider_id: "peer",
    direction,
    availability,
    checks,
  };
}
