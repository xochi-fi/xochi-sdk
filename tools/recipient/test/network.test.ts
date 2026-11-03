import { describe, expect, it } from "vitest";
import { OXIDE_TOKEN_CLASS_IDS, oxideTokenImmutablesHash } from "@xochi/signer";
import { readFileSync } from "node:fs";

import { CorridorSchema, OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { assertPinnedNetwork, NetworkPinRefused, type ObservedNetwork } from "../src/network.js";

// What an Aztec v6 mainnet node reports (Riddler's @revision_fixed[2]; xochi#778).
const MAINNET: ObservedNetwork = {
  l1ChainId: "1",
  rollupVersion: "2070860440",
  rollupAddress: "0xE37A2663CC9C119BA41572C40FAB0BBB23A5402F",
  block1LastArchiveRoot: "0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4",
  nodeVersion: "6.0.0",
};

const refusal = (observed: ObservedNetwork): readonly string[] => {
  try {
    assertPinnedNetwork(observed, OXDAI_MAINNET_REV2);
  } catch (e) {
    if (e instanceof NetworkPinRefused) return e.mismatches;
    throw e;
  }
  return [];
};

describe("network pinning", () => {
  it("admits Aztec v6 mainnet as the pinned node reports it", () => {
    expect(refusal(MAINNET)).toEqual([]);
  });

  it("refuses a node of another network, naming every member that differs (fixture values)", () => {
    const other: ObservedNetwork = {
      ...MAINNET,
      l1ChainId: "11155111",
      rollupVersion: "4127419662",
      rollupAddress: "0x66a41cb55f9a1e38a45a2ac8685f12a61fbfab17",
    };
    expect(refusal(other)).toEqual([
      "l1ChainId is 11155111, pinned 1",
      "aztecChainId (= l1ChainId) is 11155111, pinned 1",
      "rollupVersion is 4127419662, pinned 2070860440",
      "rollupAddress is 0x66a41cb55f9a1e38a45a2ac8685f12a61fbfab17, pinned 0xe37a2663cc9c119ba41572c40fab0bbb23a5402f",
    ]);
  });

  it("refuses each member on its own", () => {
    expect(refusal({ ...MAINNET, rollupVersion: "4248422647" })).toEqual([
      "rollupVersion is 4248422647, pinned 2070860440",
    ]);
    expect(refusal({ ...MAINNET, rollupAddress: `0x${"11".repeat(20)}` })).toHaveLength(1);
    expect(refusal({ ...MAINNET, block1LastArchiveRoot: `0x${"22".repeat(32)}` })).toEqual([
      `block 1 lastArchive.root is 0x${"22".repeat(32)}, pinned 0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4`,
    ]);
    expect(refusal({ ...MAINNET, nodeVersion: "5.2.0" })).toEqual([
      "nodeVersion is 5.2.0, pinned 6.0.x",
    ]);
  });
});

describe("the built-in corridor record", () => {
  it("is the rev 2 OXDAI corridor the other repos pin", () => {
    const c = OXDAI_MAINNET_REV2;
    expect(c.corridorId).toBe("0x2e6bcdd1a54e69d67e053620c8eb9451fe7ea0a81ffcd7da17627bd448739bc0");
    expect(c.manifestDigest).toBe(
      "0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e",
    );
    expect(c.registeredSenders).toEqual([
      "0x15ff3aa2270843241b4405bfc8ba72ae59b68c85996cff9e5c03daf03109cb22",
    ]);
    expect(c.token.address).toBe(
      "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3",
    );
    expect(OXIDE_TOKEN_CLASS_IDS).toContain(c.token.classId);
  });

  it("records the immutables @xochi/spec's OXDAI vector hashes", () => {
    const spec = JSON.parse(
      readFileSync(
        new URL("../../../packages/spec/conformance/shielded-recipient.json", import.meta.url),
        "utf8",
      ),
    ) as {
      oxideToken: {
        vectors: { immutables: unknown; immutablesHash: string; address: string | null }[];
      };
    };
    const oxdai = spec.oxideToken.vectors[0]!;
    expect(OXDAI_MAINNET_REV2.token.immutables).toEqual(oxdai.immutables);
    expect(oxideTokenImmutablesHash(OXDAI_MAINNET_REV2.token.immutables)).toBe(
      oxdai.immutablesHash,
    );
    expect(OXDAI_MAINNET_REV2.token.address).toBe(oxdai.address);
  });

  it("refuses an unordered sender set and unknown members", () => {
    const senders = [`0x${"05".repeat(32)}`, `0x${"04".repeat(32)}`];
    expect(() =>
      CorridorSchema.parse({ ...OXDAI_MAINNET_REV2, registeredSenders: senders }),
    ).toThrow(/strictly ascending/);
    expect(() => CorridorSchema.parse({ ...OXDAI_MAINNET_REV2, extra: 1 })).toThrow();
  });
});
