/**
 * Already-swept stealth payments must leave the claims list (issue #470).
 *
 * `scanAnnouncements` matched on view tag + counterfactual address alone, which
 * answers "was this payment sent to an address you control", not "are the funds
 * still there". A claimed payment therefore stayed in the list forever with a
 * live CLAIM button, and clicking it could only fail: Riddler drops the intent
 * out of `claimable?` once `receiving_tx_hash` is set, so the answer is a 404.
 * Each dead row cost a claim rate-limit token, and `claimAll` walks the list
 * top-down, so a swept row at the top starved the claim the user actually wanted.
 *
 * The RPC boundary is stubbed (the counterfactual derivation and the balance
 * read are both `eth_call`s); the crypto path stays real, driven by the shared
 * reverse-stealth vectors.
 */
import { readFileSync } from "node:fs";
import type { Hex, PublicClient } from "viem";
import { hexToBytes, toHex } from "viem";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { StealthAnnouncement } from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { scanAnnouncements } from "./stealth.js";

interface ReverseVector {
  spending_priv: string;
  viewing_priv: string;
  ephemeral_pub: string;
  view_tag: number;
}

const vectors: ReverseVector[] = JSON.parse(
  readFileSync(new URL("./reverse-stealth-vectors.json", import.meta.url), "utf8"),
);
const v = vectors[0];

const MAINNET = 1;
const COUNTERFACTUAL = "0x00000000000000000000000000000000cAfEBabe" as Hex;
const USDC_MAINNET = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/** A full metadata blob: [viewTag][token(20)][selector(4)][amount(32)][factory(20)][salt(32)]. */
function fullMetadata(viewTag: number, amount: bigint): string {
  return (
    "0x" +
    viewTag.toString(16).padStart(2, "0") +
    USDC_MAINNET.slice(2) +
    "a9059cbb" +
    amount.toString(16).padStart(64, "0") +
    SIMPLE_ACCOUNT_FACTORY.slice(2).toLowerCase() +
    "0".repeat(64)
  );
}

function announcementWith(metadata: string): StealthAnnouncement {
  return {
    schemeId: 1,
    stealthAddress: COUNTERFACTUAL,
    caller: "0x0000000000000000000000000000000000000000",
    ephemeralPubKey: v.ephemeral_pub,
    metadata,
    blockNumber: 0,
    txHash: "0xdeadbeef",
    logIndex: 0,
  };
}

/**
 * Stub the two `eth_call`s scanAnnouncements makes: the factory's `getAddress`
 * (returns the announced counterfactual, so the match succeeds) and the token's
 * `balanceOf`. `balance` of `"throw"` simulates an RPC failure.
 */
function stubClient(balance: bigint | "throw"): PublicClient {
  const readContract = (params: { functionName: string }): Promise<unknown> => {
    if (params.functionName === "balanceOf") {
      if (balance === "throw") return Promise.reject(new Error("RPC down"));
      return Promise.resolve(balance);
    }
    return Promise.resolve(COUNTERFACTUAL);
  };
  return { readContract } as unknown as PublicClient;
}

const scan = (client: PublicClient, announcement: StealthAnnouncement) =>
  scanAnnouncements(
    [announcement],
    hexToBytes(v.spending_priv as Hex),
    hexToBytes(v.viewing_priv as Hex),
    client,
    SIMPLE_ACCOUNT_FACTORY,
    MAINNET,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanAnnouncements drops already-swept payments (#470)", () => {
  it("keeps a payment whose counterfactual still holds a balance", async () => {
    const payments = await scan(
      stubClient(1_965_845n),
      announcementWith(fullMetadata(v.view_tag, 1_965_845n)),
    );

    expect(payments).toHaveLength(1);
    // The token + live balance ride along, so the list can show what is being
    // claimed. Both fields existed on StealthPayment and nothing populated them.
    expect(payments[0].tokenAddress).toBe(USDC_MAINNET);
    expect(payments[0].amount).toBe("1965845");
  });

  it("drops a payment whose counterfactual has been emptied", async () => {
    const payments = await scan(
      stubClient(0n),
      announcementWith(fullMetadata(v.view_tag, 1_965_845n)),
    );
    expect(payments).toHaveLength(0);
  });

  it("reports the live balance, not the announced amount", async () => {
    // A partial sweep is not a state the claim path produces, but the balance is
    // the truth about what is spendable and the announcement is only a record of
    // what was sent. Assert we report the former.
    const payments = await scan(
      stubClient(500n),
      announcementWith(fullMetadata(v.view_tag, 1_965_845n)),
    );
    expect(payments[0].amount).toBe("500");
  });
});

describe("scanAnnouncements never hides a payment it cannot verify", () => {
  // "Could not read the balance" and "the balance is zero" must not look alike:
  // this list is the user's only route to the funds, so an RPC hiccup that
  // silently emptied it would be indistinguishable from having nothing to claim.
  it("keeps the payment when balanceOf fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const payments = await scan(
      stubClient("throw"),
      announcementWith(fullMetadata(v.view_tag, 1n)),
    );

    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBeUndefined();
    // Degrading to "show everything" is safe, but not something to discover
    // silently, so it is logged.
    expect(warn).toHaveBeenCalled();
  });

  it("keeps the payment when the metadata carries only a view tag", async () => {
    // ERC-5564 mandates only the tag byte, so a third-party or legacy
    // announcement has no token to check a balance against.
    const payments = await scan(stubClient(0n), announcementWith(toHex(v.view_tag, { size: 1 })));
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBeUndefined();
  });
});
