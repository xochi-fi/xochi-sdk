/**
 * Client-side claim_info gate.
 *
 * Last check before the served factory is trusted. The client cannot verify the
 * stealth ADDRESS at quote time (the solver picks the ephemeral key, so the
 * address is only derivable once announced), which is precisely why the factory
 * has to carry the weight.
 */
import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY } from "../shared/index.js";
import { claimInfoError } from "./claimInfo.js";

/** Tests use Ethereum L1, one of the chains with a trusted factory. */
const MAINNET = 1;

const ATTACKER_FACTORY = "0xAbC0000000000000000000000000000000000123";

describe("claimInfoError", () => {
  it("accepts the shipped factory at salt 0", () => {
    expect(claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 0 }, MAINNET)).toBeNull();
  });

  it("rejects a factory this build does not ship", () => {
    const err = claimInfoError({ factoryAddress: ATTACKER_FACTORY, salt: 0 }, MAINNET);
    expect(err).not.toBeNull();
    expect(err?.code).toBe("untrusted_factory");
  });

  it("rejects an unexpected salt", () => {
    expect(
      claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 1 }, MAINNET),
    ).not.toBeNull();
  });

  // An omitted factory must not pass by being absent. That is the free win an
  // attacker gets if "missing" is treated as "fine".
  it("rejects claim_info with no factory at all", () => {
    expect(claimInfoError({ salt: 0 }, MAINNET)).not.toBeNull();
    expect(claimInfoError({ factoryAddress: "", salt: 0 }, MAINNET)).not.toBeNull();
  });

  // A public quote carries no claim_info; that is not an error.
  it("passes a non-stealth quote through", () => {
    expect(claimInfoError(undefined, MAINNET)).toBeNull();
    expect(claimInfoError(null, MAINNET)).toBeNull();
  });

  it("tolerates an absent salt on an otherwise trusted factory", () => {
    expect(claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY }, MAINNET)).toBeNull();
  });
});
