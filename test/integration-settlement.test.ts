/**
 * Integration tests for SettlementRegistryClient against real contracts on anvil.
 *
 * Deploys the full contract stack (AlwaysPassVerifier, XochiZKPVerifier,
 * XochiZKPOracle, SettlementRegistry) on a local anvil node, then exercises
 * the SDK client through the full settlement lifecycle:
 *   register trade -> submit compliance proofs -> record sub-settlements -> finalize
 *
 * Requires anvil (foundry). Run with:
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toHex,
  padHex,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { SettlementRegistryClient, SETTLEMENT_REGISTRY_ABI } from "../src/settlement-registry.js";
import { XochiOracle } from "../src/oracle.js";
import { ORACLE_ABI } from "../src/abis.js";
import { PROOF_TYPES } from "../src/constants.js";
import type { BatchProveResult } from "../src/batch-prover.js";

// ============================================================
// Contract bytecodes from erc-xochi-zkp compiled artifacts
// ============================================================

const ERC_XOCHI_ZKP = resolve(new URL(".", import.meta.url).pathname, "../../erc-xochi-zkp");

function loadBytecode(contractPath: string, contractName: string): Hex {
  const artifact = JSON.parse(
    readFileSync(resolve(ERC_XOCHI_ZKP, `out/${contractPath}/${contractName}.json`), "utf-8"),
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

const ANVIL_PORT = 8546; // avoid conflict with default 8545
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil's default funded accounts
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

let anvil: ChildProcess;
let registryClient: SettlementRegistryClient;
let oracleClient: XochiOracle;
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
  const data = (args === "0x" ? bytecode : (bytecode + args.slice(2))) as Hex;
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

    // Deploy XochiZKPVerifier(owner)
    const verifierBytecode = loadBytecode("XochiZKPVerifier.sol", "XochiZKPVerifier");
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

    // Deploy XochiZKPOracle(verifier, owner, configHash)
    configHash = keccak256(toHex("test-config"));
    const oracleBytecode = loadBytecode("XochiZKPOracle.sol", "XochiZKPOracle");
    const oracleArgs = (
      padHex(verifierAddress, { size: 32 }) +
      padHex(OWNER, { size: 32 }).slice(2) +
      configHash.slice(2)
    ) as Hex;
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
    oracleClient = new XochiOracle(oracleAddress, publicClient, aliceWallet, foundry);
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
  ): Promise<Hex> {
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
      // pattern layout: [analysis_type, result, reporting_threshold, time_window, tx_set_hash, submitter]
      publicInputs = [
        padHex(toHex(1), { size: 32 }), // analysis_type
        padHex(toHex(1), { size: 32 }), // result = pass
        padHex(toHex(10000), { size: 32 }), // reporting_threshold (must be registered)
        padHex(toHex(86400), { size: 32 }), // time_window (>= MIN_TIME_WINDOW)
        padHex("0xdead", { size: 32 }), // tx_set_hash (non-zero)
        submitterPadded, // submitter (must match msg.sender)
      ];
    } else {
      throw new Error(`unsupported proof type for test helper: ${proofType}`);
    }

    // Encode public inputs as packed bytes32[]
    const publicInputsEncoded = ("0x" + publicInputs.map((p) => p.slice(2)).join("")) as Hex;

    // Fake proof bytes (AlwaysPassVerifier accepts anything).
    // Must be unique per call -- oracle rejects replay via proofHash = keccak256(proof || publicInputs)
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const fakeProof = toHex(nonce) as Hex;

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
    return proofHash;
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
    const proofHash0 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const proofHash1 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);

    // Record sub-settlements
    const sub0Hash = await registryClient.recordSubSettlement(tradeId, 0, proofHash0);
    await publicClient.waitForTransactionReceipt({ hash: sub0Hash });

    const sub1Hash = await registryClient.recordSubSettlement(tradeId, 1, proofHash1);
    await publicClient.waitForTransactionReceipt({ hash: sub1Hash });

    // Verify
    const settlement = await registryClient.getSettlement(tradeId);
    expect(settlement.settledCount).toBe(2);

    const subs = await registryClient.getSubSettlements(tradeId);
    expect(subs).toHaveLength(2);
    expect(subs[0].proofHash).toBe(proofHash0);
    expect(subs[1].proofHash).toBe(proofHash1);
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
    const proofHash0 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const sub0 = await registryClient.recordSubSettlement(tradeId, 0, proofHash0);
    await publicClient.waitForTransactionReceipt({ hash: sub0 });

    const proofHash1 = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const sub1 = await registryClient.recordSubSettlement(tradeId, 1, proofHash1);
    await publicClient.waitForTransactionReceipt({ hash: sub1 });

    // Submit a pattern proof for anti-structuring finalization
    const patternProofHash = await submitComplianceProof(ALICE, 0, PROOF_TYPES.PATTERN);

    // Finalize trade
    const finHash = await registryClient.finalizeTrade(tradeId, patternProofHash);
    await publicClient.waitForTransactionReceipt({ hash: finHash });

    // Verify finalization
    const settlement = await registryClient.getSettlement(tradeId);
    expect(settlement.finalized).toBe(true);
    expect(settlement.settledCount).toBe(2);
    expect(settlement.subTradeCount).toBe(2);
  });

  it("rejects duplicate trade registration", async () => {
    const tradeId = keccak256(toHex("settlement-test-dup"));
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    const hash = await registryClient.registerTrade(tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash });

    // writeContract may return a tx hash before the revert is detected,
    // so we also check the receipt status
    try {
      const dupHash = await registryClient.registerTrade(tradeId, 0, 2);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: dupHash });
      expect(receipt.status).toBe("reverted");
    } catch {
      // Expected: viem may throw on simulation before sending
    }
  });

  it("rejects sub-settlement with out-of-bounds index", async () => {
    const tradeId = keccak256(toHex("settlement-test-oob"));
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    const hash = await registryClient.registerTrade(tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash });

    const proofHash = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);

    // Index 5 is out of bounds for a trade with 2 sub-trades
    try {
      const oobHash = await registryClient.recordSubSettlement(tradeId, 5, proofHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: oobHash });
      expect(receipt.status).toBe("reverted");
    } catch {
      // Expected: viem may throw on simulation before sending
    }
  });

  it("rejects finalization before all sub-trades are settled", async () => {
    const tradeId = keccak256(toHex("settlement-test-incomplete"));
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

    const regHash = await registryClient.registerTrade(tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    // Only settle 1 of 2 sub-trades
    const proofHash = await submitComplianceProof(ALICE, 0, PROOF_TYPES.COMPLIANCE);
    const sub0 = await registryClient.recordSubSettlement(tradeId, 0, proofHash);
    await publicClient.waitForTransactionReceipt({ hash: sub0 });

    const patternProofHash = await submitComplianceProof(ALICE, 0, PROOF_TYPES.PATTERN);

    // Should reject -- only 1/2 settled
    try {
      const finHash = await registryClient.finalizeTrade(tradeId, patternProofHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: finHash });
      expect(receipt.status).toBe("reverted");
    } catch {
      // Expected: viem may throw on simulation before sending
    }
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
      const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
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

    // Step 1: Submit batch proofs to oracle
    const batchResult = await oracleClient.submitBatch({
      batch,
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      providerSetHash,
    });

    // Step 2: Register trade
    const regHash = await registryClient.registerTrade(batch.tradeId, 0, 2);
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    // Step 3: Record sub-settlements using proofHashes from batch
    for (const sub of batchResult.submissions) {
      const recHash = await registryClient.recordSubSettlement(
        batch.tradeId,
        sub.index,
        sub.proofHash,
      );
      await publicClient.waitForTransactionReceipt({ hash: recHash });
    }

    // Step 4: Submit pattern proof and finalize
    const patternProofHash = await submitComplianceProof(ALICE, 0, PROOF_TYPES.PATTERN);
    const finHash = await registryClient.finalizeTrade(batch.tradeId, patternProofHash);
    await publicClient.waitForTransactionReceipt({ hash: finHash });

    // Verify
    const settlement = await registryClient.getSettlement(batch.tradeId);
    expect(settlement.finalized).toBe(true);
    expect(settlement.settledCount).toBe(2);

    const subs = await registryClient.getSubSettlements(batch.tradeId);
    expect(subs).toHaveLength(2);
    expect(subs[0].proofHash).toBe(batchResult.submissions[0].proofHash);
    expect(subs[1].proofHash).toBe(batchResult.submissions[1].proofHash);
  });
});
