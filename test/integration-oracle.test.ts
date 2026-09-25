/**
 * Integration tests for ERC8262Oracle, ERC8262Verifier, and OracleLite against
 * real contracts on anvil.
 *
 * Deploys the full stack (AlwaysPassVerifier, ERC8262Verifier, ERC8262Oracle)
 * and exercises the SDK clients:
 *   - ERC8262Oracle: submitCompliance, checkCompliance (compliance-type policy),
 *     history, config queries, signer registry, credential-root publication
 *   - ERC8262Verifier: verifyProof, verifyProofBatch, getVerifier, versioning
 *   - OracleLite: checkCompliance, checkComplianceByType, verifyProof (parity with ERC8262Oracle)
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
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { ERC8262Oracle } from "../src/oracle.js";
import { ERC8262Verifier } from "../src/verifier.js";
import { OracleLite } from "../src/oracle-lite.js";
import { ORACLE_ABI } from "../src/abis.js";
import { PROOF_TYPES, type ProofType } from "../src/constants.js";
import { loadSignerKey, RawKeyLoader } from "../src/provider/keystore.js";
import { signCredentialRoot } from "../src/provider/credential-root-signer.js";
import { withDecodedErrors } from "../src/errors.js";

// ============================================================
// Contract bytecodes
// ============================================================

const ERC_8262 = resolve(new URL(".", import.meta.url).pathname, "../../ERC-8262");

function loadBytecode(contractPath: string, contractName: string): Hex {
  const artifact = JSON.parse(
    readFileSync(resolve(ERC_8262, `out/${contractPath}/${contractName}.json`), "utf-8"),
  );
  return artifact.bytecode.object as Hex;
}

// ============================================================
// Setup ABIs (not part of SDK's public surface)
// ============================================================

const VERIFIER_SETUP_ABI = parseAbi([
  "function setVerifierInitial(uint8 proofType, address verifier) external",
]);

const ORACLE_SETUP_ABI = parseAbi([
  "function registerReportingThreshold(bytes32 threshold) external",
  "function registerMerkleRoot(bytes32 merkleRoot) external",
]);

// ============================================================
// Anvil management
// ============================================================

const ANVIL_PORT = 8547;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

const chainClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

let anvil: ChildProcess;
let oracleClient: ERC8262Oracle;
let verifierClient: ERC8262Verifier;
let oracleLite: OracleLite;
let oracleAddress: Address;
let verifierAddress: Address;
let stubVerifierAddr: Address;
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

// Build compliance public inputs matching the Oracle's _validateComplianceInputs layout
function buildCompliancePublicInputs(subject: Address, jurisdictionId: number): Hex {
  const now = Math.floor(Date.now() / 1000);
  const fields = [
    padHex(toHex(jurisdictionId), { size: 32 }),
    padHex("0xaabb", { size: 32 }), // provider_set_hash
    configHash,
    padHex(toHex(now), { size: 32 }), // timestamp (must be within MAX_PROOF_AGE of block.timestamp)
    padHex("0x01", { size: 32 }), // meets_threshold
    padHex(subject.toLowerCase() as Hex, { size: 32 }), // submitter
  ];
  return ("0x" + fields.map((f) => f.slice(2)).join("")) as Hex;
}

// ============================================================
// Test suite
// ============================================================

beforeAll(async () => {
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

  // Deploy AlwaysPassVerifier
  stubVerifierAddr = await deployContract(
    ownerWallet,
    publicClient,
    loadBytecode("SettlementRegistry.t.sol", "AlwaysPassVerifier"),
  );

  // Deploy ERC8262Verifier
  const verifierBytecode = loadBytecode("ERC8262Verifier.sol", "ERC8262Verifier");
  verifierAddress = await deployContract(
    ownerWallet,
    publicClient,
    verifierBytecode,
    padHex(OWNER, { size: 32 }) as Hex,
  );

  // Set stub verifier for every registered proof type. The signed variants
  // (0x07, 0x08) live in PROOF_TYPES too; missing them yields 0x0 from
  // getVerifier and breaks the verifier-router assertions below.
  for (const pt of Object.values(PROOF_TYPES) as ProofType[]) {
    const hash = await ownerWallet.writeContract({
      address: verifierAddress,
      abi: VERIFIER_SETUP_ABI,
      functionName: "setVerifierInitial",
      args: [pt, stubVerifierAddr],
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // Deploy ERC8262Oracle. Audit F-2: constructor takes initialProviderIds
  // atomically with the initial config so denylist enforcement is in effect
  // from block one. Use encodeAbiParameters for the dynamic uint256[] tail.
  configHash = keccak256(toHex("test-config"));
  const oracleBytecode = loadBytecode("ERC8262Oracle.sol", "ERC8262Oracle");
  const oracleArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
    [verifierAddress, OWNER, configHash, [1n]],
  );
  oracleAddress = await deployContract(ownerWallet, publicClient, oracleBytecode, oracleArgs);

  // Register reporting threshold
  const thresholdHash = await ownerWallet.writeContract({
    address: oracleAddress,
    abi: ORACLE_SETUP_ABI,
    functionName: "registerReportingThreshold",
    args: [padHex(toHex(10000), { size: 32 })],
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash: thresholdHash });

  // Create SDK clients
  const aliceWallet = createWalletClient({
    chain: foundry,
    transport: http(ANVIL_URL),
    account: ALICE,
  });

  oracleClient = new ERC8262Oracle(oracleAddress, publicClient, aliceWallet, foundry);
  verifierClient = new ERC8262Verifier(verifierAddress, publicClient);
  oracleLite = new OracleLite({ address: oracleAddress, rpcUrl: ANVIL_URL });
}, 30_000);

afterAll(() => {
  if (anvil) anvil.kill("SIGTERM");
});

// ============================================================
// ERC8262Verifier
// ============================================================

describe("ERC8262Verifier (anvil)", () => {
  it("getVerifier returns the stub verifier for each proof type", async () => {
    const allTypes = Object.values(PROOF_TYPES) as ProofType[];
    for (const pt of allTypes) {
      const addr = await verifierClient.getVerifier(pt);
      expect(addr.toLowerCase()).toBe(stubVerifierAddr.toLowerCase());
    }
  });

  it("getVerifierVersion returns 1 for initial setup", async () => {
    const version = await verifierClient.getVerifierVersion(PROOF_TYPES.COMPLIANCE);
    expect(version).toBe(1n);
  });

  it("getVerifierAtVersion returns stub for version 1", async () => {
    const addr = await verifierClient.getVerifierAtVersion(PROOF_TYPES.COMPLIANCE, 1n);
    expect(addr.toLowerCase()).toBe(stubVerifierAddr.toLowerCase());
  });

  it("verifyProof returns true with AlwaysPassVerifier", async () => {
    const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const publicInputs = buildCompliancePublicInputs(ALICE, 0);

    const valid = await verifierClient.verifyProof(PROOF_TYPES.COMPLIANCE, fakeProof, publicInputs);
    expect(valid).toBe(true);
  });

  it("verifyProofBatch returns true for multiple proofs", async () => {
    const proofTypes = [PROOF_TYPES.COMPLIANCE, PROOF_TYPES.COMPLIANCE];
    const proofs = [
      toHex(crypto.getRandomValues(new Uint8Array(32))),
      toHex(crypto.getRandomValues(new Uint8Array(32))),
    ];
    const publicInputs = [
      buildCompliancePublicInputs(ALICE, 0),
      buildCompliancePublicInputs(ALICE, 0),
    ];

    const valid = await verifierClient.verifyProofBatch(proofTypes, proofs, publicInputs);
    expect(valid).toBe(true);
  });

  it("verifyProofAtVersion returns true for version 1", async () => {
    const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const publicInputs = buildCompliancePublicInputs(ALICE, 0);

    const valid = await verifierClient.verifyProofAtVersion(
      PROOF_TYPES.COMPLIANCE,
      1n,
      fakeProof,
      publicInputs,
    );
    expect(valid).toBe(true);
  });
});

// ============================================================
// ERC8262Oracle
// ============================================================

describe("ERC8262Oracle (anvil)", () => {
  it("providerConfigHash matches initial config", async () => {
    const hash = await oracleClient.providerConfigHash();
    expect(hash).toBe(configHash);
  });

  it("attestationTTL returns 24 hours", async () => {
    const ttl = await oracleClient.attestationTTL();
    expect(ttl).toBe(BigInt(24 * 60 * 60));
  });

  it("isValidConfig returns true for initial config", async () => {
    const valid = await oracleClient.isValidConfig(configHash);
    expect(valid).toBe(true);
  });

  it("isValidConfig returns false for unknown config", async () => {
    const valid = await oracleClient.isValidConfig(keccak256(toHex("bogus")));
    expect(valid).toBe(false);
  });

  it("isValidReportingThreshold returns true for registered threshold", async () => {
    const valid = await oracleClient.isValidReportingThreshold(padHex(toHex(10000), { size: 32 }));
    expect(valid).toBe(true);
  });

  it("submitCompliance creates an attestation", async () => {
    const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const publicInputs = buildCompliancePublicInputs(ALICE, 0);
    const providerSetHash = padHex("0xaabb", { size: 32 }) as Hex;

    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const txHash = await oracleClient.submitCompliance({
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      proof: fakeProof,
      publicInputs,
      providerSetHash,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // checkCompliance should now return valid
    const result = await oracleClient.checkCompliance(ALICE, 0);
    expect(result.valid).toBe(true);
    expect(result.attestation.subject.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(result.attestation.jurisdictionId).toBe(0);
    expect(result.attestation.meetsThreshold).toBe(true);
    expect(result.attestation.expiresAt).toBeGreaterThan(0n);
  });

  it("getHistoricalProof returns submitted attestation", async () => {
    // Get the proof hash from the attestation history
    const history = await oracleClient.getAttestationHistory(ALICE, 0);
    expect(history.length).toBeGreaterThan(0);

    const proofHash = history[history.length - 1];
    const attestation = await oracleClient.getHistoricalProof(proofHash);

    expect(attestation.subject.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(attestation.meetsThreshold).toBe(true);
  });

  it("getProofType returns COMPLIANCE for submitted proof", async () => {
    const history = await oracleClient.getAttestationHistory(ALICE, 0);
    const proofHash = history[history.length - 1];

    const proofType = await oracleClient.getProofType(proofHash);
    expect(proofType).toBe(PROOF_TYPES.COMPLIANCE);
  });

  it("getAttestationHistoryPaginated returns correct page", async () => {
    const result = await oracleClient.getAttestationHistoryPaginated(ALICE, 0, 0n, 10n);
    expect(result.proofHashes.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0n);
  });
});

// ============================================================
// OracleLite parity
// ============================================================

describe("OracleLite parity (anvil)", () => {
  // Ensure a compliance proof exists before OracleLite tests run
  beforeAll(async () => {
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const publicInputs = buildCompliancePublicInputs(ALICE, 0);
    const providerSetHash = padHex("0xaabb", { size: 32 }) as Hex;

    const txHash = await oracleClient.submitCompliance({
      jurisdictionId: 0,
      proofType: PROOF_TYPES.COMPLIANCE,
      proof: fakeProof,
      publicInputs,
      providerSetHash,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  });

  it("checkCompliance returns same validity as ERC8262Oracle", async () => {
    const viemResult = await oracleClient.checkCompliance(ALICE, 0);
    const liteResult = await oracleLite.checkCompliance(ALICE, 0);

    expect(liteResult).not.toBeNull();
    expect(liteResult!.valid).toBe(viemResult.valid);
    expect(liteResult!.source).toBe("on-chain");
  });

  it("checkCompliance attestation fields match ERC8262Oracle", async () => {
    const viemResult = await oracleClient.checkCompliance(ALICE, 0);
    const liteResult = await oracleLite.checkCompliance(ALICE, 0);

    expect(liteResult).not.toBeNull();
    expect(liteResult!.attestation).not.toBeNull();
    const liteAtt = liteResult!.attestation!;
    const viemAtt = viemResult.attestation;

    expect(liteAtt.subject.toLowerCase()).toBe(viemAtt.subject.toLowerCase());
    expect(liteAtt.jurisdictionId).toBe(viemAtt.jurisdictionId);
    expect(liteAtt.meetsThreshold).toBe(viemAtt.meetsThreshold);
    expect(liteAtt.timestamp).toBe(viemAtt.timestamp);
    expect(liteAtt.expiresAt).toBe(viemAtt.expiresAt);
    expect(liteAtt.proofHash.toLowerCase()).toBe(viemAtt.proofHash.toLowerCase());
    expect(liteAtt.providerSetHash.toLowerCase()).toBe(viemAtt.providerSetHash.toLowerCase());
    expect(liteAtt.publicInputsHash.toLowerCase()).toBe(viemAtt.publicInputsHash.toLowerCase());
    expect(liteAtt.verifierUsed.toLowerCase()).toBe(viemAtt.verifierUsed.toLowerCase());
  });

  it("checkCompliance reports no attestation for an unknown address", async () => {
    // The Oracle returns a zeroed struct (valid=false) rather than reverting.
    const result = await oracleLite.checkCompliance(
      "0x0000000000000000000000000000000000000001",
      0,
    );
    expect(result).toEqual({ valid: false, attestation: null, source: "on-chain" });
  });

  it("verifyProof succeeds with AlwaysPassVerifier", async () => {
    const fakeProof = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const publicInputs = buildCompliancePublicInputs(ALICE, 0);
    const providerSetHash = padHex("0xaabb", { size: 32 });

    const result = await oracleLite.verifyProof(
      ALICE,
      PROOF_TYPES.COMPLIANCE,
      fakeProof,
      publicInputs,
      providerSetHash,
      0,
    );

    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.attestation).not.toBeNull();
    expect(result.attestation!.subject.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(result.publicInputs).toEqual(
      publicInputs
        .slice(2)
        .match(/.{64}/g)!
        .map((w) => `0x${w}`),
    );
  });
});

// ============================================================
// Signer registry, compliance-type policy, typed errors
// ============================================================

describe("signer registry and compliance-type policy (anvil)", () => {
  const US = 1;
  const signerPubkeyHash = keccak256(toHex("integration-signer"));
  let ownerOracle: ERC8262Oracle;
  let bobOracle: ERC8262Oracle;

  beforeAll(() => {
    const wallet = (account: Address) =>
      createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account });
    ownerOracle = new ERC8262Oracle(oracleAddress, chainClient, wallet(OWNER), foundry);
    bobOracle = new ERC8262Oracle(oracleAddress, chainClient, wallet(BOB), foundry);
  });

  it("registerSignerPubkeyHash authorizes a signer", async () => {
    expect(await ownerOracle.isValidSignerPubkeyHash(signerPubkeyHash)).toBe(false);
    await chainClient.waitForTransactionReceipt({
      hash: await ownerOracle.registerSignerPubkeyHash(signerPubkeyHash),
    });
    expect(await ownerOracle.isValidSignerPubkeyHash(signerPubkeyHash)).toBe(true);
  });

  it("decodes a role revert into a typed error", async () => {
    // NotRole was missing from ORACLE_ABI, so this decoded as UnknownRevert.
    await expect(
      withDecodedErrors(ORACLE_ABI, () =>
        chainClient.simulateContract({
          address: oracleAddress,
          abi: ORACLE_ABI,
          functionName: "registerSignerPubkeyHash",
          args: [signerPubkeyHash],
          account: BOB,
        }),
      ),
    ).rejects.toMatchObject({ errorName: "NotRole" });
  });

  it("does not report a RISK_SCORE_SIGNED attestation as compliance", async () => {
    // Review #2 PoC: "risk > 10%" under US. AlwaysPassVerifier stands in for a
    // real proof of that (true) statement.
    const { timestamp } = await chainClient.getBlock();
    const fields = [
      toHex(1), // proof_type: threshold
      toHex(1), // direction: GT
      toHex(1000), // bound_lower: 10%
      toHex(0), // bound_upper
      toHex(1), // result
      configHash,
      "0xaabb",
      toHex(timestamp), // signed timestamp: fresh
      signerPubkeyHash,
      toHex(foundry.id),
      oracleAddress,
      BOB,
    ] as Hex[];
    const publicInputs = `0x${fields.map((f) => padHex(f, { size: 32 }).slice(2)).join("")}` as Hex;

    await chainClient.waitForTransactionReceipt({
      hash: await bobOracle.submitCompliance({
        jurisdictionId: US,
        proofType: PROOF_TYPES.RISK_SCORE_SIGNED,
        proof: toHex(crypto.getRandomValues(new Uint8Array(32))),
        publicInputs,
        providerSetHash: padHex("0xaabb", { size: 32 }),
      }),
    });

    // ERC-8262 itself still says valid (meetsThreshold is hard-coded true).
    const [onChainValid] = (await chainClient.readContract({
      address: oracleAddress,
      abi: ORACLE_ABI,
      functionName: "checkCompliance",
      args: [BOB, US],
    })) as [boolean, unknown];
    expect(onChainValid).toBe(true);

    expect((await bobOracle.checkCompliance(BOB, US)).valid).toBe(false);
    expect((await oracleLite.checkCompliance(BOB, US))?.valid).toBe(false);
    expect(
      (await oracleLite.checkComplianceByType(BOB, US, PROOF_TYPES.RISK_SCORE_SIGNED))?.valid,
    ).toBe(true);
    expect(
      (
        await bobOracle.checkCompliance(BOB, US, {
          acceptedProofTypes: [PROOF_TYPES.RISK_SCORE_SIGNED],
        })
      ).valid,
    ).toBe(true);
  });

  it("revokeSignerPubkeyHash deauthorizes the signer", async () => {
    await chainClient.waitForTransactionReceipt({
      hash: await ownerOracle.revokeSignerPubkeyHash(signerPubkeyHash),
    });
    expect(await ownerOracle.isValidSignerPubkeyHash(signerPubkeyHash)).toBe(false);
  });
});

// ============================================================
// Credential roots (audit C-1 signed publication)
// ============================================================

describe("publishCredentialRoot (anvil)", () => {
  it("publishes a root signed by the registered credential signer", async () => {
    const providerId = 7n;
    const root = keccak256(toHex("credential-tree-root"));
    const cid = "bafybeigdyrztxample";
    const key = await loadSignerKey(new RawKeyLoader(new Uint8Array(32).fill(7), "credential"));

    const ownerOracle = new ERC8262Oracle(
      oracleAddress,
      chainClient,
      createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account: OWNER }),
      foundry,
    );
    const { timestamp } = await chainClient.getBlock();
    const notBefore = timestamp - 60n;
    const notAfter = timestamp + 3600n;
    const { signature, signer } = signCredentialRoot(key, {
      chainId: BigInt(foundry.id),
      oracleAddress,
      providerId,
      root,
      cid,
      notBefore,
      notAfter,
    });

    await chainClient.waitForTransactionReceipt({
      hash: await ownerOracle.setProviderPublisher(providerId, ALICE),
    });
    await chainClient.waitForTransactionReceipt({
      hash: await ownerOracle.setCredentialSigner(providerId, signer),
    });
    expect((await ownerOracle.getCredentialSigner(providerId)).toLowerCase()).toBe(signer);

    // ALICE is the publisher EOA; the signature comes from the separate signing key.
    await chainClient.waitForTransactionReceipt({
      hash: await oracleClient.publishCredentialRoot(
        providerId,
        root,
        cid,
        notBefore,
        notAfter,
        signature,
      ),
    });
    expect(await oracleClient.isValidCredentialRoot(root)).toBe(true);
    expect((await oracleClient.getCredentialRoot(root)).providerId).toBe(providerId);
  });
});
