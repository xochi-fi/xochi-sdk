/**
 * Counterfactual SimpleAccount CREATE2 parity -- deterministic CI vector.
 *
 * A stealth settlement pays a counterfactual SimpleAccount owned by the
 * recipient's one-time stealth EOA. Riddler is authoritative: it derives that
 * address (`getAddress(owner, salt)`) to send funds; the Xochi client
 * (`src/lib/stealth.ts`) derives the SAME address to recognise the payment while
 * scanning ERC-5564 announcements (`canSpendFromAddress`). If the two ever
 * disagree, funds land at an address the recipient never scans for -- a silent
 * loss. This suite pins that shared derivation so drift fails CI, not prod.
 *
 * The live derivation is an on-chain `eth_call` (see
 * `counterfactual-address.integration.test.ts`, RPC-gated + nightly). This
 * suite is the offline complement: it recomputes the counterfactual address via
 * the raw CREATE2 formula against a PINNED vector and asserts it equals the
 * value the real factory returns, so it runs in normal CI with no network.
 *
 * PINNED VECTOR (regenerate only on an intentional factory change)
 *   factory        0x13E9ed32155810FDbd067D4522C492D6f68E5944  (SimpleAccountFactory v0.8)
 *   accountImpl    0x28426d752372D68d34340bd94390950DcE3C9ec3  (factory.accountImplementation())
 *   owner          0x000000000000000000000000000000000000dEaD  (arbitrary fixed stealth EOA)
 *   salt           0                                            (one account per stealth EOA)
 *   initCodeHash   0x4af4c824b4613950c6cb4a76bf0c6b0d92a5f1f5acbb0e94f66a365e2bd3ae8c
 *   expected       0xF2596De89e643080f3Fc90941D87f348F4e40583
 *
 * `initCodeHash` = keccak256(type(ERC1967Proxy).creationCode ++
 *   abi.encode(accountImpl, abi.encodeCall(SimpleAccount.initialize, (owner)))),
 * i.e. exactly what the factory's `getAddress` hashes. `expected` was read from
 * the deployed factory's `getAddress(owner, 0)` and is identical across chains
 * 1, 8453 and 42161 (the factory is a deterministic cross-chain deployment), so
 * it is chain-independent. Riddler's ExUnit asserts this SAME vector -- see the
 * cross-repo note in this suite's PR / issue #233.
 */
import { getContractAddress, isAddress, pad, type Hex } from "viem";
import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";

// Pinned CREATE2 vector (owner 0x...dEaD, salt 0). See the file header for the
// full provenance + how to regenerate.
const SALT = 0n;
const INIT_CODE_HASH: Hex = "0x4af4c824b4613950c6cb4a76bf0c6b0d92a5f1f5acbb0e94f66a365e2bd3ae8c";
const EXPECTED: Hex = "0xF2596De89e643080f3Fc90941D87f348F4e40583";

describe("counterfactual SimpleAccount CREATE2 parity", () => {
  it("recomputes the pinned counterfactual address from the client factory", () => {
    // Raw CREATE2 from the pinned factory constant + salt 0 + the pinned
    // init-code hash. Ties the factory pin to the golden: changing the pin breaks
    // this. `expected` mirrors the real factory's getAddress(owner, 0) (see header).
    const derived = getContractAddress({
      bytecodeHash: INIT_CODE_HASH,
      from: SIMPLE_ACCOUNT_FACTORY as Hex,
      opcode: "CREATE2",
      salt: pad(`0x${SALT.toString(16)}`, { size: 32 }),
    });

    expect(isAddress(derived)).toBe(true);
    expect(derived.toLowerCase()).toBe(EXPECTED.toLowerCase());
  });
});
