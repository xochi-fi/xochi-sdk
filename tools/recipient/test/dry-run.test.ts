// The dry run walks the same commands a live run does, on a port that records instead of
// calling. This pins the round-trip-critical sequence and its refusals; no network.

import { describe, expect, it } from "vitest";

import { systemClock } from "../src/node/data-dir.js";
import { deriveRecipientAccount } from "../src/core/account.js";
import { DryRunAztec } from "../src/core/chain.js";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";
import {
  checkNetwork,
  exit,
  registerSenders,
  setupAccount,
  type Ctx,
} from "../src/core/commands.js";
import { OXDAI_MAINNET_REV2 } from "../src/core/corridor.js";
import { NetworkPinRefused } from "../src/core/network.js";
import { TEST_SECRETS } from "./fixtures.js";

const CLAIM = { claimAmount: "1000", claimSecret: `0x${"01".repeat(32)}`, messageLeafIndex: "7" };

describe("dry run", () => {
  it("records network, account and sender steps in the live order", async () => {
    const port = new DryRunAztec(OXDAI_MAINNET_REV2);
    const lines: string[] = [];
    const ctx: Ctx = {
      corridor: OXDAI_MAINNET_REV2,
      port,
      log: (l) => lines.push(l),
      clock: systemClock,
    };
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
    await expect(
      checkNetwork({ corridor: other, port, log: () => {}, clock: systemClock }),
    ).rejects.toThrow(NetworkPinRefused);
    expect(port.calls).toEqual([
      "node.getNodeInfo() (synthetic: the pinned identity, node 6.0.0)",
      "node.getBlockData(1)",
    ]);
  });

  it("refuses an exit with a zero relayer tip before any call (it may never be relayed)", async () => {
    const port = new DryRunAztec(OXDAI_MAINNET_REV2);
    const ctx: Ctx = { corridor: OXDAI_MAINNET_REV2, port, log: () => {}, clock: systemClock };
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const request = {
      l1Recipient: `0x${"22".repeat(20)}`,
      amount: 10n ** 18n,
      proverTip: 0n,
      relayerTip: 0n,
      maxExecutorFee: 10n ** 18n,
      broadcasterArtifact: { name: "Broadcaster" } as ContractArtifact,
    };
    // The artifacts are never read on this path: the refusal comes before the port.
    const artifact = { name: "OxideToken" } as ContractArtifact;
    await expect(exit(ctx, account, artifact, request)).rejects.toThrow(
      /relayer-tip must be positive/,
    );
    expect(port.calls).toEqual([]);
    const paid = await exit(ctx, account, artifact, { ...request, relayerTip: 1n });
    expect(paid.withdrawals).toEqual([]);
    expect(port.calls.at(-1)).toMatch(/relayerTip 1/);
    // The broadcaster must be registered with the verified artifact before the submit that
    // simulates the finalization-request broadcast; the live run failed here without it.
    const register = port.calls.findIndex((call) =>
      call.startsWith(`wallet.registerContract(instance ${OXDAI_MAINNET_REV2.oxide.l2Broadcaster}`),
    );
    expect(register).toBeGreaterThan(
      port.calls.findIndex((call) => call.startsWith("node.getContract(")),
    );
    expect(register).toBeLessThan(port.calls.length - 1);
  });
});
