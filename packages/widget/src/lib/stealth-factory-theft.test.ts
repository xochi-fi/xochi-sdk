/**
 * Adversarial test for the stealth-factory substitution theft.
 *
 * The other factory tests assert that a predicate returns false. This one
 * demonstrates the FAILURE the predicate exists to prevent, then shows each gate
 * refusing it, so the tests would still fail if someone weakened the gates while
 * leaving `isTrustedStealthFactory` intact.
 *
 * The attack:
 *
 *   1. A stealth payout lands in a counterfactual SimpleAccount, whose address
 *      is `factory.getAddress(stealthOwnerEOA, 0)`.
 *   2. Client and worker both FOLLOW the solver-advertised factory rather than
 *      their own pin (#302), because disagreeing means deriving different
 *      addresses and losing the payout.
 *   3. So whoever controls the advertised factory controls the address the money
 *      goes to, and both sides agree on it.
 *   4. The client cannot cross-check by deriving the stealth address itself: the
 *      solver picks the ephemeral key, so the address is only derivable after
 *      the announcement. The factory is the only field it can check in advance.
 *
 * A malicious factory does not need to be exotic. `getAddress` is a plain view
 * function; it can return whatever it likes, including an account the attacker
 * already controls.
 */

import { describe, it, expect, vi } from "vitest";
import type { Hex, PublicClient } from "viem";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { claimInfoError } from "@xochi/client";
import { parseCapabilities, stealthFactoryFor } from "@xochi/signer";
import { computeCounterfactualAddress } from "./stealth.js";

/** The recipient's one-time stealth EOA: the rightful owner of the payout. */
const STEALTH_OWNER = "0x00000000000000000000000000000000000000AA" as Hex;

/** Where an honest factory would put the funds. */
const HONEST_ACCOUNT = "0x1111111111111111111111111111111111111111" as Hex;

/** An account the attacker already controls. */
const ATTACKER_ACCOUNT = "0x000000000000000000000000000000000000dEaD" as Hex;

/** Lowercase: viem's isAddress checksum-validates mixed case, and a malformed
 * address degrades to the pin, which would hide the case under test. */
const MALICIOUS_FACTORY = "0xabc0000000000000000000000000000000000123";

/** Ethereum L1, one of the chains with a trusted factory. */
const MAINNET = 1;

/**
 * A viem client whose `getAddress` read answers differently per factory: the
 * honest factory returns the recipient's account, the malicious one returns the
 * attacker's. This is the whole trick, and it is a legal view function.
 */
const factoryAwareClient = () =>
  ({
    readContract: vi.fn(({ address }: { address: Hex }) =>
      Promise.resolve(
        address.toLowerCase() === MALICIOUS_FACTORY.toLowerCase()
          ? ATTACKER_ACCOUNT
          : HONEST_ACCOUNT,
      ),
    ),
  }) as unknown as PublicClient;

describe("stealth factory substitution: the failure being defended against", () => {
  // DOCUMENTATION, not evidence. This asserts that a stub returns what the stub
  // was told to return; it cannot prove anything about a real factory. It earns
  // its place by making the mechanism concrete and executable: the factory, and
  // nothing about the recipient, decides the destination. The load-bearing
  // assertions are in the next block.
  it("documents the mechanism: factory, not recipient, picks the destination", async () => {
    const client = factoryAwareClient();

    const honest = await computeCounterfactualAddress({
      owner: STEALTH_OWNER,
      client,
      factory: SIMPLE_ACCOUNT_FACTORY,
      chainId: MAINNET,
    });

    // Same stealth owner, same salt. Only the factory differs, and it is the
    // factory that answers "whose account is this".
    expect(honest).toBe(HONEST_ACCOUNT);
    // The same stub, asked about the attacker's factory, answers with the
    // attacker's account. That divergence is the whole attack.
    const viaMalicious = await (
      client.readContract as unknown as (a: { address: string }) => Promise<string>
    )({ address: MALICIOUS_FACTORY });
    expect(viaMalicious).toBe(ATTACKER_ACCOUNT);
    expect(viaMalicious).not.toBe(honest);
  });

  it("the parity rule that was supposed to protect us does not", () => {
    // #302 makes the client follow the advertised factory so it and the solver
    // agree. Agreement is all it guarantees: both sides agree on the attacker's
    // factory just as readily as on the honest one. Discovery still returns it;
    // derivation is what refuses it.
    const served = parseCapabilities({
      stealth_chains: [MAINNET],
      chains: [{ chain_id: MAINNET, vm_type: "evm", stealth_factory_address: MALICIOUS_FACTORY }],
    });
    expect(served).not.toBeNull();
    expect(stealthFactoryFor(served!, MAINNET)?.toLowerCase()).toBe(MALICIOUS_FACTORY);
  });
});

describe("stealth factory substitution: the chokepoint", () => {
  // The gate that actually holds. Every path to a payout address goes through
  // this function, so a future caller cannot route around it the way a
  // call-site check could be routed around.
  it("refuses to derive against the attacker's factory", async () => {
    await expect(
      computeCounterfactualAddress({
        owner: STEALTH_OWNER,
        client: factoryAwareClient(),
        factory: MALICIOUS_FACTORY,
        chainId: MAINNET,
      }),
    ).rejects.toThrow(/untrusted SimpleAccountFactory/i);
  });

  it("never queries the hostile factory at all", async () => {
    const client = factoryAwareClient();
    await computeCounterfactualAddress({
      owner: STEALTH_OWNER,
      client,
      factory: MALICIOUS_FACTORY,
      chainId: MAINNET,
    }).catch(() => undefined);
    // Refused before the eth_call: no RPC, no oracle for the attacker.
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses even the shipped factory on a chain that lists none", async () => {
    await expect(
      computeCounterfactualAddress({
        owner: STEALTH_OWNER,
        client: factoryAwareClient(),
        factory: SIMPLE_ACCOUNT_FACTORY,
        chainId: 42161,
      }),
    ).rejects.toThrow(/untrusted SimpleAccountFactory/i);
  });
});

describe("stealth factory substitution: the gates that stop it", () => {
  it("the client refuses a quote whose claim_info names the malicious factory", () => {
    const err = claimInfoError({ factoryAddress: MALICIOUS_FACTORY, salt: 0 }, MAINNET);
    expect(err).not.toBeNull();
  });

  it.each([MAINNET, 8453])("accepts the honest factory on chain %s", (chainId) => {
    expect(claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 0 }, chainId)).toBeNull();
  });

  // Salt is the second half of the CREATE2 input. Moving it moves the account
  // just as surely as changing the factory does.
  it("the client refuses a shifted salt, which relocates the account too", async () => {
    expect(
      claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 7 }, MAINNET),
    ).not.toBeNull();
  });

  // The cheapest possible attack is omission: if a missing factory read as
  // acceptable, an attacker would just drop the field.
  it("the client refuses claim_info with the factory omitted", () => {
    expect(claimInfoError({ salt: 0 }, MAINNET)).not.toBeNull();
  });
});
