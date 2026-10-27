/**
 * Integration tests for SettlementRegistryClient against real contracts on anvil.
 *
 * Deploys the full contract stack (AlwaysPassVerifier, ERC8262Verifier,
 * ERC8262Oracle, SettlementRegistry) on a local anvil node, then exercises
 * the SDK client through the full settlement lifecycle:
 *   register trade -> submit compliance proofs -> record sub-settlements -> finalize
 * The last test proves a real PATTERN proof dated by `ERC8262Prover({ client })`
 * with `notBefore` while the chain runs ahead of the local clock.
 *
 * Requires anvil (foundry). Run with:
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  padHex,
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { Barretenberg } from "@aztec/bb.js";
import { pedersenHash } from "@xochi/provider";
import { SettlementRegistryClient, SETTLEMENT_REGISTRY_ABI } from "../src/settlement-registry.js";
import { ERC8262Oracle } from "../src/oracle.js";
import { ORACLE_ABI } from "../src/abis.js";
import { PROOF_TYPES } from "../src/constants.js";
import type { BatchProveResult } from "../src/batch-prover.js";
import { BundledCircuitLoader } from "../src/circuits.js";
import {
  PATTERN_STRUCTURING,
  PatternTimestampPredatesTradeError,
  type PatternInput,
} from "../src/inputs/pattern.js";
import { ERC8262Prover } from "../src/prover.js";
import { chainProofTimestamp } from "../src/recency.js";

// ============================================================
// Contract bytecodes from ERC-8262 compiled artifacts
// ============================================================

const ERC_8262 =
  process.env.ERC_8262_PATH ??
  resolve(new URL(".", import.meta.url).pathname, "../../../../ERC-8262");

function loadBytecode(contractPath: string, contractName: string): Hex {
  const artifact = JSON.parse(
    readFileSync(resolve(ERC_8262, `out/${contractPath}/${contractName}.json`), "utf-8"),
  );
  return artifact.bytecode.object as Hex;
}

// ============================================================
// ABIs for setup-only functions (not part of SDK's public surface)
// ============================================================

const VERIFIER_SETUP_ABI = parseAbi([
  "function setVerifierInitial(uint8 proofType, address verifier) external",
]);

const ORACLE_SETUP_ABI = parseAbi([
  "function registerReportingThreshold(bytes32 threshold) external",
]);

// ============================================================
// Anvil management
// ============================================================

/**
 * Random stand-in proof word for the AlwaysPassVerifier. Below the BN254 scalar
 * modulus (top byte < 0x30), as the Oracle refuses a non-canonical word with
 * `NonCanonicalProof`.
 */
function randomProofWord(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  bytes[0] &= 0x1f;
  return toHex(bytes);
}

const ANVIL_PORT = 8546; // avoid conflict with default 8545
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil's default funded accounts
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

let anvil: ChildProcess;
let registryClient: SettlementRegistryClient;
let oracleClient: ERC8262Oracle;
let oracleAddress: Address;
let registryAddress: Address;
let configHash: Hex;

async function waitForAnvil(): Promise<void> {
  const client = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start within 5 seconds");
}

async function deployContract(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  bytecode: Hex,
  args: Hex = "0x",
): Promise<Address> {
  const data = (args === "0x" ? bytecode : bytecode + args.slice(2)) as Hex;
  const hash = await walletClient.sendTransaction({
    data,
    chain: foundry,
    account: OWNER,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy failed");
  return receipt.contractAddress;
}

// ============================================================
// Test suite
// ============================================================

describe("SettlementRegistryClient (anvil)", () => {
  beforeAll(async () => {
    // Start anvil
    anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], {
      stdio: "ignore",
      detached: false,
    });

    await waitForAnvil();

    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const ownerWallet = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_URL),
      account: OWNER,
    });
    const aliceWallet = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_URL),
      account: ALICE,
    });

    // Deploy AlwaysPassVerifier (from Foundry test artifacts)
    const stubVerifierAddr = await deployContract(
      ownerWallet,
      publicClient,
      loadBytecode("SettlementRegistry.t.sol", "AlwaysPassVerifier"),
    );

    // Deploy ERC8262Verifier(owner)
    const verifierBytecode = loadBytecode("ERC8262Verifier.sol", "ERC8262Verifier");
    const verifierArgs = padHex(OWNER, { size: 32 }) as Hex;
    const verifierAddress = await deployContract(
      ownerWallet,
      publicClient,
      verifierBytecode,
      verifierArgs,
    );

    // Set stub verifier for all proof types (1-6)
    for (let proofType = 1; proofType <= 6; proofType++) {
      const hash = await ownerWallet.writeContract({
        address: verifierAddress,
        abi: VERIFIER_SETUP_ABI,
        functionName: "setVerifierInitial",
        args: [proofType, stubVerifierAddr],
        chain: foundry,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    // Deploy ERC8262Oracle(verifier, owner, configHash, providerIds).
    // Audit F-2: constructor takes initialProviderIds atomically.
    configHash = keccak256(toHex("test-config"));
    const oracleBytecode = loadBytecode("ERC8262Oracle.sol", "ERC8262Oracle");
    const oracleArgs = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      [verifierAddress, OWNER, configHash, [1n]],
    );
    oracleAddress = await deployContract(ownerWallet, publicClient, oracleBytecode, oracleArgs);

    // Register a reporting threshold for pattern proofs
    const thresholdHash = await ownerWallet.writeContract({
      address: oracleAddress,
      abi: ORACLE_SETUP_ABI,
      functionName: "registerReportingThreshold",
      args: [padHex(toHex(10000), { size: 32 })],
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash: thresholdHash });

    // Deploy SettlementRegistry(oracle)
    const registryBytecode = loadBytecode("SettlementRegistry.sol", "SettlementRegistry");
    const registryArgs = padHex(oracleAddress, { size: 32 }) as Hex;
    registryAddress = await deployContract(
      ownerWallet,
      publicClient,
      registryBytecode,
      registryArgs,
    );

    // Create clients with Alice's wallet (she'll be the trade subject)
    oracleClient = new ERC8262Oracle(oracleAddress, publicClient, aliceWallet, foundry);
    registryClient = new SettlementRegistryClient(
      registryAddress,
      publicClient,
      aliceWallet,
      foundry,
    );
  }, 30_000);

  afterAll(() => {
    if (anvil) {
      anvil.kill("SIGTERM");
    }
  });

  // ============================================================
  // Helpers
  // ============================================================

  async function submitComplianceProof(
    subject: Address,
    jurisdictionId: number,
    proofType: number,
    tradeId?: Hex,
  ): Promise<{ proofHash: Hex; publicInputs: Hex }> {
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const wallet = createWalletClient({
      chain: foundry,
      transport: http(ANVIL_URL),
      account: subject,
    });

    // Build minimal public inputs based on proof type.
    // The AlwaysPassVerifier accepts any proof bytes, but the Oracle
    // still validates public input structure per proof type.
    const configHash = keccak256(toHex("test-config"));
    const providerSetHash = padHex("0xaabb", { size: 32 });
    const submitterPadded = padHex(subject.toLowerCase() as Hex, { size: 32 });
    const now = Math.floor(Date.now() / 1000);

    let publicInputs: Hex[];

    if (proofType === PROOF_TYPES.COMPLIANCE) {
      // compliance layout: [jurisdiction_id, provider_set_hash, config_hash, timestamp, meets_threshold, submitter]
      publicInputs = [
        padHex(toHex(jurisdictionId), { size: 32 }),
        providerSetHash,
        configHash,
        padHex(toHex(now), { size: 32 }), // timestamp (must be within MAX_PROOF_AGE)
        padHex("0x01", { size: 32 }), // meets_threshold = true
        submitterPadded,
      ];
    } else if (proofType === PROOF_TYPES.PATTERN) {
      // pattern layout (audit H-1, ERC-8262#25):
      //   [analysis_type, result, reporting_threshold, time_window, tx_set_hash,
      //    submitter, settlement_root, timestamp]
      // settlement_root must equal SettlementRegistry.computeSettlementRoot(tradeId)
      // at the time finalizeTrade is called -- callers that intend to finalize
      // MUST pass the matching tradeId here so the off-chain helper can fetch it.
      const settlementRoot: Hex = tradeId
        ? await registryClient.computeSettlementRoot(tradeId)
        : (("0x" + "0".repeat(64)) as Hex);
      // finalizeTrade refuses a PATTERN timestamp before the trade's createdAt;
      // anvil can mine a block in the local clock's future, so never date it earlier.
      const createdAt = tradeId ? (await registryClient.getSettlement(tradeId)).createdAt : 0n;
      const patternTimestamp = createdAt > BigInt(now) ? createdAt : BigInt(now);
      publicInputs = [
        padHex(toHex(1), { size: 32 }), // analysis_type
        padHex(toHex(1), { size: 32 }), // result = pass
        padHex(toHex(10000), { size: 32 }), // reporting_threshold (must be registered)
        padHex(toHex(86400), { size: 32 }), // time_window (>= MIN_TIME_WINDOW)
        padHex("0xdead", { size: 32 }), // tx_set_hash (non-zero)
        submitterPadded, // submitter (must match msg.sender)
        settlementRoot, // settlement_root (audit H-1)
        padHex(toHex(patternTimestamp), { size: 32 }), // timestamp (>= createdAt, within MAX_PROOF_AGE)
      ];
    } else {
      throw new Error(`unsupported proof type for test helper: ${proofType}`);
    }

    // Encode public inputs as packed bytes32[]
    const publicInputsEncoded = ("0x" + publicInputs.map((p) => p.slice(2)).join("")) as Hex;

    // Fake proof bytes (AlwaysPassVerifier accepts anything).
    // Must be unique per call -- oracle rejects replay via proofHash = keccak256(proof || publicInputs)
    const fakeProof = randomProofWord();

    const hash = await wallet.writeContract({
      address: oracleAddress,
      abi: ORACLE_ABI,
      functionName: "submitCompliance",
      args: [jurisdictionId, proofType, fakeProof, publicInputsEncoded, providerSetHash],
      chain: foundry,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "reverted") {
      throw new Error(`submitCompliance reverted (proofType=${proofType})`);
    }

    // Extract proofHash from ComplianceVerified event
    // event ComplianceVerified(address indexed subject, uint8 indexed jurisdictionId,
    //   bool meetsThreshold, bytes32 indexed proofHash, uint256 expiresAt, uint256 previousExpiresAt)
    const complianceVerifiedTopic = keccak256(
      toHex("ComplianceVerified(address,uint8,bool,bytes32,uint256,uint256)"),
    );
    const log = receipt.logs.find((l) => l.topics[0] === complianceVerifiedTopic);
    if (!log) throw new Error("ComplianceVerified event not found");

    // proofHash is indexed as topic[3]
    const proofHash = log.topics[3];
    if (!proofHash) throw new Error("proofHash topic missing");
    return { proofHash, publicInputs: publicInputsEncoded };
  }

  // ============================================================
  // Tests
  // ============================================================

  it("reads the oracle address from the registry", async () => {
    const oracle = await registryClient.oracle();
    expect(oracle.toLowerCase()).toBe(oracleAddress.toLowerCase());
  });

  it("registers a trade and reads it back", async () => {
    const tradeId = keccak256(toHex("settlement-test-1"));

    const hash = await registryClient.registerTrade(tradeId, 0, 3);
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    await publicClient.waitForTransactionReceipt({ hash });

    const settlement = await registryClient.getSettlement(tradeId);

    expect(settlement.tradeId).toBe(tradeId);
    expect(settlement.subject.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(settlement.jurisdictionId).toBe(0);
    expect(settlement.subTradeCount).toBe(3);
    expect(settlement.settledCount).toBe(0);
    expect(settlement.finalized).toBe(false);
    expect(settlement.createdAt).toBeGreaterThan(0n);
    expect(settlement.expiresAt).toBeGreaterThan(settlement.createdAt);
  });

  it("records sub-settlements with compliance proofs from oracle", async () => {
    const tradeId = keccak256(toHex("settlement-test-2"));
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    // Register trade with 2 sub-trades
    const regHash = await registryClient.registerTrade(tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    // Submit 2 compliance proofs to oracle
    const r0 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const r1 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);

    // Record sub-settlements
    const sub0Hash = await registryClient.recordSubSettlement(tradeId, 0, r0.proofHash);
    await publicClient.waitForTransactionReceipt({ hash: sub0Hash });

    const sub1Hash = await registryClient.recordSubSettlement(tradeId, 1, r1.proofHash);
    await publicClient.waitForTransactionReceipt({ hash: sub1Hash });

    // Verify
    const settlement = await registryClient.getSettlement(tradeId);
    expect(settlement.settledCount).toBe(2);

    const subs = await registryClient.getSubSettlements(tradeId);
    expect(subs).toHaveLength(2);
    expect(subs[0].proofHash).toBe(r0.proofHash);
    expect(subs[1].proofHash).toBe(r1.proofHash);
    expect(subs[0].settledAt).toBeGreaterThan(0n);
    expect(subs[1].settledAt).toBeGreaterThan(0n);
  });

  it("completes full lifecycle: register -> settle -> finalize", async () => {
    const tradeId = keccak256(toHex("settlement-test-3"));
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    // Register trade with 2 sub-trades
    const regHash = await registryClient.registerTrade(tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    // Submit compliance proofs and record sub-settlements
    const r0 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const sub0 = await registryClient.recordSubSettlement(tradeId, 0, r0.proofHash);
    await publicClient.waitForTransactionReceipt({ hash: sub0 });

    const r1 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const sub1 = await registryClient.recordSubSettlement(tradeId, 1, r1.proofHash);
    await publicClient.waitForTransactionReceipt({ hash: sub1 });

    // Submit a pattern proof for anti-structuring finalization (analysisType=1).
    // Audit H-2: SettlementRegistry requires the original publicInputs bytes
    // to verify analysis_type == STRUCTURING (1) -- VELOCITY/ROUND_AMOUNT rejected.
    // Audit H-1: pattern.settlement_root must equal computeSettlementRoot(tradeId)
    // -- pass tradeId so the helper fetches the expected value.
    const pat = await submitComplianceProof(ALICE, 0, PROOF_TYPES.PATTERN, tradeId);

    // Finalize trade
    const finHash = await registryClient.finalizeTrade(tradeId, pat.proofHash, pat.publicInputs);
    await publicClient.waitForTransactionReceipt({ hash: finHash });

    // Verify finalization
    const settlement = await registryClient.getSettlement(tradeId);
    expect(settlement.finalized).toBe(true);
    expect(settlement.settledCount).toBe(2);
    expect(settlement.subTradeCount).toBe(2);
  });

  // ============================================================
  // submitBatch -- batch oracle submission
  // ============================================================

  function fakeBatchProveResult(subTradeCount: number): BatchProveResult {
    const providerSetHash = padHex("0xaabb", { size: 32 });
    const submitterPadded = padHex(ALICE.toLowerCase() as Hex, { size: 32 });
    const now = Math.floor(Date.now() / 1000);

    const proofs: BatchProveResult["proofs"] = [];
    for (let i = 0; i < subTradeCount; i++) {
      const fakeProof = randomProofWord();
      // compliance layout: [jurisdiction_id, provider_set_hash, config_hash, timestamp, meets_threshold, submitter]
      const publicInputs = [
        padHex(toHex(0), { size: 32 }), // EU
        providerSetHash,
        configHash,
        padHex(toHex(now), { size: 32 }),
        padHex("0x01", { size: 32 }),
        submitterPadded,
      ];
      const publicInputsHex = ("0x" + publicInputs.map((p) => p.slice(2)).join("")) as Hex;

      proofs.push({
        index: i,
        amount: 100n * 10n ** 18n,
        proofResult: {
          proof: new Uint8Array(32),
          publicInputs: publicInputs,
          proofHex: fakeProof,
          publicInputsHex,
        },
      });
    }

    return {
      tradeId: keccak256(toHex(`batch-test-${Date.now()}-${Math.random()}`)),
      proofs,
    };
  }

  it("submitBatch submits all proofs and returns proofHashes", async () => {
    const batch = fakeBatchProveResult(3);
    const providerSetHash = padHex("0xaabb", { size: 32 }) as Hex;

    const result = await oracleClient.submitBatch({
      batch,
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      providerSetHash,
    });

    expect(result.tradeId).toBe(batch.tradeId);
    expect(result.submissions).toHaveLength(3);

    for (const sub of result.submissions) {
      expect(sub.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sub.proofHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sub.amount).toBe(100n * 10n ** 18n);
    }

    // Each proofHash should be unique
    const hashes = new Set(result.submissions.map((s) => s.proofHash));
    expect(hashes.size).toBe(3);
  });

  it("submitBatch + settlement full lifecycle", async () => {
    const batch = fakeBatchProveResult(2);
    const providerSetHash = padHex("0xaabb", { size: 32 }) as Hex;
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    // Step 1: Register the trade first: recordSubSettlement refuses a leg whose
    // Oracle submission block predates registration (AttestationPredatesTrade).
    const regHash = await registryClient.registerTrade(batch.tradeId, 0, 2);
    expect((await publicClient.waitForTransactionReceipt({ hash: regHash })).status).toBe(
      "success",
    );

    // Step 2: Submit batch proofs to oracle
    const batchResult = await oracleClient.submitBatch({
      batch,
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      providerSetHash,
    });
    expect(
      (await publicClient.waitForTransactionReceipt({ hash: batchResult.txHash })).status,
    ).toBe("success");

    // Step 3: Record sub-settlements using proofHashes from batch
    for (const sub of batchResult.submissions) {
      const recHash = await registryClient.recordSubSettlement(
        batch.tradeId,
        sub.index,
        sub.proofHash,
      );
      expect((await publicClient.waitForTransactionReceipt({ hash: recHash })).status).toBe(
        "success",
      );
    }

    // Step 4: Submit pattern proof and finalize (pass publicInputs + tradeId so
    // settlement_root binds to the recorded sub-settlements per audit H-1)
    const pat = await submitComplianceProof(ALICE, 0, PROOF_TYPES.PATTERN, batch.tradeId);
    const finHash = await registryClient.finalizeTrade(
      batch.tradeId,
      pat.proofHash,
      pat.publicInputs,
    );
    expect((await publicClient.waitForTransactionReceipt({ hash: finHash })).status).toBe(
      "success",
    );

    // Verify
    const settlement = await registryClient.getSettlement(batch.tradeId);
    expect(settlement.finalized).toBe(true);
    expect(settlement.settledCount).toBe(2);

    const subs = await registryClient.getSubSettlements(batch.tradeId);
    expect(subs).toHaveLength(2);
    expect(subs[0].proofHash).toBe(batchResult.submissions[0].proofHash);
    expect(subs[1].proofHash).toBe(batchResult.submissions[1].proofHash);
  });

  // Moves anvil ahead of the local clock for good: keep this test last.
  it("a chain-stamped PATTERN proof with notBefore: createdAt finalizes when the chain is ahead of the local clock", async () => {
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const testClient = createTestClient({
      chain: foundry,
      mode: "anvil",
      transport: http(ANVIL_URL),
    });
    const providerSetHash = padHex("0xaabb", { size: 32 }) as Hex;
    const tradeId = keccak256(toHex("settlement-test-pattern-not-before"));

    // registerTrade lands 10 minutes ahead of the local clock (under MAX_PROOF_AGE,
    // so chainProofTimestamp caps at the local clock rather than refusing).
    const now = BigInt(Math.floor(Date.now() / 1000));
    const latest = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    const ahead = (latest > now ? latest : now) + 600n;
    await testClient.setNextBlockTimestamp({ timestamp: ahead });
    const regHash = await registryClient.registerTrade(tradeId, 0, 2);
    expect((await publicClient.waitForTransactionReceipt({ hash: regHash })).status).toBe(
      "success",
    );
    const { createdAt } = await registryClient.getSettlement(tradeId);
    expect(createdAt).toBe(ahead);

    for (const index of [0, 1]) {
      const leg = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
      const recHash = await registryClient.recordSubSettlement(tradeId, index, leg.proofHash);
      expect((await publicClient.waitForTransactionReceipt({ hash: recHash })).status).toBe(
        "success",
      );
    }

    // Without notBefore the chain stamp, min(local clock, latest), predates the trade.
    expect(BigInt(await chainProofTimestamp(publicClient))).toBeLessThan(createdAt);

    const amounts = [500, 1200, 3000, 7500];
    const timestamps = [4000, 3000, 2000, 1000].map((ago) => Number(now) - ago);
    const api = await Barretenberg.new();
    let txSetHash: Hex;
    try {
      const fields = Array.from({ length: 16 }, (_, i) => [
        BigInt(amounts[i] ?? 0),
        BigInt(timestamps[i] ?? 0),
      ]).flat();
      txSetHash = bytesToHex(await pedersenHash(api, fields));
    } finally {
      await api.destroy();
    }
    const patternInput: PatternInput = {
      amounts,
      timestamps,
      numTransactions: amounts.length,
      analysisType: PATTERN_STRUCTURING,
      reportingThreshold: 10000,
      timeWindow: 86400,
      txSetHash,
      submitter: ALICE,
      settlementRoot: await registryClient.computeSettlementRoot(tradeId),
    };

    const prover = new ERC8262Prover(new BundledCircuitLoader(), { client: publicClient });
    try {
      await expect(
        prover.provePattern({
          ...patternInput,
          timestamp: String(createdAt - 1n),
          notBefore: createdAt,
        }),
      ).rejects.toBeInstanceOf(PatternTimestampPredatesTradeError);

      const pattern = await prover.provePattern({ ...patternInput, notBefore: createdAt });
      expect(BigInt(pattern.publicInputs[7])).toBeGreaterThanOrEqual(createdAt);

      const submitHash = await oracleClient.submitCompliance({
        jurisdictionId: 0,
        proofType: PROOF_TYPES.PATTERN,
        proof: pattern.proofHex as Hex,
        publicInputs: pattern.publicInputsHex as Hex,
        providerSetHash,
      });
      const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
      expect(submitReceipt.status).toBe("success");
      const verified = submitReceipt.logs.find(
        (l) =>
          l.topics[0] ===
          keccak256(toHex("ComplianceVerified(address,uint8,bool,bytes32,uint256,uint256)")),
      );
      const patternProofHash = verified?.topics[3];
      if (!patternProofHash) throw new Error("ComplianceVerified proofHash topic missing");

      const finHash = await registryClient.finalizeTrade(
        tradeId,
        patternProofHash,
        pattern.publicInputsHex as Hex,
      );
      expect((await publicClient.waitForTransactionReceipt({ hash: finHash })).status).toBe(
        "success",
      );
      expect((await registryClient.getSettlement(tradeId)).finalized).toBe(true);
    } finally {
      await prover.destroy();
    }
  });
});
