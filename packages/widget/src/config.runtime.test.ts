import { expect, it, vi } from "vitest";
import { parseCapabilities, TOKENS } from "@xochi/client";

it.each([
  { name: "missing browser transport", arcRpcUrl: undefined, offered: false },
  { name: "configured browser transport", arcRpcUrl: "https://arc.example.test", offered: true },
])("resolves Arc after model-first configuration: $name", async ({ arcRpcUrl, offered }) => {
  vi.resetModules();
  // Model consumers import this entry before configuring the lazy rendered surfaces.
  const model = await import("./configurator-model.js");
  const { configureWidget } = await import("./config.js");
  configureWidget({
    apiUrl: "https://api.example.test",
    arcLive: true,
    arcRpcUrl,
    solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
    depositAttestationSigner: "",
  });
  const address = (chainId: 5042 | 8453) => {
    const token = TOKENS[chainId].find((candidate) => candidate.symbol === "USDC");
    if (!token) throw new Error("USDC fixture is missing");
    return token.address;
  };
  const caps = parseCapabilities({
    chains: [5042, 8453].map((chain_id) => ({ chain_id, vm_type: "evm" })),
    tokens: [
      {
        symbol: "USDC",
        decimals: 6,
        roles: ["origin", "destination"],
        addresses: { 5042: address(5042), 8453: address(8453) },
      },
    ],
    routes: [
      {
        origin: { chain_id: 5042, token: "USDC" },
        destination: { kind: "chain", chain_id: 8453, token: "USDC" },
        privacy_modes: ["public"],
      },
    ],
  });
  if (!caps) throw new Error("Capability fixture is invalid");
  expect(model.embedOffer(caps, "live").sourceChainIds.includes(5042)).toBe(offered);
});
