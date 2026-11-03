// The dry run walks the same commands a live run does, on a port that records instead of
// calling. This pins the round-trip-critical sequence and its refusals; no network.

import { describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/account.js";
import { DryRunAztec } from "../src/chain.js";
import { checkNetwork, registerSenders, setupAccount, type Ctx } from "../src/commands.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { NetworkPinRefused } from "../src/network.js";
import { TEST_SECRETS } from "./fixtures.js";

const CLAIM = { claimAmount: "1000", claimSecret: `0x${"01".repeat(32)}`, messageLeafIndex: "7" };

describe("dry run", () => {
  it("records network, account and sender steps in the live order", async () => {
    const port = new DryRunAztec(OXDAI_MAINNET_REV2);
    const lines: string[] = [];
    const ctx: Ctx = { corridor: OXDAI_MAINNET_REV2, port, log: (l) => lines.push(l) };
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    await checkNetwork(ctx);
    await setupAccount(ctx, account, CLAIM);
    await registerSenders(ctx);
    const address = account.address.toString();
    expect(port.calls).toEqual([
      "node.getNodeInfo() (synthetic: the pinned identity, node 6.0.0)",
      "node.getBlockData(1)",
      `wallet.createSchnorrAccount(secret, salt, signingKey) -> ${address}`,
      `wallet.getContractMetadata(${address}) (synthetic: not deployed)`,
      `accountManager.getDeployMethod().send({ from: NO_FROM, fee: FeeJuicePaymentMethodWithClaim(${address}, claim of 1000), skipClassPublication: true, skipInstancePublication: false })`,
      `wallet.registerSender(${OXDAI_MAINNET_REV2.registeredSenders[0]}) = pxe.registerTaggingSecretSource({ kind: "address-derived" })`,
      "wallet.getAddressBook()",
    ]);
  });

  it("stops before any account step when the corridor's network is not the node's", async () => {
    const other = {
      ...OXDAI_MAINNET_REV2,
      network: { ...OXDAI_MAINNET_REV2.network, protocolVersion: "1" },
    };
    // The dry-run node reports the built-in corridor's identity; a record pinned elsewhere refuses it.
    const port = new DryRunAztec(OXDAI_MAINNET_REV2);
    await expect(checkNetwork({ corridor: other, port, log: () => {} })).rejects.toThrow(
      NetworkPinRefused,
    );
    expect(port.calls).toEqual([
      "node.getNodeInfo() (synthetic: the pinned identity, node 6.0.0)",
      "node.getBlockData(1)",
    ]);
  });
});
