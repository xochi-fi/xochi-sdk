/**
 * What the "What users see" panel prices (xochi-fi/xochi-widget#40): the
 * frame's visitor preview, withheld exactly where the frame withholds a quote.
 */

import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY, TRON_CHAIN_ID, type SelectableChainId } from "@xochi/client";
import { parseCapabilities, type SolverCapabilities } from "@xochi/signer";
import type { EmbedParams } from "@xochi/widget-lib";
import { embedOffer, resolveEmbedDefaults } from "../trade/embedParams.js";
import { previewPlan, previewQuoteRequest, type PreviewInputs } from "./previewQuote.js";
import { findTokenBySymbol } from "../trade/config.js";

const CHAIN_IDS = [1, 8453, 42161, 100, TRON_CHAIN_ID] as const;
const capabilityToken = (symbol: string) => {
  const deployments = CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`${symbol} has no configured deployment`);
  return {
    symbol,
    roles: ["origin", "destination"],
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};
const deploymentExists = (chainId: SelectableChainId, symbol: string): boolean =>
  findTokenBySymbol(chainId, symbol) !== undefined;

function matrix(
  bounds: { min: number; max: number },
  privacyModes: (
    fromChainId: SelectableChainId,
    toChainId: SelectableChainId,
    from: string,
    to: string,
  ) => readonly ("public" | "stealth")[] = (_fromChainId, toChainId) =>
    toChainId === 1 ? ["public", "stealth"] : ["public"],
): SolverCapabilities {
  const routePairs = [
    { from: "USDC", to: "USDC" },
    { from: "USDT", to: "USDC" },
  ];
  const parsed = parseCapabilities({
    cross_chain_only: true,
    chains: CHAIN_IDS.map((chain_id) => ({
      chain_id,
      chain_name: String(chain_id),
      vm_type: chain_id === TRON_CHAIN_ID ? "tvm" : "evm",
      ...(chain_id === 1 ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : {}),
    })),
    tokens: [capabilityToken("USDC"), capabilityToken("USDT"), capabilityToken("EURe")],
    conversion_pairs: [{ from: "USDT", to: "USDC" }],
    routes: CHAIN_IDS.flatMap((fromChainId) =>
      CHAIN_IDS.flatMap((toChainId) =>
        fromChainId === toChainId
          ? []
          : routePairs
              .filter(
                ({ from, to }) =>
                  deploymentExists(fromChainId, from) && deploymentExists(toChainId, to),
              )
              .map(({ from, to }) => ({
                origin: { chain_id: fromChainId, token: from },
                destination: { kind: "chain", chain_id: toChainId, token: to },
                privacy_modes: privacyModes(fromChainId, toChainId, from, to),
              })),
      ),
    ),
    stealth_chains: [1],
    order_bounds_usd: bounds,
  });
  if (parsed === null) throw new Error("test matrix did not parse");
  return parsed;
}

const capabilities = matrix({ min: 1, max: 10000 });
const offer = embedOffer(capabilities, true);
const config = (params: EmbedParams) =>
  resolveEmbedDefaults({ settlement: "public", ...params }, offer);
const INPUTS: PreviewInputs = {
  capabilities,
  capabilityState: "live",
  prices: { USDC: 1, USDT: 1, EURe: 1.08 },
  pricesLive: true,
};

describe("previewPlan", () => {
  it("prices a $100 reference order in a dollar stablecoin when no amount is set", () => {
    expect(previewPlan(config({}), INPUTS)).toMatchObject({
      kind: "quote",
      amount: { text: "100", baseUnits: "100000000", referenceUsd: 100 },
    });
  });

  it("prices the configured amount, not the reference, when one is set", () => {
    expect(previewPlan(config({ amount: "250.5" }), INPUTS)).toMatchObject({
      kind: "quote",
      amount: { text: "250.5", baseUnits: "250500000", referenceUsd: null },
    });
  });

  it("sizes the reference order inside the solver's bounds", () => {
    const narrow = { ...INPUTS, capabilities: matrix({ min: 250, max: 10000 }) };
    expect(previewPlan(config({}), narrow)).toMatchObject({
      kind: "quote",
      amount: { text: "250", referenceUsd: 250 },
    });
  });

  it("does not price a token that is absent from the exact live route", () => {
    // Gnosis is build-flagged off in tests, so changing display metadata cannot
    // create an endpoint even when a live price happens to exist.
    const base = config({});
    const eure = { ...base, fromToken: { ...base.fromToken, symbol: "EURe", decimals: 18 } };
    expect(previewPlan(eure, INPUTS).kind).toBe("unconfirmed");
    expect(previewPlan(eure, { ...INPUTS, pricesLive: false }).kind).toBe("unconfirmed");
  });

  it("keys every Public request field and withholds private-mode previews", () => {
    const keys = [{}, { toChainId: 1 }, { amount: "5" }].map((params) => {
      const plan = previewPlan(config(params), INPUTS);
      return plan.kind === "quote" ? plan.key : null;
    });
    expect(new Set(keys).size).toBe(3);
    expect(previewPlan(config({ toChainId: 1, settlement: "stealth" }), INPUTS)).toMatchObject({
      kind: "unconfirmed",
      reason: "private",
    });
    expect(previewPlan(config({ toChainId: 1 }), INPUTS).kind).toBe("quote");
  });

  it("withholds a quote below the solver's minimum, in the frame's words", () => {
    expect(previewPlan(config({ amount: "0.5" }), INPUTS)).toMatchObject({
      kind: "out_of_bounds",
      notice: "Minimum order is $1.",
    });
  });

  it("prices an amount above the advertised maximum, as the frame quotes it", () => {
    expect(previewPlan(config({ amount: "20000" }), INPUTS).kind).toBe("quote");
  });

  it("asks nothing for a non-EVM destination, which waits on the recipient", () => {
    expect(previewPlan(config({ toChainId: TRON_CHAIN_ID }), INPUTS).kind).toBe("needs_recipient");
  });

  it("requires a live exact route with Public privacy before quoting", () => {
    const selected = config({ toChainId: 1 });
    for (const capabilityState of ["stale", "fallback", "failed"] as const) {
      expect(previewPlan(selected, { ...INPUTS, capabilityState })).toMatchObject({
        kind: "unconfirmed",
        reason: capabilityState,
      });
    }

    const stealthOnly = matrix({ min: 1, max: 10000 }, (fromChainId, toChainId, from, to) =>
      fromChainId === 8453 && toChainId === 1 && from === "USDC" && to === "USDC"
        ? ["stealth"]
        : toChainId === 1
          ? ["public", "stealth"]
          : ["public"],
    );
    expect(previewPlan(selected, { ...INPUTS, capabilities: stealthOnly })).toMatchObject({
      kind: "unconfirmed",
      reason: "route",
    });
    expect(previewPlan(selected, INPUTS).kind).toBe("quote");
  });
});

describe("previewQuoteRequest", () => {
  it("builds the walletless, Standard-tier, Public preview the machine would send", () => {
    const selected = config({ toChainId: 1 });
    const plan = previewPlan(selected, INPUTS);
    if (plan.kind !== "quote") throw new Error(`expected a quote plan, got ${plan.kind}`);
    const now = Date.UTC(2026, 9, 10);
    const built = previewQuoteRequest(selected, plan.amount, now);
    if (!built.ok) throw new Error(built.error);
    expect(built.request).toMatchObject({
      preview: true,
      wallet: undefined,
      allocationKey: undefined,
      trustScore: 0,
      settlementPreference: "public",
      stealthMetaAddress: undefined,
      fromAmount: "100000000",
      deadline: now / 1000 + 3600,
    });
  });
});
