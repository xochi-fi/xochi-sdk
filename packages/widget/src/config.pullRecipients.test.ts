/**
 * `PULL_RECIPIENTS` is handed to `@xochi/client`'s machine as
 * `MachineConfig.pullRecipients`, which passes it unchanged to `@xochi/signer`'s
 * `assertPullMatchesIntent` on every signable quote. These tests drive that same
 * signer call with independently provisioned runtime pins.
 */

import { describe, expect, it, vi } from "vitest";
// Imported here, at collection, rather than first inside a test's timeout:
// evaluating the client is the slow step, and `vi.resetModules` keeps it cached.
import { assertPullMatchesIntent } from "@xochi/signer";

const WALLET = "0x1111111111111111111111111111111111111111";
const SOLVER = "0x0000000000000000000000000000000000005011";
const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARC = "0x3600000000000000000000000000000000000000";
const AMOUNT = "1000000";

function served(to: string, fromChainId = 8453) {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const fromToken = fromChainId === 5042 ? USDC_ARC : USDC_BASE;
  return {
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: fromChainId },
      types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: WALLET,
        fromChainId,
        toChainId: 42161,
        fromToken,
        toToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        fromAmount: AMOUNT,
        toAmount: "500000000000000",
        recipient: WALLET,
        settlementPreference: "public",
        deadline,
      },
    },
    pull_authorization: {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: fromChainId,
        verifyingContract: fromToken,
      },
      types: { ReceiveWithAuthorization: [{ name: "to", type: "address" }] },
      primaryType: "ReceiveWithAuthorization",
      message: { from: WALLET, to, value: AMOUNT, validAfter: 0, validBefore: deadline + 300 },
    },
  };
}

async function loadConfig(erc3009Allowlist: string[], arcAllowlist?: string[]) {
  vi.resetModules();
  // Exercise the explicit configuration/module-loading boundary.
  const config = await import("./config.js");
  config.configureWidget({
    apiUrl: "https://api.example.test",
    solverPin: {
      erc3009Allowlist,
      ...(arcAllowlist ? { erc3009AllowlistByChain: { 5042: arcAllowlist } } : {}),
      permit2Allowlist: [],
      requirePin: true,
    },
    depositAttestationSigner: "",
  });
  return config;
}

describe("PULL_RECIPIENTS", () => {
  it("replaces just Arc ERC-3009 while preserving the other chain's pin and amount check", async () => {
    const arcSolver = "0x0000000000000000000000000000000000005042";
    const arcAllowlist = [arcSolver];
    const { PULL_RECIPIENTS, SOLVER_PIN } = await loadConfig([SOLVER], arcAllowlist);
    arcAllowlist[0] = ATTACKER;
    const check = (quote: ReturnType<typeof served>) =>
      assertPullMatchesIntent(quote, { expectedPullRecipients: PULL_RECIPIENTS });
    expect(() => check(served(arcSolver, 5042))).not.toThrow();
    expect(() => check(served(ATTACKER, 5042))).toThrow(/was pinned/);
    expect(() => check(served(SOLVER, 5042))).toThrow(/was pinned/);
    expect(() => check(served(SOLVER))).not.toThrow();
    expect(() => check(served(arcSolver))).toThrow(/was pinned/);
    const overPull = served(arcSolver, 5042);
    overPull.pull_authorization.message.value = "1000001";
    expect(() => check(overPull)).toThrow();
    expect(SOLVER_PIN.erc3009AllowlistByChain?.[5042]).toEqual([arcSolver]);
  });

  it("rejects invalid Arc overrides at initialization", async () => {
    await expect(loadConfig([SOLVER], [])).rejects.toThrow(/Invalid chain-specific ERC-3009 pin/);
    await expect(loadConfig([SOLVER], ["bad pin"])).rejects.toThrow(
      /Invalid chain-specific ERC-3009 pin/,
    );
  });

  it("pins every supported chain to the allowlist once it is set", async () => {
    const { PULL_RECIPIENTS } = await loadConfig([SOLVER]);
    expect(() =>
      assertPullMatchesIntent(served(SOLVER), { expectedPullRecipients: PULL_RECIPIENTS }),
    ).not.toThrow();
    expect(() =>
      assertPullMatchesIntent(served(ATTACKER), { expectedPullRecipients: PULL_RECIPIENTS }),
    ).toThrow();
  });

  it("cannot replace signing authority through settings mutation or reconfiguration", async () => {
    const allowlist = [SOLVER];
    const config = await loadConfig(allowlist);
    allowlist[0] = ATTACKER;
    expect(() =>
      assertPullMatchesIntent(served(ATTACKER), { expectedPullRecipients: config.PULL_RECIPIENTS }),
    ).toThrow();
    expect(() =>
      config.configureWidget({
        apiUrl: "https://api.example.test",
        solverPin: { erc3009Allowlist: [ATTACKER], permit2Allowlist: [], requirePin: true },
        depositAttestationSigner: "",
      }),
    ).toThrow(/immutable/);
    expect(() =>
      assertPullMatchesIntent(served(ATTACKER), { expectedPullRecipients: config.PULL_RECIPIENTS }),
    ).toThrow();
  });
});
