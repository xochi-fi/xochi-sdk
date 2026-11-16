/**
 * Round trip for a Stealth send to someone else's meta-address.
 *
 * Sender: parse the pasted `st:eth:0x...` (stealthRecipient.ts) and derive the
 * one-time address and ephemeral key from it with the existing
 * `computeStealthAddress`, the frozen reference the settlement's derivation is
 * held to (raxol forward and reverse suites). Recipient: the same
 * `scanAnnouncements` the scanner (`useStealthScanner`) runs, with only their
 * own keys, finds the payment, and the claim key it derives controls the
 * one-time owner.
 *
 * The chain is an in-memory one: a SimpleAccountFactory whose `getAddress` is
 * a fixed function of (factory, owner, salt), and ERC-20 balances. Everything
 * on the crypto path is real.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, encodePacked, getAddress, keccak256, type Hex, type PublicClient } from "viem";
import {
  computeStealthAddress,
  deriveStealthKeys,
  encodeMetaAddress,
  stealthAddressFromPrivateKey,
  type StealthAnnouncement,
  type StealthKeys,
} from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { scanAnnouncements } from "../../lib/stealth.js";
import { parseStealthMetaAddress } from "./stealthRecipient.js";

interface ReverseVector {
  name: string;
  signature: string;
  ephemeral_priv: string;
  stealth_address: string;
  ephemeral_pub: string;
  view_tag: number;
}

const vectors: ReverseVector[] = JSON.parse(
  readFileSync(new URL("../../lib/reverse-stealth-vectors.json", import.meta.url), "utf8"),
);

const MAINNET = 1;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AMOUNT = 25_000_000n;

/** A factory, token balances and an announcement log, held in memory. */
class InMemoryChain {
  readonly balances = new Map<string, bigint>();
  readonly announcements: StealthAnnouncement[] = [];

  counterfactual(factory: string, owner: string, salt: bigint): Hex {
    const hash = keccak256(
      encodePacked(
        ["address", "address", "uint256"],
        [getAddress(factory), getAddress(owner), salt],
      ),
    );
    return getAddress(`0x${hash.slice(-40)}`);
  }

  readonly client = {
    readContract: (params: {
      address: Hex;
      functionName: string;
      args: readonly unknown[];
    }): Promise<unknown> => {
      if (params.functionName === "getAddress") {
        const [owner, salt] = params.args as [Hex, bigint];
        return Promise.resolve(this.counterfactual(params.address, owner, salt));
      }
      if (params.functionName === "balanceOf") {
        const [account] = params.args as [Hex];
        const key = `${params.address.toLowerCase()}:${account.toLowerCase()}`;
        return Promise.resolve(this.balances.get(key) ?? 0n);
      }
      return Promise.reject(new Error(`in-memory chain: no ${params.functionName}`));
    },
  } as unknown as PublicClient;

  /**
   * Settle and announce one payment the way the Stealth settlement does: pay the
   * counterfactual account owned by the one-time address, then announce it
   * with the ephemeral key and the full metadata blob.
   */
  settle(stealthEOA: string, ephemeralPubKey: string, viewTag: number): StealthAnnouncement {
    const account = this.counterfactual(SIMPLE_ACCOUNT_FACTORY, stealthEOA, 0n);
    this.balances.set(`${USDC}:${account.toLowerCase()}`, AMOUNT);
    const metadata =
      "0x" +
      viewTag.toString(16).padStart(2, "0") +
      USDC.slice(2) +
      "a9059cbb" +
      AMOUNT.toString(16).padStart(64, "0") +
      SIMPLE_ACCOUNT_FACTORY.slice(2).toLowerCase() +
      "0".repeat(64);
    const announcement: StealthAnnouncement = {
      schemeId: 1,
      stealthAddress: account,
      caller: "0x0000000000000000000000000000000000000001",
      ephemeralPubKey,
      metadata,
      blockNumber: this.announcements.length + 1,
      txHash: `0x${"0".repeat(63)}${this.announcements.length + 1}`,
      logIndex: 0,
    };
    this.announcements.push(announcement);
    return announcement;
  }
}

const metaAddressOf = (keys: StealthKeys): string =>
  encodeMetaAddress({
    spendingPubKey: keys.spendingPubKey,
    viewingPubKey: keys.viewingPubKey,
    chainId: MAINNET,
  });

const scanWith = (chain: InMemoryChain, keys: StealthKeys) =>
  scanAnnouncements(
    chain.announcements,
    keys.spendingKey,
    keys.viewingKey,
    chain.client,
    SIMPLE_ACCOUNT_FACTORY,
    MAINNET,
  );

describe("a Stealth send to someone else's meta-address", () => {
  it.each(vectors)(
    "derives $name's reverse-vector address from the pasted meta-address",
    (vector) => {
      const recipient = deriveStealthKeys(vector.signature);
      const parsed = parseStealthMetaAddress(metaAddressOf(recipient));
      if (!parsed.ok) throw new Error(parsed.error);

      const derived = computeStealthAddress(
        { ...parsed.recipient, chainId: MAINNET },
        vector.ephemeral_priv,
      );
      expect(derived).toEqual({
        stealthAddress: vector.stealth_address,
        ephemeralPubKey: vector.ephemeral_pub,
        viewTag: vector.view_tag,
      });
    },
  );

  it("is found and claimable by the recipient's scanner, and by no one else", async () => {
    // A generated recipient (a signature outside the vectors) and a bystander.
    const recipient = deriveStealthKeys(`0x${"5a".repeat(64)}1c`);
    const bystander = deriveStealthKeys(vectors[1]!.signature);
    const ephemeral = vectors[0]!.ephemeral_priv;

    // Sender: only the pasted string and an ephemeral key.
    const parsed = parseStealthMetaAddress(`${metaAddressOf(recipient)}\n`);
    if (!parsed.ok) throw new Error(parsed.error);
    const derived = computeStealthAddress({ ...parsed.recipient, chainId: MAINNET }, ephemeral);

    const chain = new InMemoryChain();
    const announcement = chain.settle(
      derived.stealthAddress,
      derived.ephemeralPubKey,
      derived.viewTag,
    );

    // Recipient: their own keys find it, with the token and the live balance.
    const found = await scanWith(chain, recipient);
    expect(found).toHaveLength(1);
    expect(found[0]!.announcement).toBe(announcement);
    expect(found[0]!.tokenAddress).toBe(USDC);
    expect(found[0]!.amount).toBe(AMOUNT.toString());

    // The claim key controls the one-time owner of the paid account.
    const claimOwner = stealthAddressFromPrivateKey(bytesToHex(found[0]!.stealthPrivKey));
    expect(claimOwner.toLowerCase()).toBe(derived.stealthAddress);
    expect(chain.counterfactual(SIMPLE_ACCOUNT_FACTORY, claimOwner, 0n)).toBe(
      announcement.stealthAddress,
    );

    // Anyone else's keys, the sender's included, find nothing.
    expect(await scanWith(chain, bystander)).toEqual([]);
  });

  it("is not found once the recipient has claimed it", async () => {
    const recipient = deriveStealthKeys(`0x${"5a".repeat(64)}1c`);
    const parsed = parseStealthMetaAddress(metaAddressOf(recipient));
    if (!parsed.ok) throw new Error(parsed.error);
    const derived = computeStealthAddress(
      { ...parsed.recipient, chainId: MAINNET },
      vectors[2]!.ephemeral_priv,
    );
    const chain = new InMemoryChain();
    const announcement = chain.settle(
      derived.stealthAddress,
      derived.ephemeralPubKey,
      derived.viewTag,
    );
    chain.balances.set(`${USDC}:${announcement.stealthAddress.toLowerCase()}`, 0n);
    expect(await scanWith(chain, recipient)).toEqual([]);
  });
});
