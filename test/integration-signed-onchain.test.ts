/**
 * Full-stack signed-compliance integration.
 *
 * The end-to-end happy path that proves the I-1 remediation works in
 * production shape:
 *
 *   provider signing daemon  →  POST /sign
 *   xochi-sdk                →  proveComplianceSigned
 *   on-chain                 →  ComplianceSignedVerifier + XochiZKPOracle
 *
 * Steps:
 *   1. Spawn anvil with code-size limit raised (signed-circuit verifier is
 *      slightly over EIP-170's 24 KB).
 *   2. Deploy ComplianceSignedVerifier, XochiZKPVerifier router, XochiZKPOracle.
 *   3. Wire the router so proofType 0x07 routes to ComplianceSignedVerifier.
 *   4. Start the signing daemon in-process on an ephemeral port.
 *   5. Bootstrap: read the daemon's signer_pubkey_hash, register it on
 *      the oracle as REGISTRAR (owner has the role implicitly).
 *   6. As Alice: hit POST /sign for a screening bundle, generate a proof
 *      via proveComplianceSigned, submit on-chain via submitCompliance.
 *   7. Read back the attestation and confirm proofType == 0x07.
 *
 * Requires anvil + a fresh `forge build` in erc-xochi-zkp. Skipped quickly
 * if either is unavailable. ~40s on a typical laptop.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { Barretenberg } from "@aztec/bb.js";

import { BundledCircuitLoader } from "../src/circuits.js";
import { XochiProver, PROOF_TYPES } from "../src/index.js";
import {
  RawKeyLoader,
  loadSignerKey,
  MemoryReplayDb,
  bytesToHex,
  type SignerKey,
} from "../src/provider/index.js";
import { createDaemonServer, type DaemonServer } from "../daemon/src/server.js";
import { MemoryAuditSink } from "../daemon/src/audit.js";
import type { DaemonConfig } from "../daemon/src/config.js";

// ============================================================
// Locations
// ============================================================

const ERC_XOCHI_ZKP = resolve(new URL(".", import.meta.url).pathname, "../../erc-xochi-zkp");

interface LinkRefEntry {
  start: number; // byte offset
  length: number; // bytes
}
type LinkReferences = Record<string, Record<string, LinkRefEntry[]>>;

interface BytecodeArtifact {
  bytecode: { object: string; linkReferences?: LinkReferences };
}

function loadArtifact(contractPath: string, contractName: string): BytecodeArtifact {
  const path = resolve(ERC_XOCHI_ZKP, `out/${contractPath}/${contractName}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `forge artifact missing at ${path} -- run \`forge build\` in erc-xochi-zkp first`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as BytecodeArtifact;
}

function loadBytecode(contractPath: string, contractName: string): Hex {
  return loadArtifact(contractPath, contractName).bytecode.object as Hex;
}

/**
 * Replace `__$<34 hex>$__` library link placeholders in a bytecode object
 * with deployed library addresses. The link references metadata gives the
 * (start, length) offsets per library; we splice the lowercase no-prefix
 * address bytes in at those positions.
 */
function linkBytecode(bytecode: Hex, libs: Record<string, Address>): Hex {
  let raw = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  // Replace every `__$<34>$__` placeholder for libraries we know about.
  for (const [libName, addr] of Object.entries(libs)) {
    const addrLower = addr.toLowerCase().replace(/^0x/, "");
    if (addrLower.length !== 40) {
      throw new Error(`library ${libName} address has wrong length: ${addr}`);
    }
    // Solidity uses keccak256(libName)[0:17] (34 hex chars) as the placeholder
    // tag inside `__$...$__`. Foundry's artifact `linkReferences` gives byte
    // offsets directly, but we'd need the artifact to map back -- simplest is
    // a regex pass that swaps any `__$.{34}$__` whose tag is unique to one lib.
    // For our case there's exactly one library; do the global replace.
    raw = raw.replace(/__\$[a-fA-F0-9]{34}\$__/g, addrLower);
  }
  if (raw.includes("__$")) {
    throw new Error("unresolved library links remain in bytecode");
  }
  return ("0x" + raw) as Hex;
}

// ============================================================
// Setup ABIs (minimal subset)
// ============================================================

const VERIFIER_SETUP_ABI = parseAbi([
  "function setVerifierInitial(uint8 proofType, address verifier) external",
]);

const ORACLE_SETUP_ABI = parseAbi([
  "function registerSignerPubkeyHash(bytes32 signerPubkeyHash) external",
]);

const ORACLE_QUERY_ABI = parseAbi([
  "struct ComplianceAttestation { address subject; uint8 jurisdictionId; uint8 proofType; bool meetsThreshold; uint256 timestamp; uint256 expiresAt; bytes32 proofHash; bytes32 providerSetHash; bytes32 publicInputsHash; address verifierUsed; }",
  "function submitCompliance(uint8 jurisdictionId, uint8 proofType, bytes calldata proof, bytes calldata publicInputs, bytes32 providerSetHash) external returns (ComplianceAttestation memory)",
  "function checkComplianceByType(address subject, uint8 jurisdictionId, uint8 proofType) external view returns (bool valid, ComplianceAttestation memory att)",
]);

// ============================================================
// Anvil
// ============================================================

const ANVIL_PORT = 8549;
const ANVIL_URL = `http://127.0.0.1:${String(ANVIL_PORT)}`;

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

// Deterministic test signing key (NOT a secret).
const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20
const TEST_API_KEY = "onchain-test-key";

const PROVIDER_SET_HASH =
  "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2" as Hex;
const TIMESTAMP = 1700000000n;

let anvil: ChildProcess;
let oracleAddress: Address;
let verifierAddress: Address;
let signedComplianceVerifier: Address;
let configHash: Hex;

let api: Barretenberg;
let signerKey: SignerKey;
let daemonServer: DaemonServer;
let daemonUrl: string;
let prover: XochiProver;

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

beforeAll(async () => {
  // The signed-compliance verifier is ~24,640 bytes -- a hair over EIP-170.
  // Production chains accept oversize via EIP-3860/7702 settings, but anvil
  // enforces the 24,576 limit by default. Bump it for the test.
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent", "--code-size-limit", "50000"], {
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

  // The generated verifier links against ZKTranscriptLib. Deploy the library
  // first, then splice its address into the verifier bytecode placeholder.
  const transcriptLib = await deployContract(
    ownerWallet,
    publicClient,
    loadBytecode("compliance_signed_verifier.sol", "ZKTranscriptLib"),
  );

  const verifierUnlinked = loadBytecode(
    "compliance_signed_verifier.sol",
    "ComplianceSignedVerifier",
  );
  const verifierLinked = linkBytecode(verifierUnlinked, { ZKTranscriptLib: transcriptLib });
  signedComplianceVerifier = await deployContract(ownerWallet, publicClient, verifierLinked);

  // Deploy the verifier router and wire up only proofType 0x07 (the only
  // path this test exercises). Other proof types stay unset; submissions
  // for them would fail VerifierNotSet, which is the correct behavior.
  const verifierBytecode = loadBytecode("XochiZKPVerifier.sol", "XochiZKPVerifier");
  verifierAddress = await deployContract(
    ownerWallet,
    publicClient,
    verifierBytecode,
    padHex(OWNER, { size: 32 }) as Hex,
  );

  const wireHash = await ownerWallet.writeContract({
    address: verifierAddress,
    abi: VERIFIER_SETUP_ABI,
    functionName: "setVerifierInitial",
    args: [PROOF_TYPES.COMPLIANCE_SIGNED, signedComplianceVerifier],
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash: wireHash });

  // Deploy the Oracle. Register the bundled compliance config hash so the
  // Oracle accepts proofs whose `config_hash` public input matches.
  configHash = "0x18574f427f33c6c77af53be06544bd749c9a1db855599d950af61ea613df8405" as Hex;
  const oracleBytecode = loadBytecode("XochiZKPOracle.sol", "XochiZKPOracle");
  const oracleArgs = (padHex(verifierAddress, { size: 32 }) +
    padHex(OWNER, { size: 32 }).slice(2) +
    configHash.slice(2)) as Hex;
  oracleAddress = await deployContract(ownerWallet, publicClient, oracleBytecode, oracleArgs);

  // Start the signing daemon in-process.
  api = await Barretenberg.new();
  signerKey = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "onchain-integration"));
  const replayDb = new MemoryReplayDb();
  const audit = new MemoryAuditSink();
  const config: DaemonConfig = {
    host: "127.0.0.1",
    port: 0,
    signerKeyHex: "0x" + Buffer.from(TEST_PRIVATE_KEY).toString("hex"),
    apiKey: TEST_API_KEY,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    clientCaPath: undefined,
    auditLogPath: undefined,
    providerLabel: "onchain-test",
  };
  daemonServer = createDaemonServer({ api, signerKey, replayDb, audit }, config);
  const { host, port } = await daemonServer.listen();
  daemonUrl = `http://${host}:${String(port)}`;

  prover = new XochiProver(new BundledCircuitLoader());
}, 120_000);

afterAll(async () => {
  if (daemonServer) await daemonServer.close();
  if (prover) await prover.destroy();
  if (api) await api.destroy();
  if (anvil) anvil.kill("SIGTERM");
});

describe("daemon -> proveComplianceSigned -> on-chain submitCompliance", () => {
  it("lands an attestation with proofType = COMPLIANCE_SIGNED", async () => {
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

    // 1. Daemon: get its signer_pubkey_hash so we can register it on-chain.
    const pubkeyRes = await fetch(`${daemonUrl}/pubkey-hash`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(pubkeyRes.status).toBe(200);
    const { signerPubkeyHash } = (await pubkeyRes.json()) as { signerPubkeyHash: Hex };
    expect(signerPubkeyHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Cross-check: the daemon's hash must equal what `loadSignerKey` would
    // produce -- otherwise the on-chain registry would not authenticate
    // the signer this test uses.
    const expectedHash = await import("../src/provider/index.js").then((m) =>
      m.computeSignerPubkeyHash(api, signerKey.publicKeyX, signerKey.publicKeyY),
    );
    expect(signerPubkeyHash).toBe(bytesToHex(expectedHash));

    // 2. Register the signer on-chain.
    const regHash = await ownerWallet.writeContract({
      address: oracleAddress,
      abi: ORACLE_SETUP_ABI,
      functionName: "registerSignerPubkeyHash",
      args: [signerPubkeyHash],
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    // 3. Daemon: sign the screening payload for Alice.
    const signRes = await fetch(`${daemonUrl}/sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({
        providerSetHash: PROVIDER_SET_HASH,
        signals: [25, 0, 0, 0, 0, 0, 0, 0],
        weights: [100, 0, 0, 0, 0, 0, 0, 0],
        timestamp: TIMESTAMP.toString(),
        submitter: ALICE,
      }),
    });
    expect(signRes.status).toBe(200);
    const signed = (await signRes.json()) as {
      signature: Hex;
      pubkeyX: Hex;
      pubkeyY: Hex;
      signerPubkeyHash: Hex;
      payloadHash: Hex;
    };

    // 4. Generate the COMPLIANCE_SIGNED proof from the bundle.
    // Critical: the proof's `timestamp` public input must be within
    // `MAX_PROOF_AGE` (1h) of the chain's `block.timestamp`. Anvil starts
    // at the wall clock by default, so a recent timestamp matches both
    // the freshness guard and the in-circuit `validate_timestamp`.
    // The signer signed `TIMESTAMP = 1700000000` (2023), which is too old
    // for the freshness guard. Use `now` for the proof and re-sign.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const reSignRes = await fetch(`${daemonUrl}/sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({
        providerSetHash: PROVIDER_SET_HASH,
        signals: [25, 0, 0, 0, 0, 0, 0, 0],
        weights: [100, 0, 0, 0, 0, 0, 0, 0],
        timestamp: now.toString(),
        submitter: ALICE,
      }),
    });
    expect(reSignRes.status).toBe(200);
    const freshSigned = (await reSignRes.json()) as typeof signed;
    void signed; // initial sign was a sanity check; unused for the actual submission

    const proof = await prover.proveComplianceSigned({
      score: 25,
      jurisdictionId: 0, // EU (permissive)
      providerSetHash: PROVIDER_SET_HASH,
      configHash,
      submitter: ALICE,
      timestamp: now.toString(),
      signedBundle: {
        signature: hexToBytes(freshSigned.signature),
        pubkeyX: hexToBytes(freshSigned.pubkeyX),
        pubkeyY: hexToBytes(freshSigned.pubkeyY),
        signerPubkeyHash: hexToBytes(freshSigned.signerPubkeyHash),
      },
    });

    // 5. Submit on-chain as Alice. Oracle enforces submitter == msg.sender.
    const submitHash = await aliceWallet.writeContract({
      address: oracleAddress,
      abi: ORACLE_QUERY_ABI,
      functionName: "submitCompliance",
      args: [
        0, // jurisdictionId = EU
        PROOF_TYPES.COMPLIANCE_SIGNED,
        proof.proofHex,
        proof.publicInputsHex,
        PROVIDER_SET_HASH,
      ],
      chain: foundry,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
    expect(receipt.status).toBe("success");

    // 6. Read back the attestation -- must reflect the signed proof type.
    const [valid, att] = await publicClient.readContract({
      address: oracleAddress,
      abi: ORACLE_QUERY_ABI,
      functionName: "checkComplianceByType",
      args: [ALICE, 0, PROOF_TYPES.COMPLIANCE_SIGNED],
    });
    expect(valid).toBe(true);
    expect(att.subject.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(att.proofType).toBe(PROOF_TYPES.COMPLIANCE_SIGNED);
    expect(att.meetsThreshold).toBe(true);
    expect(att.providerSetHash).toBe(PROVIDER_SET_HASH);
    expect(att.verifierUsed.toLowerCase()).toBe(signedComplianceVerifier.toLowerCase());
  }, 180_000);
});

function hexToBytes(hex: Hex): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) throw new Error(`bad hex length: ${hex}`);
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
