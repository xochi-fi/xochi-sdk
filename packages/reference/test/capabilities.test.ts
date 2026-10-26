/**
 * Capability-matrix parsing (#93).
 *
 * The fixture below mirrors the shape of Riddler's
 * `Xochi.Config.capability_matrix/0` -- the producer -- rather than anything
 * @xochi/signer generates. It is a read path with no signature over it, so unlike the
 * deposit-attestation vectors these bytes are not a byte-equality contract;
 * what matters is that the parser survives what the server actually sends and
 * never *invents* a value it did not. The multi-chain stealth fields
 * (`stealth_chains`, `chains[].stealth_factory_address`, the deprecated nullable
 * top-level factory) and `execute_ownership` follow the served `CapabilityMatrix`
 * as vendored by the 2026-10-26 wire refresh (Riddler #1336, #1346).
 *
 * The negative cases carry most of the weight. A tolerant parser's failure mode
 * is silently defaulting a field it should have reported as absent, and absent
 * vs. zero is the difference between "no bound" and "every order is too large".
 */

import { describe, it, expect } from "vitest";

import {
  parseCapabilities,
  chainCapability,
  chainVmType,
  chainAddressFormat,
  originPullMethod,
  advertisedTokenAddress,
  depositAttestationVersionSkew,
  orderBoundsViolation,
  stealthNotionalFloor,
  narrowStealthChains,
  stealthFactoryFor,
  servedChainKeys,
  chainUnservedReason,
  DEPOSIT_ATTESTATION_VERSION,
} from "@xochi/signer";
import { CONFIG } from "../src/config";

const SOLVER = "0x1111111111111111111111111111111111111111";
const PERMIT2_PROXY = "0x2222222222222222222222222222222222222222";
const L1_FACTORY = "0x13E9ed32155810FDbd067D4522C492D6f68E5944";
const BASE_FACTORY = "0x3333333333333333333333333333333333333333";

/** Shaped after `capability_matrix/0`. snake_case, exactly as the server emits. */
function matrix(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    cross_chain_only: true,
    spec_version: "0.5.0",
    order_bounds_usd: { min: 1, max: 2000 },
    deposit_attestation_signer: "0xF99f53E8F301AB2cFEB40A21A11757a71DAC2bed",
    deposit_attestation_version: "xochi-deposit-attestation:v3",
    deposit_attestation_vectors_url: "https://example.invalid/vectors.json",
    deposit_attestation_vectors_sha256: "a".repeat(64),
    pull_recipients: {
      "8453": { erc3009: SOLVER, permit2: PERMIT2_PROXY },
      "10": { erc3009: SOLVER, permit2: SOLVER },
    },
    pull_deadline_buffer_seconds: 300,
    execute_ownership: true,
    stealth_chains: [1, 8453],
    // Deprecated: the factory on the FIRST stealth_chains entry, for older clients.
    stealth_factory_address: L1_FACTORY,
    chains: [
      {
        chain_id: 8453,
        chain_name: "Base",
        vm_type: "evm",
        address_format: "hex20",
        min_stealth_notional_usd: 5,
        stealth_factory_address: BASE_FACTORY,
      },
      {
        chain_id: 1,
        chain_name: "Ethereum",
        vm_type: "evm",
        address_format: "hex20",
        min_stealth_notional_usd: 120,
        stealth_factory_address: L1_FACTORY,
      },
      {
        chain_id: 728126428,
        chain_name: "Tron",
        vm_type: "tvm",
        address_format: "base58check",
        min_stealth_notional_usd: null,
        stealth_factory_address: null,
      },
    ],
    tokens: [
      {
        symbol: "USDC",
        decimals: 6,
        pull_method: "erc3009",
        gasless_origin: true,
        roles: ["origin", "destination"],
        addresses: {
          "8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "728126428": "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
        },
        pull_methods: {
          "8453": { method: "erc3009", gasless_origin: true },
          "728126428": { method: "deposit_address", gasless_origin: false },
        },
      },
      {
        symbol: "WETH",
        decimals: 18,
        pull_method: "permit2",
        gasless_origin: false,
        roles: ["origin"],
        addresses: { "8453": "0x4200000000000000000000000000000000000006" },
        pull_methods: { "8453": { method: "permit2", gasless_origin: false } },
      },
    ],
    // The producer's real shape (config.ex corridor/6), not an invented one --
    // the fixture header claims to mirror capability_matrix/0.
    corridors: [
      {
        src_chain_id: 8453,
        dst_chain_id: 10,
        src_token: "USDC",
        dst_token: "USDC",
        min_usd: 1,
        max_usd: 2000,
        mover: "cctp",
      },
    ],
    conversion_pairs: [],
    ...overrides,
  };
}

const caps = () => parseCapabilities(matrix())!;

describe("parseCapabilities", () => {
  it("parses the producer's shape", () => {
    const c = caps();
    expect(c.crossChainOnly).toBe(true);
    expect(c.specVersion).toBe("0.5.0");
    expect(c.orderBoundsUsd).toEqual({ min: 1, max: 2000 });
    expect(c.pullDeadlineBufferSeconds).toBe(300);
    expect(c.chains).toHaveLength(3);
    expect(c.tokens).toHaveLength(2);
    expect(c.corridors).toHaveLength(1);
  });

  it("returns null only for a non-object body", () => {
    expect(parseCapabilities(null)).toBeNull();
    expect(parseCapabilities("nope")).toBeNull();
    expect(parseCapabilities([])).toBeNull();
  });

  it("parses an empty body to an empty matrix rather than failing", () => {
    // "The server told us nothing" and "the server is unreachable" must be the
    // same type, because a caller has to handle them identically.
    const c = parseCapabilities({})!;
    expect(c.chains).toEqual([]);
    expect(c.tokens).toEqual([]);
    expect(c.orderBoundsUsd).toEqual({ min: null, max: null });
    expect(c.depositAttestationSigner).toBeNull();
  });

  it("drops unknown keys without disturbing known ones", () => {
    // New solver fields must not break an older client -- the whole point of the
    // endpoint is new capabilities without a client release.
    const c = parseCapabilities(matrix({ some_future_field: { nested: true } }))!;
    expect(c.specVersion).toBe("0.5.0");
    expect(c.raw.some_future_field).toEqual({ nested: true });
  });

  it("keeps an absent bound absent instead of defaulting it to zero", () => {
    // A defaulted 0 max would reject every order; a defaulted 0 min would accept
    // dust. Absent means unknown, and unknown must not be enforced.
    const c = parseCapabilities(matrix({ order_bounds_usd: {} }))!;
    expect(c.orderBoundsUsd).toEqual({ min: null, max: null });
    expect(orderBoundsViolation(c, 1e9)).toBeNull();
  });

  it("rejects NaN and Infinity rather than carrying them into a comparison", () => {
    // NaN compares false against everything, so it would silently disable the
    // bound while looking like it was set.
    const c = parseCapabilities(
      matrix({ order_bounds_usd: { min: "not-a-number", max: "Infinity" } }),
    )!;
    expect(c.orderBoundsUsd).toEqual({ min: null, max: null });
  });

  it("drops a chain with no usable chain_id", () => {
    const c = parseCapabilities(matrix({ chains: [{ chain_name: "Nameless" }] }))!;
    expect(c.chains).toEqual([]);
  });

  it("treats an absent vm_type as evm", () => {
    // vm_type postdates the endpoint; every chain that predates it was EVM.
    // Note this is about an ADVERTISED chain that omits the field -- distinct
    // from a chain absent altogether, which the accessors report as null.
    const c = parseCapabilities(matrix({ chains: [{ chain_id: 8453 }] }))!;
    expect(c.chains[0]!.vmType).toBe("evm");
    expect(c.chains[0]!.addressFormat).toBe("hex20");
  });

  it("falls back to the VM's own address format, not hex20, when the server omits it", () => {
    // Mislabelling a Tron chain as hex20 invites a checksum helper onto a base58
    // address, which is the #826 failure mode.
    const c = parseCapabilities(matrix({ chains: [{ chain_id: 728126428, vm_type: "tvm" }] }))!;
    expect(c.chains[0]!.addressFormat).toBe("base58check");
  });

  it("ignores an unrecognised pull method rather than trusting it", () => {
    const c = parseCapabilities(
      matrix({
        tokens: [
          {
            symbol: "USDC",
            pull_method: "telepathy",
            pull_methods: { "8453": { method: "telepathy" } },
          },
        ],
      }),
    )!;
    expect(c.tokens[0]!.pullMethod).toBeNull();
    expect(c.tokens[0]!.pullMethods).toEqual({});
  });

  it("keeps base58 token addresses verbatim", () => {
    const c = caps();
    expect(advertisedTokenAddress(c, "USDC", 728126428)).toBe("TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8");
  });
});

describe("accessors", () => {
  // Spec 0.8.0 serves Canton as `vm_type: "cvm"`. An unrecognised vm_type must not read
  // as "evm" with format hex20: a party id one caller away from an EVM address helper.
  it("parses Canton as cvm / canton_party, never evm / hex20", () => {
    const c = parseCapabilities(
      matrix({ chains: [{ chain_id: 253340876, vm_type: "cvm", address_format: "canton_party" }] }),
    )!;
    expect(chainVmType(c, 253340876)).toBe("cvm");
    expect(chainAddressFormat(c, 253340876)).toBe("canton_party");
  });

  it("reads a chain whose served vm_type it does not recognise as unaddressable, not evm", () => {
    // Absent still means evm (above); PRESENT and unknown is a chain we cannot address.
    const c = parseCapabilities(
      matrix({
        chains: [
          { chain_id: 8453, vm_type: "evm" },
          { chain_id: 999999, vm_type: "zvm" },
        ],
      }),
    )!;
    expect(chainVmType(c, 999999)).toBeNull();
    expect(chainAddressFormat(c, 999999)).toBeNull();
    expect(chainVmType(c, 8453)).toBe("evm");
  });

  // A duplicated id is malformed, and an unknown-VM copy is still a copy: the row is kept
  // so the duplicate check sees it, else a stray evm row would stand alone and read hex20
  // for what the venue also advertises as something else.
  it("refuses a duplicated chain id even when one copy has an unknown vm_type", () => {
    const c = parseCapabilities(
      matrix({
        chains: [
          { chain_id: 728126428, vm_type: "evm" },
          { chain_id: 728126428, vm_type: "tvm2", address_format: "base58check" },
        ],
      }),
    )!;
    expect(chainVmType(c, 728126428)).toBeNull();
    expect(chainAddressFormat(c, 728126428)).toBeNull();
  });

  it("reads an advertised chain and answers null, not evm, for an unlisted one", () => {
    const c = caps();
    expect(chainCapability(c, 8453)?.chainName).toBe("Base");
    expect(chainCapability(c, 999)).toBeNull();
    expect(chainVmType(c, 728126428)).toBe("tvm");
    // null, not "evm": "not advertised" and "is EVM" are different facts, and
    // collapsing them is how a base58 address reaches an EVM address helper.
    expect(chainVmType(c, 999)).toBeNull();
    expect(chainAddressFormat(c, 728126428)).toBe("base58check");
    expect(chainAddressFormat(c, 999)).toBeNull();
  });

  it("prefers the per-chain pull method over the EVM representative", () => {
    // The bug this prevents: reading the token-level erc3009 on a Tron origin and
    // sending a client down a gasless path that chain does not have.
    const c = caps();
    expect(originPullMethod(c, "USDC", 8453)).toBe("erc3009");
    expect(originPullMethod(c, "USDC", 728126428)).toBe("deposit_address");
  });

  it("falls back to the token-level method for an advertised chain with no per-chain entry", () => {
    const c = parseCapabilities(
      matrix({
        chains: [
          ...matrix().chains,
          { chain_id: 10, chain_name: "OP", vm_type: "evm", address_format: "hex20" },
        ],
      }),
    )!;
    expect(originPullMethod(c, "USDC", 10)).toBe("erc3009");
    expect(originPullMethod(c, "NOPE", 8453)).toBeNull();
  });

  it("names no pull method or address for a chain it cannot address", () => {
    // The token-level method is an EVM representative: falling back to it would name
    // `erc3009` for an unadvertised chain, a duplicated one and an unknown VM alike.
    expect(originPullMethod(caps(), "USDC", 10)).toBeNull();
    for (const chains of [
      [
        { chain_id: 8453, vm_type: "evm" },
        { chain_id: 8453, vm_type: "tvm2" },
      ],
      [
        { chain_id: 8453, vm_type: "tvm" },
        { chain_id: 8453, vm_type: "evm" },
      ],
      [{ chain_id: 8453, vm_type: "evm2" }],
    ]) {
      const c = parseCapabilities(matrix({ chains }))!;
      expect(originPullMethod(c, "USDC", 8453)).toBeNull();
      expect(advertisedTokenAddress(c, "USDC", 8453)).toBeNull();
    }
  });

  it("matches token symbols case-insensitively", () => {
    expect(originPullMethod(caps(), "usdc", 8453)).toBe("erc3009");
  });

  it("reports the stealth notional floor, and null when unpriced", () => {
    const c = caps();
    expect(stealthNotionalFloor(c, 1)).toBe(120);
    expect(stealthNotionalFloor(c, 728126428)).toBeNull();
  });

  it("reports order-bounds violations on both sides", () => {
    const c = caps();
    expect(orderBoundsViolation(c, 500)).toBeNull();
    expect(orderBoundsViolation(c, 0.5)).toMatch(/below/);
    expect(orderBoundsViolation(c, 5000)).toMatch(/above/);
  });
});

describe("deposit attestation version skew (riddler-sdk#92)", () => {
  it("is silent when the server signs what this client verifies", () => {
    const c = parseCapabilities(
      matrix({ deposit_attestation_version: DEPOSIT_ATTESTATION_VERSION }),
    )!;
    expect(depositAttestationVersionSkew(c, DEPOSIT_ATTESTATION_VERSION)).toBeNull();
  });

  it("names the skew instead of leaving it to look like a wrong signer", () => {
    // The whole reason the field exists: a v2 client against a v3 solver fails
    // closed as "signer is not the pinned solver", which reads as a rotation.
    const c = parseCapabilities(
      matrix({ deposit_attestation_version: "xochi-deposit-attestation:v4" }),
    )!;
    const skew = depositAttestationVersionSkew(c, DEPOSIT_ATTESTATION_VERSION);
    expect(skew).toContain("v4");
    expect(skew).toContain(DEPOSIT_ATTESTATION_VERSION);
  });

  it("treats a server that does not publish the field as no skew", () => {
    // Absence must not become an error.
    const c = parseCapabilities(matrix({ deposit_attestation_version: undefined }))!;
    expect(c.depositAttestationVersion).toBeNull();
    expect(depositAttestationVersionSkew(c, DEPOSIT_ATTESTATION_VERSION)).toBeNull();
  });
});

describe("stealth chains and factories (Riddler #1336)", () => {
  it("parses the served stealth chain list and per-chain factories", () => {
    const c = caps();
    expect(c.stealthChains).toEqual([1, 8453]);
    expect(stealthFactoryFor(c, 1)).toBe(L1_FACTORY);
    expect(stealthFactoryFor(c, 8453)).toBe(BASE_FACTORY);
    // Served null on a chain outside stealth_chains, and unadvertised chains have none.
    expect(stealthFactoryFor(c, 728126428)).toBeNull();
    expect(stealthFactoryFor(c, 10)).toBeNull();
  });

  it("reads the per-chain factory, never the deprecated top-level one", () => {
    // A top-level factory that disagrees with the per-chain one loses...
    const disagree = parseCapabilities(
      matrix({ stealth_factory_address: "0x4444444444444444444444444444444444444444" }),
    )!;
    expect(stealthFactoryFor(disagree, 1)).toBe(L1_FACTORY);
    // ...and one with no per-chain field beside it is no fallback, even for the first
    // stealth chain it describes: the producer serves both together.
    const noPerChain = parseCapabilities(
      matrix({ chains: [{ chain_id: 1, chain_name: "Ethereum", vm_type: "evm" }] }),
    )!;
    expect(stealthFactoryFor(noPerChain, 1)).toBeNull();
  });

  it("names no factory for a chain outside stealth_chains, whatever its row says", () => {
    // The producer serves null there; an address contradicts the body it came in.
    const c = parseCapabilities(matrix({ stealth_chains: [1] }))!;
    expect(c.chains.find((x) => x.chainId === 8453)!.stealthFactoryAddress).toBe(BASE_FACTORY);
    expect(stealthFactoryFor(c, 8453)).toBeNull();
    expect(stealthFactoryFor(c, 1)).toBe(L1_FACTORY);
  });

  it("names no factory for a duplicated, unknown-VM or non-EVM chain", () => {
    for (const chains of [
      [
        { chain_id: 1, vm_type: "evm", stealth_factory_address: L1_FACTORY },
        { chain_id: 1, vm_type: "evm", stealth_factory_address: BASE_FACTORY },
      ],
      [{ chain_id: 1, vm_type: "evm2", stealth_factory_address: L1_FACTORY }],
      [{ chain_id: 1, vm_type: "tvm", stealth_factory_address: L1_FACTORY }],
    ]) {
      const c = parseCapabilities(matrix({ stealth_chains: [1], chains }))!;
      expect(stealthFactoryFor(c, 1)).toBeNull();
    }
  });

  it("reads an absent or non-list stealth_chains as unsaid, and names no factory", () => {
    for (const stealth_chains of [undefined, null, "1,8453", { "0": 1 }, 1]) {
      const c = parseCapabilities(matrix({ stealth_chains }))!;
      expect(c.stealthChains).toBeNull();
      expect(stealthFactoryFor(c, 1)).toBeNull();
      // Unsaid narrows nothing: the caller's own set stands.
      expect(narrowStealthChains(c, [1, 8453])).toEqual([1, 8453]);
    }
  });

  it("drops entries that are not canonical chain ids and collapses repeats", () => {
    const c = parseCapabilities(
      matrix({ stealth_chains: [1, "08453", -1, 0, 1.5, "0x2105", null, {}, 1, "8453"] }),
    )!;
    expect(c.stealthChains).toEqual([1, 8453]);
  });

  it("reads an empty list as stealth offered nowhere", () => {
    const c = parseCapabilities(matrix({ stealth_chains: [], stealth_factory_address: null }))!;
    expect(c.stealthChains).toEqual([]);
    expect(narrowStealthChains(c, [1, 8453])).toEqual([]);
    expect(stealthFactoryFor(c, 1)).toBeNull();
  });

  it("narrows the caller's stealth set and never widens it", () => {
    const c = parseCapabilities(matrix({ stealth_chains: [42161, 8453, 1] }))!;
    // Advertised 42161 is not pinned, so it is not added; pinned 10 is not served.
    expect(narrowStealthChains(c, [8453, 10, 1])).toEqual([8453, 1]);
  });
});

describe("execute ownership (Riddler #1346)", () => {
  it("is true only for the served literal true", () => {
    expect(caps().executeOwnership).toBe(true);
    for (const execute_ownership of [undefined, null, false, "true", 1, {}]) {
      expect(parseCapabilities(matrix({ execute_ownership }))!.executeOwnership).toBe(false);
    }
    expect(parseCapabilities({})!.executeOwnership).toBe(false);
  });
});

describe("hostile payloads", () => {
  it("refuses a leading-zero chain key rather than letting it shadow the real one", () => {
    // JS iterates integer-like keys first and string keys after, so "08453" is
    // written LAST and would deterministically win -- a server could shadow any
    // chain's token address and pull method with one padded key.
    const c = parseCapabilities(
      matrix({
        tokens: [
          {
            symbol: "USDC",
            addresses: { "8453": "0xreal", "08453": "0xevil" },
            pull_methods: {
              "8453": { method: "erc3009" },
              "08453": { method: "permit2" },
            },
          },
        ],
      }),
    )!;
    expect(advertisedTokenAddress(c, "USDC", 8453)).toBe("0xreal");
    expect(originPullMethod(c, "USDC", 8453)).toBe("erc3009");
  });

  it("does not let a duplicate chain entry shadow the real one", () => {
    const c = parseCapabilities(
      matrix({
        chains: [
          { chain_id: 728126428, vm_type: "evm" },
          { chain_id: 728126428, vm_type: "tvm" },
        ],
      }),
    )!;
    // Malformed, so refuse to answer rather than pick. Answering "evm" here is
    // the forbidden outcome: a base58 address routed through an EVM helper.
    expect(chainVmType(c, 728126428)).toBeNull();
  });

  it("does not let a duplicate token symbol shadow the real one", () => {
    const c = parseCapabilities(
      matrix({
        tokens: [
          { symbol: "usdc", addresses: { "8453": "0xevil" } },
          { symbol: "USDC", addresses: { "8453": "0xreal" } },
        ],
      }),
    )!;
    expect(advertisedTokenAddress(c, "USDC", 8453)).toBeNull();
  });

  it("rejects an address_format the producer cannot emit", () => {
    // A value that matches no AddressFormat branch falls back to the VM's own format,
    // so a server cannot label a TVM chain hex20 through an unchecked string.
    const c = parseCapabilities(
      matrix({
        chains: [{ chain_id: 728126428, vm_type: "tvm", address_format: "totally-bogus" }],
      }),
    )!;
    expect(c.chains[0]!.addressFormat).toBe("base58check");
  });

  it("refuses to call a TVM chain hex20 when the server says so", () => {
    const c = parseCapabilities(
      matrix({ chains: [{ chain_id: 728126428, vm_type: "tvm", address_format: "hex20" }] }),
    )!;
    // hex20 IS a valid format, so it parses -- but the vm_type is the fact that
    // matters and it is preserved for a caller to act on.
    expect(c.chains[0]!.vmType).toBe("tvm");
  });

  it("defaults crossChainOnly restrictively on absence", () => {
    // A blank body must not relax to "same-chain fills allowed".
    expect(parseCapabilities({})!.crossChainOnly).toBe(true);
    expect(parseCapabilities(matrix({ cross_chain_only: undefined }))!.crossChainOnly).toBe(true);
    expect(parseCapabilities(matrix({ cross_chain_only: false }))!.crossChainOnly).toBe(false);
  });

  it("drops a pull deadline buffer the producer could not emit", () => {
    // non_neg_integer() server-side, and the number a caller is most tempted to
    // substitute for a local ceiling.
    for (const bad of [-1, 0.5, 1e400]) {
      const c = parseCapabilities(matrix({ pull_deadline_buffer_seconds: bad }))!;
      expect(c.pullDeadlineBufferSeconds).toBeNull();
    }
    expect(
      parseCapabilities(matrix({ pull_deadline_buffer_seconds: 300 }))!.pullDeadlineBufferSeconds,
    ).toBe(300);
  });

  it("drops a negative order max instead of rejecting every order", () => {
    // Same failure the absent case was designed to avoid, reached by a hostile
    // value rather than a default.
    const c = parseCapabilities(matrix({ order_bounds_usd: { min: -5, max: -5 } }))!;
    expect(c.orderBoundsUsd).toEqual({ min: null, max: null });
    expect(orderBoundsViolation(c, 100)).toBeNull();
  });

  it("refuses to bounds-check a non-finite notional", () => {
    // NaN compares false against everything, so it would otherwise report "fits".
    expect(orderBoundsViolation(caps(), NaN)).toMatch(/not a finite number/);
  });

  it("rejects a signer or factory that is not an address", () => {
    const c = parseCapabilities(
      matrix({
        deposit_attestation_signer: "not-an-address",
        chains: [{ chain_id: 1, vm_type: "evm", stealth_factory_address: "javascript:alert(1)" }],
      }),
    )!;
    expect(c.depositAttestationSigner).toBeNull();
    expect(c.chains[0]!.stealthFactoryAddress).toBeNull();
    expect(stealthFactoryFor(c, 1)).toBeNull();
  });

  it("does not leak Object.prototype members to a loose JS caller", () => {
    expect(advertisedTokenAddress(caps(), "USDC", "constructor" as any)).toBeNull();
    expect(originPullMethod(caps(), "USDC", "__proto__" as any)).toBeNull();
  });

  it("leaves Object.prototype untouched for a __proto__-carrying body", () => {
    const body = JSON.parse(
      '{"tokens":[{"symbol":"USDC","addresses":{"__proto__":"0xevil","constructor":"0xevil","8453":"0xreal"}}]}',
    );
    const c = parseCapabilities(body)!;
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(c.tokens[0]!.addresses)).toEqual(["8453"]);
  });
});

/**
 * Static table intersected with the live matrix. Two chains in `CONFIG.CHAINS`
 * are flag-gated server-side (Tron behind ENABLE_TRON, Arc behind ENABLE_ARC)
 * and vanish from the matrix while their flag is off, so the table alone
 * answers "quotable" wrong.
 */
describe("servedChainKeys / chainUnservedReason", () => {
  it("keeps only the chains the venue advertises", () => {
    // The fixture advertises 8453, 1 and Tron -- and not Arc.
    expect(servedChainKeys(caps(), CONFIG.CHAINS).sort()).toEqual(["base", "ethereum", "tron"]);
  });

  it("drops a gated chain the moment the venue stops advertising it", () => {
    // ENABLE_TRON off: Riddler omits Tron from /capabilities entirely.
    const tronOff = parseCapabilities(
      matrix({
        chains: [
          { chain_id: 8453, chain_name: "Base", vm_type: "evm", address_format: "hex20" },
          { chain_id: 1, chain_name: "Ethereum", vm_type: "evm", address_format: "hex20" },
        ],
      }),
    )!;
    expect(servedChainKeys(tronOff, CONFIG.CHAINS)).toEqual(["ethereum", "base"]);
  });

  it("says nothing about a chain that is advertised", () => {
    expect(chainUnservedReason(caps(), CONFIG.CHAINS.base!)).toBeNull();
  });

  it("distinguishes a gated chain from one the venue has never heard of", () => {
    // Different remedies: wait for the flip, versus fix your chain id.
    expect(chainUnservedReason(caps(), CONFIG.CHAINS.arc!)).toContain("enable_arc");

    const unknown = chainUnservedReason(caps(), { chainId: 999999, name: "Nowhere" });
    expect(unknown).toContain("not advertised");
    expect(unknown).not.toContain("enable_");
  });

  it("tells an unrecognised vm_type apart from an unadvertised chain", () => {
    // The remedy is upgrading this client, not checking the chain id.
    const c = parseCapabilities(
      matrix({ chains: [{ chain_id: 8453, chain_name: "Base", vm_type: "evm2" }] }),
    )!;
    const reason = chainUnservedReason(c, CONFIG.CHAINS.base!);
    expect(reason).toContain("vm_type evm2");
    expect(reason).toContain("upgrade the SDK");
    expect(servedChainKeys(c, CONFIG.CHAINS)).toEqual([]);
  });

  it("does not serve a chain id advertised twice, whatever VMs its rows name", () => {
    // Both rows of a duplicated pair are unserved, whichever VM each names.
    for (const chains of [
      [
        { chain_id: 8453, vm_type: "evm" },
        { chain_id: 8453, vm_type: "tvm2" },
      ],
      [
        { chain_id: 8453, vm_type: "tvm" },
        { chain_id: 8453, vm_type: "evm" },
      ],
    ]) {
      const c = parseCapabilities(
        matrix({ chains: [...chains, { chain_id: 1, vm_type: "evm" }] }),
      )!;
      expect(servedChainKeys(c, CONFIG.CHAINS)).toEqual(["ethereum"]);
    }
  });
});
