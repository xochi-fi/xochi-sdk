import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  buildRegisterStealthMetaAddressTx,
  classifyRecipientInput,
  lookupStealthMetaAddress,
  readStealthRegistration,
  resolveRecipient,
  type RecipientDeps,
} from "./index.js";

// Public Ethereum mainnet observations for the three name systems. The zk.money
// and stealth fixtures use synthetic responses so no deposit address is retained.
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const GNS = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
const WNS = "0x0000000000696760E15f265e828DB644A0c242EB";
const REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";
const nameRecords = [
  {
    contract: GNS,
    name: "gns.gwei",
    id: 29558010102677948599324270051375619357276711655655310617651344598630127157602n,
    address: "0xbBBCe157ecBB945b1F92Af88413b911910C727c8",
  },
  {
    contract: WNS,
    name: "eth.wei",
    id: 106523438880615555301029329028938868906491242375480103341320355885783007042321n,
    address: "0xD24C9bd55ed078806894104Df1D95E955C7419ae",
  },
] as const;
const META_BYTES =
  "0x0378e5ded02b8d6dd3613cce1ae68138aeab4bb41da113e01fc92c5b6a735e7a6102b41dfecfb89ce7052c0feb6077aab98e5242d98ae1449ac33a39003647e2deef";
const META = `st:eth:${META_BYTES}`;
const AVATAR = "https://example.com/avatar.png";

function resolverError(data: Hex): ContractFunctionRevertedError {
  const abi = parseAbi(["error ResolverError(bytes)"]);
  return new ContractFunctionRevertedError({
    abi,
    functionName: "resolveWithGateways",
    data: encodeErrorResult({ abi, args: [data] }),
  });
}

type Fixture = {
  readonly code?: Hex;
  readonly meta?: Hex;
  readonly text?: string;
  readonly avatar?: string;
  readonly calls?: string[];
  readonly offline?: boolean;
  readonly forward?: PublicClient["getEnsAddress"];
};

function client(fixture: Fixture = {}): PublicClient {
  const { calls } = fixture;
  const forward: PublicClient["getEnsAddress"] = async ({ name, strict }) => {
    calls?.push(`ens:${name}`);
    expect(strict).toBe(true);
    if (name === "vitalik.eth") return VITALIK;
    if (name === "sub.vitalik.eth") return VITALIK;
    if (name === "alice.zk.money") return "0x0000000000000000000000000000000000000001";
    if (name.endsWith(".zk.money")) throw resolverError("0x9a66e130");
    return null;
  };
  const actions = {
    getEnsAddress: fixture.forward ?? forward,
    async getEnsName({ address }: { address: Address }) {
      calls?.push("reverse");
      return address === VITALIK ? "vitalik.eth" : null;
    },
    async getEnsAvatar() {
      calls?.push("avatar");
      return fixture.avatar ?? null;
    },
    async getEnsText({ name, key }: { name: string; key: string }) {
      calls?.push(`text:${name}`);
      expect(key).toBe("stealth-meta-address[1]");
      return fixture.text ?? null;
    },
    async getCode({ address }: { address: Address }) {
      calls?.push("code");
      expect(address).toBe(REGISTRY);
      if (fixture.offline) throw new Error("Synthetic RPC detail");
      return fixture.code;
    },
    async readContract({
      address,
      functionName,
      args,
    }: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    }) {
      calls?.push(functionName);
      switch (functionName) {
        case "computeId":
          return (
            nameRecords.find((record) => record.contract === address && record.name === args[0])
              ?.id ?? 1n
          );
        case "resolve":
          return (
            nameRecords.find((record) => record.contract === address && record.id === args[0])
              ?.address ?? zeroAddress
          );
        case "stealthMetaAddressOf":
          expect(address).toBe(REGISTRY);
          expect(args).toEqual([VITALIK, 1n]);
          return fixture.meta ?? "0x";
        default:
          throw new Error(`Unexpected contract read ${functionName}`);
      }
    },
  };
  return actions as unknown as PublicClient;
}

function deps(mainnet: Fixture = {}, base?: Fixture): RecipientDeps {
  const baseClient = base && client(base);
  return {
    mainnetClient: client(mainnet),
    clientFor: (chainId) => (chainId === 8453 ? baseClient : undefined),
  };
}

describe("recipient resolution", () => {
  it.each([
    [" 0x123 ", "address"],
    ["SUB.vitalik.ETH", "ens"],
    ["GNS.GWEI", "gns"],
    ["ETH.WEI", "wns"],
    ["@alice", "zkmoney"],
    ["alice.zk.money", "zkmoney"],
    ["alice", "unknown"],
    [META, "stealth_meta"],
    ["alice.com", "unknown"],
  ])("classifies %s as %s", (input, kind) => {
    expect(classifyRecipientInput(input)).toBe(kind);
  });

  it("checksums a pasted address and resolves its primary name", async () => {
    expect(
      await resolveRecipient(`  ${VITALIK.toLowerCase()}  `, deps({ avatar: AVATAR })),
    ).toEqual({
      status: "resolved",
      recipient: {
        kind: "address",
        input: VITALIK,
        address: VITALIK,
        name: "vitalik.eth",
        avatarUrl: AVATAR,
      },
    });
  });

  it("normalizes ENS subnames and reads a secure avatar", async () => {
    expect(await resolveRecipient("  SUB.Vitalik.ETH ", deps({ avatar: AVATAR }))).toEqual({
      status: "resolved",
      recipient: {
        kind: "ens",
        input: "sub.vitalik.eth",
        address: VITALIK,
        name: "sub.vitalik.eth",
        avatarUrl: AVATAR,
      },
    });
  });

  it("drops an insecure avatar", async () => {
    expect(
      await resolveRecipient("vitalik.eth", deps({ avatar: "http://example.com/avatar" })),
    ).toEqual({
      status: "resolved",
      recipient: { kind: "ens", input: "vitalik.eth", address: VITALIK, name: "vitalik.eth" },
    });
  });

  it.each([
    ["gns", nameRecords[0]],
    ["wns", nameRecords[1]],
  ] as const)("resolves a recorded %s name on mainnet", async (kind, { name, address }) => {
    expect(await resolveRecipient(name.toUpperCase(), deps())).toEqual({
      status: "resolved",
      recipient: { kind, input: name, address, name },
    });
  });

  it.each(["@ALICE", "ALICE.zk.money"])("checks the Shielded alias %s", async (input) => {
    expect(await resolveRecipient(input, deps())).toEqual({
      status: "resolved",
      recipient: {
        kind: "zkmoney",
        input: "alice",
        name: "alice.zk.money",
        shieldedAlias: "alice",
      },
    });
  });

  it("parses a pasted stealth meta-address without RPC", async () => {
    const calls: string[] = [];
    expect(
      await resolveRecipient(` st:eth:0x${META_BYTES.slice(2).toUpperCase()} `, deps({ calls })),
    ).toEqual({
      status: "resolved",
      recipient: { kind: "stealth_meta", input: META, stealthMetaAddress: META },
    });
    expect(calls).toEqual([]);
  });

  it.each(["missing.eth", "@missing", "missing.gwei", "missing.wei"])(
    "reports missing %s",
    async (name) => {
      expect(await resolveRecipient(name, deps())).toMatchObject({ status: "not_found" });
    },
  );

  it.each(["", "alice", "0x123", zeroAddress, "a..eth", ".gwei", "st:eth:0xdead", "@!"])(
    "rejects invalid %s",
    async (input) => {
      const calls: string[] = [];
      expect(await resolveRecipient(input, deps({ calls }))).toMatchObject({ status: "invalid" });
      expect(calls).toEqual([]);
    },
  );

  it("never guesses the namespace of an unknown TLD", async () => {
    const calls: string[] = [];
    expect(await resolveRecipient("alice.example", deps({ calls }))).toMatchObject({
      status: "unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("returns a bounded error for an unrelated CCIP-read failure", async () => {
    const forward = async () => {
      throw resolverError("0xdeadbeef");
    };
    expect(await resolveRecipient("@alice", deps({ forward }))).toEqual({
      status: "unavailable",
      reason: "Recipient lookup unavailable.",
    });
  });

  it("does not start a lookup if already cancelled", async () => {
    const calls: string[] = [];
    expect(
      await resolveRecipient("vitalik.eth", deps({ calls }), AbortSignal.abort("private detail")),
    ).toEqual({
      status: "unavailable",
      reason: "Recipient lookup cancelled.",
    });
    expect(calls).toEqual([]);
  });

  it("cancels pending RPC promptly and skips subsequent requests", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let finish!: (address: Address) => void;
    const forward = () =>
      new Promise<Address>((resolve) => {
        finish = resolve;
      });
    const pending = resolveRecipient("vitalik.eth", deps({ calls, forward }), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "Recipient lookup cancelled." });
    finish(VITALIK);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});

describe("stealth registration", () => {
  it("uses ERC-6538 ahead of ENS text, skipping chains without bytecode", async () => {
    const mainnetCalls: string[] = [];
    const baseCalls: string[] = [];
    const dependencies = deps(
      { calls: mainnetCalls, text: META },
      { calls: baseCalls, code: "0x6000", meta: META_BYTES },
    );
    expect(await resolveRecipient("vitalik.eth", dependencies)).toMatchObject({
      status: "resolved",
      recipient: { stealthMetaAddress: META },
    });
    expect(mainnetCalls).toEqual(["ens:vitalik.eth", "code", "avatar"]);
    expect(baseCalls).toEqual(["code", "stealthMetaAddressOf"]);
  });

  it.each(["0x", "0xdead"] as const)(
    "falls back to ENS text for a missing or invalid registry entry (%s)",
    async (meta) => {
      const dependencies = deps({ code: "0x6000", meta, text: META });
      expect(await resolveRecipient("sub.vitalik.eth", dependencies)).toMatchObject({
        status: "resolved",
        recipient: { stealthMetaAddress: META },
      });
      expect(await lookupStealthMetaAddress(VITALIK, dependencies)).toBe(META);
      expect(await readStealthRegistration(VITALIK, dependencies)).toBe("published");
    },
  );

  it("returns no registration when the registry and text record are absent", async () => {
    expect(await lookupStealthMetaAddress(VITALIK, deps())).toBeUndefined();
    expect(await readStealthRegistration(VITALIK, deps())).toBe("not_published");
  });

  it("returns unknown on abort and does not downgrade to public on an RPC failure", async () => {
    expect(await readStealthRegistration(VITALIK, deps(), AbortSignal.abort())).toBe("unknown");
    expect(await readStealthRegistration(VITALIK, deps({ offline: true }))).toBe("unknown");
    expect(await resolveRecipient(VITALIK, deps({ offline: true }))).toEqual({
      status: "unavailable",
      reason: "Recipient lookup unavailable.",
    });
  });

  it("builds unsigned scheme-1 registration calldata", () => {
    const tx = buildRegisterStealthMetaAddressTx(META, 8453);
    expect(tx.to).toBe(REGISTRY);
    expect(tx.value).toBe(0n);
    expect(
      decodeFunctionData({
        abi: parseAbi(["function registerKeys(uint256, bytes)"]),
        data: tx.data,
      }),
    ).toEqual({ functionName: "registerKeys", args: [1n, META_BYTES] });
    expect(() => buildRegisterStealthMetaAddressTx(META, 56)).toThrow(
      "Unsupported registry chain.",
    );
    expect(() => buildRegisterStealthMetaAddressTx("st:eth:0xdead", 1)).toThrow(
      "Invalid stealth meta-address.",
    );
  });
});
