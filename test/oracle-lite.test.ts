/**
 * OracleLite against a scripted JSON-RPC endpoint.
 *
 * The endpoint is a real local HTTP server standing in for an untrusted or
 * faulty RPC: it answers eth_call with whatever each test scripts, so the
 * client's own validation (query encoding, response width, subject and
 * jurisdiction binding, proof-type policy, timeouts) can be exercised. Parity
 * with the real Oracle contract lives in integration-oracle.test.ts.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { OracleLite } from "../src/oracle-lite.js";
import { ORACLE_ABI } from "../src/abis.js";
import { PROOF_TYPES } from "../src/constants.js";

const ORACLE = "0x1234567890123456789012345678901234567890";
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const US = 1;

interface EthCall {
  from?: string;
  to: string;
  data: string;
}

type Reply = { result: string } | { error: { message: string; data?: string } } | "hang";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  server = undefined;
});

/** Start a JSON-RPC endpoint that answers every eth_call with `reply(call)`. */
async function startRpc(
  reply: (call: EthCall) => Reply,
): Promise<{ url: string; calls: EthCall[] }> {
  const calls: EthCall[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const { id, params } = JSON.parse(body) as { id: number; params: [EthCall, string] };
      calls.push(params[0]);
      const answer = reply(params[0]);
      if (answer === "hang") return;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, calls };
}

interface AttestationFields {
  subject: string;
  jurisdictionId: number;
  proofType: number;
  timestamp?: bigint;
}

function attestationHex(a: AttestationFields): string {
  const timestamp = a.timestamp ?? 1_700_000_000n;
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "bool" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
    ],
    [
      a.subject as Hex,
      a.jurisdictionId,
      a.proofType,
      timestamp !== 0n,
      timestamp,
      timestamp === 0n ? 0n : timestamp + 86_400n,
      `0x${"ab".repeat(32)}`,
      `0x${"00".repeat(32)}`,
      `0x${"cd".repeat(32)}`,
      timestamp === 0n ? `0x${"00".repeat(20)}` : ORACLE,
    ],
  ).slice(2);
}

/** `(bool valid, ComplianceAttestation)` as checkCompliance returns it. */
function checkResult(valid: boolean, a: AttestationFields): Reply {
  return { result: `0x${valid ? "1".padStart(64, "0") : "0".repeat(64)}${attestationHex(a)}` };
}

describe("OracleLite query validation", () => {
  it("rejects a wallet carrying extra ABI words instead of re-targeting the query", async () => {
    // Review PoC: "0x" + word(0x2222...) + word(0) decodes on-chain as
    // checkCompliance(0x2222..., EU) and Solidity ignores the trailing US word.
    const rpc = await startRpc(() => ({ result: "0x" }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });
    const smuggled = `0x${"22".repeat(20).padStart(64, "0")}${"0".repeat(64)}`;

    await expect(lite.checkCompliance(smuggled, US)).rejects.toThrow(
      /wallet must be a 0x-prefixed 20-byte hex address/,
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it("rejects an unprefixed wallet rather than shifting it", async () => {
    const rpc = await startRpc(() => ({ result: "0x" }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await expect(lite.checkCompliance("11".repeat(20), US)).rejects.toThrow(/wallet must be/);
    await expect(
      lite.verifyProof("11".repeat(20), PROOF_TYPES.COMPLIANCE, "0x00", "0x"),
    ).rejects.toThrow(/wallet must be/);
    expect(rpc.calls).toHaveLength(0);
  });

  it.each([256, -1, 1.5, Number.NaN])("rejects jurisdiction %s", async (jurisdiction) => {
    const rpc = await startRpc(() => ({ result: "0x" }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await expect(lite.checkCompliance(WALLET, jurisdiction as never)).rejects.toThrow(
      /jurisdictionId must be an integer in \[0, 255\]/,
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it("encodes checkCompliance and checkComplianceByType exactly as the ABI does", async () => {
    const rpc = await startRpc(() =>
      checkResult(true, { subject: WALLET, jurisdictionId: US, proofType: 1 }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await lite.checkCompliance(WALLET, US);
    await lite.checkComplianceByType(WALLET, US, PROOF_TYPES.COMPLIANCE_SIGNED);

    expect(rpc.calls[0].data).toBe(
      encodeFunctionData({ abi: ORACLE_ABI, functionName: "checkCompliance", args: [WALLET, US] }),
    );
    expect(rpc.calls[1].data).toBe(
      encodeFunctionData({
        abi: ORACLE_ABI,
        functionName: "checkComplianceByType",
        args: [WALLET, US, PROOF_TYPES.COMPLIANCE_SIGNED],
      }),
    );
  });
});

describe("OracleLite.checkCompliance", () => {
  it("does not report a live non-compliance attestation as valid", async () => {
    // Review #2: ERC-8262 answers valid=true for a RISK_SCORE_SIGNED "score > 10%" proof.
    const rpc = await startRpc(() =>
      checkResult(true, {
        subject: WALLET,
        jurisdictionId: US,
        proofType: PROOF_TYPES.RISK_SCORE_SIGNED,
      }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.checkCompliance(WALLET, US);
    expect(result?.valid).toBe(false);
    expect(result?.attestation?.proofType).toBe(PROOF_TYPES.RISK_SCORE_SIGNED);

    const optedIn = await lite.checkCompliance(WALLET, US, {
      acceptedProofTypes: [PROOF_TYPES.RISK_SCORE_SIGNED],
    });
    expect(optedIn?.valid).toBe(true);
  });

  it.each([
    PROOF_TYPES.COMPLIANCE,
    PROOF_TYPES.COMPLIANCE_SIGNED,
    PROOF_TYPES.COMPLIANCE_MULTI_SIGNED,
  ])("reports a live proofType %s attestation as valid", async (proofType) => {
    const rpc = await startRpc(() =>
      checkResult(true, { subject: WALLET, jurisdictionId: US, proofType }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    expect((await lite.checkCompliance(WALLET, US))?.valid).toBe(true);
  });

  it("keeps the Oracle's verdict when the attestation has lapsed", async () => {
    const rpc = await startRpc(() =>
      checkResult(false, { subject: WALLET, jurisdictionId: US, proofType: 1 }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.checkCompliance(WALLET, US);
    expect(result?.valid).toBe(false);
    expect(result?.attestation?.subject.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it("returns a null attestation when none exists", async () => {
    const rpc = await startRpc(() =>
      checkResult(false, {
        subject: `0x${"00".repeat(20)}`,
        jurisdictionId: 0,
        proofType: 0,
        timestamp: 0n,
      }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    expect(await lite.checkCompliance(WALLET, US)).toEqual({
      valid: false,
      attestation: null,
      source: "on-chain",
    });
  });

  it("rejects an answer about another subject", async () => {
    const rpc = await startRpc(() =>
      checkResult(true, { subject: OTHER, jurisdictionId: US, proofType: 1 }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await expect(lite.checkCompliance(WALLET, US)).rejects.toThrow(/does not match wallet/);
  });

  it("rejects an answer about another jurisdiction", async () => {
    const rpc = await startRpc(() =>
      checkResult(true, { subject: WALLET, jurisdictionId: 0, proofType: 1 }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await expect(lite.checkCompliance(WALLET, US)).rejects.toThrow(
      /jurisdiction 0 does not match requested 1/,
    );
  });

  it("rejects a truncated response", async () => {
    const full = checkResult(true, { subject: WALLET, jurisdictionId: US, proofType: 1 });
    const rpc = await startRpc(() => ({
      result: (full as { result: string }).result.slice(0, 2 + 64 * 5),
    }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    await expect(lite.checkCompliance(WALLET, US)).rejects.toThrow(/malformed response/);
  });

  it("times out a hung RPC", async () => {
    const rpc = await startRpc(() => "hang");
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url, timeoutMs: 50 });

    await expect(lite.checkCompliance(WALLET, US)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("OracleLite.checkComplianceByType", () => {
  it("is valid only for a live attestation of the requested type", async () => {
    const rpc = await startRpc(() =>
      checkResult(false, { subject: WALLET, jurisdictionId: US, proofType: PROOF_TYPES.PATTERN }),
    );
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.checkComplianceByType(WALLET, US, PROOF_TYPES.COMPLIANCE_SIGNED);
    expect(result?.valid).toBe(false);
    expect(result?.attestation?.proofType).toBe(PROOF_TYPES.PATTERN);
  });
});

describe("OracleLite.verifyProof", () => {
  const PROOF = `0x${"ee".repeat(40)}`;
  const INPUTS = [`0x${"01".padStart(64, "0")}`, `0x${"aa".repeat(32)}`];
  const PROVIDER_SET = `0x${"bb".repeat(32)}`;

  it("returns the verified public inputs and the bound attestation", async () => {
    const rpc = await startRpc(() => ({
      result: `0x${attestationHex({ subject: WALLET, jurisdictionId: US, proofType: 1 })}`,
    }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.verifyProof(
      WALLET,
      PROOF_TYPES.COMPLIANCE,
      PROOF,
      `0x${INPUTS.map((w) => w.slice(2)).join("")}`,
      PROVIDER_SET,
      US,
    );

    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.publicInputs).toEqual(INPUTS);
    expect(rpc.calls[0].from).toBe(WALLET);
    expect(rpc.calls[0].data).toBe(
      encodeFunctionData({
        abi: ORACLE_ABI,
        functionName: "submitCompliance",
        args: [
          US,
          PROOF_TYPES.COMPLIANCE,
          PROOF as Hex,
          `0x${INPUTS.map((w) => w.slice(2)).join("")}`,
          PROVIDER_SET as Hex,
        ],
      }),
    );
  });

  it("is invalid when the simulated attestation is not bound to the request", async () => {
    const rpc = await startRpc(() => ({
      result: `0x${attestationHex({ subject: WALLET, jurisdictionId: US, proofType: 2 })}`,
    }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.verifyProof(
      WALLET,
      PROOF_TYPES.COMPLIANCE,
      PROOF,
      INPUTS[0],
      PROVIDER_SET,
      US,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/proofType 2 does not match requested 1/);
  });

  it("is invalid for public inputs that are not whole words, without calling the RPC", async () => {
    const rpc = await startRpc(() => ({ result: "0x" }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.verifyProof(WALLET, PROOF_TYPES.COMPLIANCE, PROOF, "0x1234");
    expect(result).toMatchObject({ valid: false, publicInputs: null });
    expect(result.error).toMatch(/whole number of 32-byte words/);
    expect(rpc.calls).toHaveLength(0);
  });

  it("reports a revert as invalid, keeping the revert data", async () => {
    const rpc = await startRpc(() => ({
      error: { message: "execution reverted", data: "0x9fc3a218" },
    }));
    const lite = new OracleLite({ address: ORACLE, rpcUrl: rpc.url });

    const result = await lite.verifyProof(WALLET, PROOF_TYPES.COMPLIANCE, PROOF, INPUTS[0]);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("execution reverted (data: 0x9fc3a218)");
  });
});
