/**
 * Stealth SimpleAccountFactory forwarding (issue #302).
 *
 * The client must derive the counterfactual stealth SimpleAccount against the
 * SAME factory the solver uses, and only against one this build trusts on that
 * chain. These tests prove the factory reaches the on-chain `getAddress` call
 * with salt 0, through `computeCounterfactualAddress` and `scanAnnouncements`,
 * and that an untrusted one is refused before the RPC.
 *
 * The counterfactual derivation is an on-chain `eth_call` that cannot run
 * offline, so the PublicClient's `readContract` is stubbed here to capture the
 * factory + args and return a canned address. The crypto path (ECDH view-tag
 * match, owner-EOA derivation) stays real, driven by the shared reverse-stealth
 * vectors -- only the RPC boundary is stubbed.
 */
import { readFileSync } from "node:fs";
import type { Hex, PublicClient } from "viem";
import { describe, it, expect } from "vitest";
import type { StealthAnnouncement } from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { scanAnnouncements, computeCounterfactualAddress } from "./stealth.js";
import { hexToBytes, toHex } from "viem";

interface ReverseVector {
  name: string;
  spending_priv: string;
  viewing_priv: string;
  stealth_address: string;
  ephemeral_pub: string;
  view_tag: number;
}

const vectors: ReverseVector[] = JSON.parse(
  readFileSync(new URL("./reverse-stealth-vectors.json", import.meta.url), "utf8"),
);

const MAINNET = 1;
const BASE = 8453;
const ADVERTISED_FACTORY = "0xAbC0000000000000000000000000000000000123";

/**
 * A PublicClient whose only exercised method is `readContract`. Captures the
 * factory address + args it is called with, and returns `returns` so the
 * counterfactual match in canSpendFromAddress succeeds.
 */
function stubClient(returns: Hex): {
  client: PublicClient;
  calls: { address: Hex; args: readonly unknown[] }[];
} {
  const calls: { address: Hex; args: readonly unknown[] }[] = [];
  const readContract = (params: { address: Hex; args: readonly unknown[] }): Promise<Hex> => {
    calls.push({ address: params.address, args: params.args });
    return Promise.resolve(returns);
  };
  const client = { readContract } as unknown as PublicClient;
  return { client, calls };
}

describe("computeCounterfactualAddress forwards factory + salt", () => {
  it.each([MAINNET, BASE])(
    "calls the trusted factory with (owner, salt 0) on chain %s",
    async (chainId) => {
      const owner = "0x000000000000000000000000000000000000dEaD" as Hex;
      const canned = "0xF2596De89e643080f3Fc90941D87f348F4e40583" as Hex;
      const { client, calls } = stubClient(canned);

      const result = await computeCounterfactualAddress({
        owner,
        client,
        factory: SIMPLE_ACCOUNT_FACTORY as Hex,
        chainId,
      });

      expect(result).toBe(canned);
      expect(calls).toHaveLength(1);
      expect(calls[0].address).toBe(SIMPLE_ACCOUNT_FACTORY);
      expect(calls[0].args).toEqual([owner, 0n]);
    },
  );

  // Supersedes part of #302's premise. "Follow the advertised factory" is now
  // "follow it if this build trusts it on that chain, otherwise refuse": the
  // factory decides who owns the payout account, so unconditional following
  // meant an advertised attacker factory was honoured by both sides.
  it("refuses to derive against an untrusted factory, and never reaches the RPC", async () => {
    const { client, calls } = stubClient("0xF2596De89e643080f3Fc90941D87f348F4e40583");

    await expect(
      computeCounterfactualAddress({
        owner: "0x000000000000000000000000000000000000dEaD",
        client,
        factory: ADVERTISED_FACTORY,
        chainId: MAINNET,
      }),
    ).rejects.toThrow(/untrusted SimpleAccountFactory/i);

    // Refused before the eth_call, so a hostile factory is never even queried.
    expect(calls).toHaveLength(0);
  });

  // The allowlist is per-chain: a factory trusted on L1 is not authorization
  // for a chain this build lists no factory for.
  it("refuses a trusted L1 factory on a chain with no listed factory", async () => {
    const { client } = stubClient("0xF2596De89e643080f3Fc90941D87f348F4e40583");
    await expect(
      computeCounterfactualAddress({
        owner: "0x000000000000000000000000000000000000dEaD",
        client,
        factory: SIMPLE_ACCOUNT_FACTORY as Hex,
        chainId: 42161,
      }),
    ).rejects.toThrow(/untrusted SimpleAccountFactory/i);
  });
});

describe("scanAnnouncements forwards the factory (issue #302)", () => {
  const v = vectors[0];
  // The reverse vector's `stealth_address` is the stealth owner EOA; in the
  // counterfactual model the announced destination is the SimpleAccount, so the
  // announcement carries the (stubbed) counterfactual. Use a distinct canned
  // address as the announced destination and have the stub return it, so the
  // view-tag pass + counterfactual match both succeed.
  const announcedCounterfactual = "0x00000000000000000000000000000000cAfEBabe" as Hex;
  const announcement: StealthAnnouncement = {
    schemeId: 1,
    stealthAddress: announcedCounterfactual,
    caller: "0x0000000000000000000000000000000000000000",
    ephemeralPubKey: v.ephemeral_pub,
    metadata: toHex(v.view_tag, { size: 1 }),
    blockNumber: 0,
    txHash: "0x",
    logIndex: 0,
  };

  it("passes the given trusted factory into the on-chain derivation", async () => {
    const { client, calls } = stubClient(announcedCounterfactual);

    const payments = await scanAnnouncements(
      [announcement],
      hexToBytes(v.spending_priv as Hex),
      hexToBytes(v.viewing_priv as Hex),
      client,
      SIMPLE_ACCOUNT_FACTORY as Hex,
      MAINNET,
    );

    expect(payments).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(SIMPLE_ACCOUNT_FACTORY);
  });

  it("matches a Base announcement against the per-chain trusted factory", async () => {
    const { client, calls } = stubClient(announcedCounterfactual);
    const payments = await scanAnnouncements(
      [announcement],
      hexToBytes(v.spending_priv as Hex),
      hexToBytes(v.viewing_priv as Hex),
      client,
      [SIMPLE_ACCOUNT_FACTORY as Hex],
      BASE,
    );

    expect(payments).toHaveLength(1);
    expect(calls[0].address).toBe(SIMPLE_ACCOUNT_FACTORY);
  });

  it("derives against the pinned factory when none is given", async () => {
    const { client, calls } = stubClient(announcedCounterfactual);

    const payments = await scanAnnouncements(
      [announcement],
      hexToBytes(v.spending_priv as Hex),
      hexToBytes(v.viewing_priv as Hex),
      client,
      undefined,
      MAINNET,
    );

    expect(payments).toHaveLength(1);
    expect(calls[0].address).toBe(SIMPLE_ACCOUNT_FACTORY);
  });
});
