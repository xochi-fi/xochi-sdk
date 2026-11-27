import { describe, expect, it, vi } from "vitest";
import { CANTON_COIN_MAINNET, parseCapabilities, TOKENS } from "@xochi/client";
import type { WidgetSettings } from "./config.js";

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

describe("Canton destination is a per-deploy setting", () => {
  const CANTON = 253340876;
  const ESCROW = "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb";
  const base = {
    apiUrl: "https://api.example.test",
    solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
    depositAttestationSigner: "",
    escrows: { 8453: ESCROW },
  };
  // Riddler's shape: Canton Coin destination-only, no pull method.
  const caps = (withCanton: boolean) => {
    const usdc = TOKENS[8453].find((token) => token.symbol === "USDC");
    if (!usdc) throw new Error("USDC fixture is missing");
    const parsed = parseCapabilities({
      chains: [
        { chain_id: 8453, chain_name: "Base", vm_type: "evm" },
        ...(withCanton
          ? [{ chain_id: CANTON, chain_name: "Canton", vm_type: "cvm", roles: ["destination"] }]
          : []),
      ],
      tokens: [
        {
          symbol: "USDC",
          decimals: 6,
          pull_method: "erc3009",
          gasless_origin: true,
          roles: ["origin"],
          addresses: { 8453: usdc.address },
        },
        ...(withCanton
          ? [
              {
                symbol: "CC",
                decimals: 10,
                pull_method: null,
                pull_methods: [],
                gasless_origin: false,
                roles: ["destination"],
                addresses: { [CANTON]: CANTON_COIN_MAINNET },
              },
            ]
          : []),
      ],
      routes: withCanton
        ? [
            {
              origin: { chain_id: 8453, token: "USDC" },
              destination: { kind: "chain", chain_id: CANTON, token: "CC" },
              privacy_modes: ["public"],
            },
          ]
        : [],
    });
    if (!parsed) throw new Error("Capability fixture is invalid");
    return parsed;
  };

  const configure = async (settings: Partial<WidgetSettings>) => {
    vi.resetModules();
    const model = await import("./configurator-model.js");
    const config = await import("./config.js");
    config.configureWidget({ ...base, ...settings });
    return { model, config };
  };

  it.each([
    { name: "unset", cantonLive: undefined },
    { name: "false", cantonLive: false },
  ])("hides Canton and withholds the escrow pins when $name", async ({ cantonLive }) => {
    const { model, config } = await configure({ cantonLive });
    const offer = model.embedOffer(caps(true), "live");
    expect(offer.destinationChainIds).not.toContain(CANTON);
    expect(config.machineEscrowPins()).toBeUndefined();
    const { isOfferedChainId } = await import("./pages/trade/canton.js");
    expect(isOfferedChainId(CANTON)).toBe(false);
  });

  it("refuses a non-boolean truthy value", async () => {
    const { model, config } = await configure({ cantonLive: "true" as unknown as boolean });
    expect(model.embedOffer(caps(true), "live").destinationChainIds).not.toContain(CANTON);
    expect(config.machineEscrowPins()).toBeUndefined();
  });

  it("offers Canton when on, only once a route and token exist", async () => {
    const { model, config } = await configure({ cantonLive: true });
    const offer = model.embedOffer(caps(true), "live");
    expect(offer.destinationChainIds).toContain(CANTON);
    expect(offer.sourceChainIds).not.toContain(CANTON);
    // The origin token keeps its pull method beside a null-pull destination token.
    expect(offer.sourceChainIds).toContain(8453);
    expect(model.embedOffer(caps(false), "live").destinationChainIds).not.toContain(CANTON);
    expect(config.machineEscrowPins()).toEqual({ 8453: ESCROW });
  });

  it("accepts an all-lowercase pin", async () => {
    const { config } = await configure({
      cantonLive: true,
      escrows: { 8453: ESCROW.toLowerCase() },
    });
    expect(config.machineEscrowPins()).toEqual({ 8453: ESCROW.toLowerCase() });
  });

  it("on without an escrows pin, passes no escrow pin", async () => {
    const { config } = await configure({ cantonLive: true, escrows: undefined });
    expect(config.machineEscrowPins()).toBeUndefined();
  });

  it.each([
    { 8453: "" },
    { 8453: "0x4438" },
    { 8453: `0x${"0".repeat(40)}` },
    { base: ESCROW },
    { 8453: 42 },
    { 8453: "0x4438A8b3EE5AAf58343B18629040a4BCB8b0feCb" },
  ] as unknown as NonNullable<WidgetSettings["escrows"]>[])(
    "rejects a malformed escrow pin: %o",
    async (escrows) => {
      vi.resetModules();
      const config = await import("./config.js");
      expect(() => config.configureWidget({ ...base, cantonLive: true, escrows })).toThrow(
        "Invalid escrow pin",
      );
    },
  );
});

it.each([
  { development: false, pilot: true, adapter: true, enabled: false },
  { development: true, pilot: false, adapter: true, enabled: false },
  { development: true, pilot: true, adapter: false, enabled: false },
  { development: true, pilot: true, adapter: true, enabled: true },
])("gates the Robinhood sponsorship pilot %o", async ({ development, pilot, adapter, enabled }) => {
  vi.resetModules();
  const config = await import("./config.js");
  config.configureWidget({
    apiUrl: "http://127.0.0.1:8789",
    development,
    originSponsorshipTestnet: pilot,
    ...(adapter && { originSponsorship: { resolve: () => null } }),
    solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
    depositAttestationSigner: "",
  });
  const { chainEnabledForRole } = await import("./pages/trade/config.js");
  const { FALLBACK_CAPABILITIES } = await import("./lib/capabilities.js");
  const { embedOffer } = await import("./configurator-model.js");
  const matrix = parseCapabilities({
    chains: [46630, 421614].map((chain_id) => ({ chain_id, vm_type: "evm" })),
    tokens: [
      {
        symbol: "USDG",
        decimals: 6,
        roles: ["origin", "destination"],
        addresses: { 46630: TOKENS[46630][0].address, 421614: TOKENS[421614][0].address },
      },
    ],
    routes: [
      {
        origin: { chain_id: 46630, token: "USDG" },
        destination: { kind: "chain", chain_id: 421614, token: "USDG" },
        privacy_modes: ["public"],
      },
    ],
  });
  if (!matrix) throw new Error("Pilot capabilities are invalid");
  expect(embedOffer(matrix, "live").sourceChainIds.includes(46630)).toBe(enabled);
  expect(embedOffer(matrix, "live").destinationChainIds.includes(421614)).toBe(enabled);
  expect(chainEnabledForRole(46630, "origin")).toBe(enabled);
  expect(chainEnabledForRole(421614, "destination")).toBe(enabled);
  expect(chainEnabledForRole(421614, "origin")).toBe(false);
  expect(chainEnabledForRole(46630, "destination")).toBe(false);
  expect(
    FALLBACK_CAPABILITIES.chains.some(({ chainId }) => chainId === 46630 || chainId === 421614),
  ).toBe(false);
});
