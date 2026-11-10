/**
 * The Developer parameters editor's reading of a draft (xochi-widget#36): it
 * must accept what the frame accepts, in every shape an integrator pastes, and
 * know every parameter the frame reads.
 */

import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY, type SelectableChainId } from "@xochi/client";
import { parseCapabilities } from "@xochi/signer";
import { FALLBACK_CAPABILITIES } from "../../lib/capabilities.js";
import { FRAME_FIELDS, embedOffer } from "../trade/embedParams.js";
import { EMBED_PARAM } from "@xochi/widget-lib";
import { FIELD_BY_KEY, readParamsDraft } from "./paramsDraft.js";
import { findTokenBySymbol } from "../trade/config.js";

const CHAIN_IDS = [1, 8453, 42161] as const satisfies readonly SelectableChainId[];
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
const caps = parseCapabilities({
  cross_chain_only: true,
  chains: CHAIN_IDS.map((chain_id) => ({
    chain_id,
    chain_name: String(chain_id),
    vm_type: "evm",
    ...(chain_id === 1 ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY } : {}),
  })),
  tokens: [capabilityToken("USDC"), capabilityToken("USDT")],
  conversion_pairs: [{ from: "USDT", to: "USDC" }],
  routes: CHAIN_IDS.flatMap((fromChainId) =>
    CHAIN_IDS.flatMap((toChainId) =>
      fromChainId === toChainId
        ? []
        : [
            { from: "USDC", to: "USDC" },
            { from: "USDT", to: "USDC" },
          ].map(({ from, to }) => ({
            origin: { chain_id: fromChainId, token: from },
            destination: { kind: "chain", chain_id: toChainId, token: to },
            privacy_modes: toChainId === 1 ? ["public", "stealth"] : ["public"],
          })),
    ),
  ),
  stealth_chains: [1],
});
if (caps === null) throw new Error("test matrix did not parse");
const LIVE = embedOffer(caps, true);
const FALLBACK = embedOffer(FALLBACK_CAPABILITIES, false);

/** The keys the frame resolves. */
const FRAME_KEYS = FRAME_FIELDS.map((field) => EMBED_PARAM[field]);

describe("readParamsDraft", () => {
  it("recognises every parameter the frame reads", () => {
    expect(Object.keys(FIELD_BY_KEY).sort()).toEqual([...FRAME_KEYS].sort());
    for (const key of FRAME_KEYS) {
      const { problems } = readParamsDraft(`${key}=`, LIVE);
      expect(problems, key).toHaveLength(1);
      expect(problems[0], key).toMatch(new RegExp(`^${key} needs a value`));
    }
  });

  it("gives examples that apply when typed as they are shown", () => {
    for (const offer of [LIVE, FALLBACK]) {
      for (const key of FRAME_KEYS) {
        // Take the example out of the message a user actually reads.
        const [message] = readParamsDraft(`${key}=`, offer).problems;
        const example = /, like (\S+)\.$/.exec(message)?.[1];
        expect(example, message).toMatch(new RegExp(`^${key}=`));
        expect(readParamsDraft(example ?? "", offer).problems, example).toEqual([]);
      }
    }
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "reads the inherited object key %s as an unknown parameter",
    (key) => {
      expect(readParamsDraft(`${key}=1`, LIVE).problems).toEqual([
        `Unknown parameter "${key}". The widget reads ${FRAME_KEYS.join(", ")}.`,
      ]);
    },
  );

  it.each([
    ["a bare /embed URL", "https://widget.example/embed", {}],
    ["a bare path", "/embed", {}],
    ["an empty draft", "  \n ", {}],
    ["a URL with a fragment", "https://widget.example/embed?toChain=1#top", { toChainId: 1 }],
    ["a line with a fragment", "toChain=1#note", { toChainId: 1 }],
    ["percent-encoding", "toChain=1\nsell=US%44T", { toChainId: 1, sellSymbol: "USDT" }],
    ["a query string", "?toChain=1&amount=250", { toChainId: 1, amount: "250" }],
    ["a path with a query", "/embed?toChain=1&sell=usdt", { toChainId: 1, sellSymbol: "usdt" }],
  ])("reads %s as the frame would", (_name, text, params) => {
    expect(readParamsDraft(text, LIVE)).toEqual({ params, problems: [] });
  });

  it("names the frame's reason for a value it would ignore", () => {
    const { problems } = readParamsDraft("toChain=1\nsell=DOGE\nsettlement=stealth", LIVE);
    expect(problems).toEqual(["The widget would ignore sell=DOGE: DOGE can't be sent on Base."]);
  });
});
