import { describe, it, expect, beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentActivityDigest,
  type AgentActivityMessage,
  type AgentActivityEvent,
} from "@xochi/client";
import { verifyAgentMessage, agentMessageToSwap } from "./agentStreamVerify.js";
import { reconcileLocalSwap } from "./localActivity.js";
import { isIntentStatus, isTerminalIntentStatus } from "@xochi/client";
import type { AuthorizedAgent } from "./agentRegistry.js";

const TOPIC = "verifytopicabcdef1234";
// Deterministic test keys (not secrets).
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

const EVENT: AgentActivityEvent = {
  intentId: "intent-abc",
  fromChainId: 8453,
  toChainId: 42161,
  fromToken: "0xUSDC",
  toToken: "0xUSDC",
  fromAmount: "100000000",
  toAmount: "99780000",
  status: "completed",
  ts: 1700000000000,
};

const now = 1_700_000_100_000;

function agent(address: string, expiresAt: number | null = null): AuthorizedAgent {
  return {
    agentWallet: address,
    label: "my rebalancer",
    topicId: TOPIC,
    mandateHash: null,
    scopes: [],
    expiresAt,
    addedAt: 0,
  };
}

let agentAddress: string;
let goodSig: string;

beforeAll(async () => {
  const acct = privateKeyToAccount(AGENT_KEY);
  agentAddress = acct.address;
  goodSig = await acct.signMessage({ message: agentActivityDigest(TOPIC, EVENT) });
});

const msg = (agentWallet: string, sig: string): AgentActivityMessage => ({
  type: "agent_activity",
  agentWallet,
  event: EVENT,
  agentSig: sig,
});

/** The same event carrying a different wire status (signature irrelevant here). */
const withStatus = (status: string): AgentActivityMessage => ({
  type: "agent_activity",
  agentWallet: agentAddress,
  event: { ...EVENT, status },
  agentSig: goodSig,
});

describe("verifyAgentMessage", () => {
  it("accepts a correctly-signed message from a registered agent", async () => {
    const res = await verifyAgentMessage(
      TOPIC,
      msg(agentAddress, goodSig),
      [agent(agentAddress)],
      now,
    );
    expect(res?.agentWallet).toBe(agentAddress);
  });

  it("rejects a message whose signature is from a different key", async () => {
    const other = privateKeyToAccount(OTHER_KEY);
    const forged = await other.signMessage({ message: agentActivityDigest(TOPIC, EVENT) });
    // Claims the registered agent's address but signed with another key.
    const res = await verifyAgentMessage(
      TOPIC,
      msg(agentAddress, forged),
      [agent(agentAddress)],
      now,
    );
    expect(res).toBeNull();
  });

  it("rejects an unregistered agent", async () => {
    const res = await verifyAgentMessage(TOPIC, msg(agentAddress, goodSig), [], now);
    expect(res).toBeNull();
  });

  it("rejects an expired agent", async () => {
    const expired = agent(agentAddress, now / 1000 - 60);
    const res = await verifyAgentMessage(TOPIC, msg(agentAddress, goodSig), [expired], now);
    expect(res).toBeNull();
  });

  it("rejects when signed for a different topic", async () => {
    const acct = privateKeyToAccount(AGENT_KEY);
    const sigForOtherTopic = await acct.signMessage({
      message: agentActivityDigest("othertopicabcdef1234", EVENT),
    });
    const res = await verifyAgentMessage(
      TOPIC,
      msg(agentAddress, sigForOtherTopic),
      [agent(agentAddress)],
      now,
    );
    expect(res).toBeNull();
  });
});

describe("agentMessageToSwap", () => {
  it("maps a verified message to a feed row tagged as agent", () => {
    const row = agentMessageToSwap(msg(agentAddress, goodSig), agent(agentAddress));
    expect(row.id).toBe("intent-abc");
    expect(row.initiator).toBe("agent");
    expect(row.agentLabel).toBe("my rebalancer");
    expect(row.data.isCrossChain).toBe(true);
    expect(row.status).toBe("completed");
  });

  // `AgentActivityEventSchema.status` is a bounded `z.string()`, and an agent
  // relays the solver's own mid-flight vocabulary. Stored raw, the row lands in
  // the same local log as the user's own swaps carrying a status the app cannot
  // place -- and the status poll's transition guard reads that stored value.
  it("buckets a granular agent status into the union the app models", () => {
    const row = agentMessageToSwap(withStatus("pulling"), agent(agentAddress));
    expect(row.intentStatus).toBe("executing");
    expect(row.status).toBe("pending");
  });

  it("buckets a status this build has never seen as still in flight", () => {
    const row = agentMessageToSwap(withStatus("quantum_settling"), agent(agentAddress));
    expect(isIntentStatus(row.intentStatus)).toBe(true);
    expect(isTerminalIntentStatus(row.intentStatus)).toBe(false);
  });

  // End to end: the row an agent event produces has to be one the recovery poll
  // can advance. It could not, so a live agent swap sat in the feed mid-flight for
  // the life of the record, warning on every 4s tick.
  it("produces a row the status poll can carry to completion", () => {
    const row = agentMessageToSwap(withStatus("pulling"), agent(agentAddress));
    const next = reconcileLocalSwap(row, {
      intentId: row.id,
      status: "completed",
      txHash: "0xpull",
      receivingTxHash: null,
      settlementTxHash: "0xreceipt",
      settlementChainId: 8453,
      error: null,
      refundReason: null,
      substatus: "filled",
      terminal: true,
    });
    expect(next?.intentStatus).toBe("completed");
    expect(next?.data.settlementTxHash).toBe("0xreceipt");
  });
});
