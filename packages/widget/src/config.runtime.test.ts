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

it.each([undefined, "production", "preproduction", "staging"] as const)(
  "selects Peer environment only from runtime settings: %s",
  async (peerEnvironment) => {
    vi.resetModules();
    const config = await import("./config.js");
    expect(config.PEER_ENVIRONMENT).toBe("production");
    config.configureWidget({
      apiUrl: "https://api.example.test",
      peerEnvironment,
      solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
      depositAttestationSigner: "",
    });
    expect(config.PEER_ENVIRONMENT).toBe(peerEnvironment ?? "production");
    const { peerConfiguration } = await import("./ramp/peer/discovery.js");
    expect(peerConfiguration()).toEqual(
      peerConfiguration({ environment: peerEnvironment ?? "production" }),
    );
  },
);

it("keeps the Peer referral code and both canary caps unset unless configured", async () => {
  vi.resetModules();
  const config = await import("./config.js");
  const base = {
    apiUrl: "https://api.example.test",
    solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
    depositAttestationSigner: "",
  };
  config.configureWidget(base);
  expect(config.PEER_REFERRAL_CODE).toBeUndefined();
  expect(config.OFFRAMP_CANARY_CAP_ATOMIC).toBeUndefined();
  expect(config.ONRAMP_CANARY_CAP_ATOMIC).toBeUndefined();

  vi.resetModules();
  const set = await import("./config.js");
  set.configureWidget({
    ...base,
    peerReferralCode: "ABC123",
    offrampCanaryCapAtomic: "5000000",
    onrampCanaryCapAtomic: "7000000",
  });
  expect(set.PEER_REFERRAL_CODE).toBe("ABC123");
  expect(set.OFFRAMP_CANARY_CAP_ATOMIC).toBe("5000000");
  expect(set.ONRAMP_CANARY_CAP_ATOMIC).toBe("7000000");

  for (const bad of [
    { peerReferralCode: "abc" },
    { peerReferralCode: "ABC-12" },
    { offrampCanaryCapAtomic: "5.0" },
    { offrampCanaryCapAtomic: "0" },
    { onrampCanaryCapAtomic: "1e6" },
    { onrampCanaryCapAtomic: "0" },
  ]) {
    vi.resetModules();
    const fresh = await import("./config.js");
    expect(() => fresh.configureWidget({ ...base, ...bad })).toThrow();
  }
});
