/**
 * `ERC8262Oracle.submitCompliance`'s `proofTimestamp` pre-check reads the
 * latest block, not `pending`, against a real local JSON-RPC endpoint whose
 * pending context lags `latest` (as on OP-stack RPCs).
 */

import { afterEach, describe, expect, it } from "vitest";
import { createWalletClient, http, padHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ERC8262Oracle } from "../src/oracle.js";
import { PROOF_TYPES } from "../src/constants.js";
import { startScriptedBlockRpc, type ScriptedBlockRpc } from "./scripted-block-rpc.js";

// anvil's first default key: test-only.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LATEST = 1_800_000_000n;

let rpc: ScriptedBlockRpc | undefined;
afterEach(async () => {
  await rpc?.close();
  rpc = undefined;
});

async function submitWithProofTimestamp(proofTimestamp: number): Promise<unknown> {
  // pending lags latest by 8 s, the measured Base mainnet worst case.
  rpc = await startScriptedBlockRpc([LATEST], { pending: LATEST - 8n });
  const wallet = createWalletClient({
    account: privateKeyToAccount(TEST_KEY),
    chain: foundry,
    transport: http(rpc.url, { retryCount: 0 }),
  });
  const oracle = new ERC8262Oracle(
    "0x0000000000000000000000000000000000000001",
    rpc.client,
    wallet,
    foundry,
  );
  return oracle
    .submitCompliance({
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      proof: "0x00" as Hex,
      publicInputs: "0x00" as Hex,
      providerSetHash: padHex("0x01", { size: 32 }),
      proofTimestamp,
    })
    .then(
      () => {
        throw new Error("submitCompliance resolved against an RPC that serves no writes");
      },
      (err: unknown) => err,
    );
}

describe("ERC8262Oracle.submitCompliance proofTimestamp pre-check", () => {
  it("checks a proof stamped at the latest block against latest, not a lagging pending", async () => {
    const err = await submitWithProofTimestamp(Number(LATEST));
    // The pre-check passed; the failure is the write this RPC does not serve.
    expect(String(err)).not.toMatch(/in the future|too old/);
    expect(rpc?.tags()[0]).toBe("latest");
    expect(rpc?.tags()).not.toContain("pending");
  });

  it("refuses a proof dated past the latest block before sending", async () => {
    const err = await submitWithProofTimestamp(Number(LATEST) + 1);
    expect(String(err)).toMatch(new RegExp(`in the future \\(now ${String(LATEST)}\\)`));
    expect(rpc?.tags()).toEqual(["latest"]);
  });
});
