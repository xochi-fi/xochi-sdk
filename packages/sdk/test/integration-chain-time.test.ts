/**
 * `chainProofTimestamp` against a chain whose clock is not the local one.
 *
 * anvil starts at FIXTURE_TIMESTAMP, years behind the wall clock, which is the
 * client-clock-ahead-of-chain case: the builders' wall-clock default dates the
 * proof after `block.timestamp` and the Oracle reverts `ProofTimestampInFuture`,
 * while a timestamp read from the chain (`chainProofTimestamp`, or the
 * `client` option of `ERC8262Prover` and `generateTierProof`) verifies and is
 * recorded. The last tests move the chain ahead of the local clock inside a
 * snapshot: under an hour ahead the local clock caps the stamp; more than an
 * hour ahead `chainProofTimestamp` refuses (`ChainAheadOfClockError`), and an
 * explicit timestamp still proves and lands.
 *
 * Requires anvil and `forge build` output in ../ERC-8262/out.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  padHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { BundledCircuitLoader } from "../src/circuits.js";
import { DEFAULT_CONFIG_HASH, JURISDICTIONS, PROOF_TYPES } from "../src/constants.js";
import { ProofTimestampInFutureError } from "../src/errors.js";
import { ERC8262Oracle } from "../src/oracle.js";
import { OracleLite } from "../src/oracle-lite.js";
import { ERC8262Prover } from "../src/prover.js";
import {
  ChainAheadOfClockError,
  chainProofTimestamp,
  DEFAULT_MAX_PROOF_AGE,
} from "../src/recency.js";
import { decodeTierProofClaim, generateTierProof } from "../src/tier-proofs.js";
import type { RiskScoreInput } from "../src/inputs/risk-score.js";

// Fixture vectors from ERC-8262's circuits/*/Prover.toml (submitter 0xdead):
// their merkle roots and tx_set_hash bind those values, not the timestamp.
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;

const ERC_8262 =
  process.env.ERC_8262_PATH ??
  resolve(new URL(".", import.meta.url).pathname, "../../../../ERC-8262");

const ANVIL_PORT = 8553;
const ANVIL_URL = `http://127.0.0.1:${String(ANVIL_PORT)}`;
const FIXTURE_TIMESTAMP = 1_700_000_000;

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
// A local account (anvil key #1), as an integrator signs: viem estimates gas
// before sending, so an Oracle revert surfaces as a typed error at submit.
const ALICE_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ALICE = ALICE_ACCOUNT.address;
const EU = JURISDICTIONS.EU;
// pedersen(provider_ids [1, 0, ...], weights [100, 0, ...]): the single-provider shorthand.
const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";

const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
const loader = new BundledCircuitLoader();
const prover = new ERC8262Prover(loader);
const chainProver = new ERC8262Prover(loader, { client: publicClient });

let anvil: ChildProcess;
let oracleAddress: Address;
let alice: ERC8262Oracle;

function loadBytecode(contractPath: string, contractName: string): Hex {
  const path = resolve(ERC_8262, `out/${contractPath}/${contractName}.json`);
  if (!existsSync(path)) {
    throw new Error(`forge artifact missing at ${path} -- run \`forge build\` in ERC-8262 first`);
  }
  const artifact: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (
    typeof artifact === "object" &&
    artifact !== null &&
    "bytecode" in artifact &&
    typeof artifact.bytecode === "object" &&
    artifact.bytecode !== null &&
    "object" in artifact.bytecode &&
    typeof artifact.bytecode.object === "string" &&
    artifact.bytecode.object.startsWith("0x")
  ) {
    return artifact.bytecode.object as Hex;
  }
  throw new Error(`forge artifact at ${path} has no bytecode.object`);
}

// anvil exposes no readiness signal to a spawner, so poll its RPC until it
// answers: the real process clock is what is being waited on.
async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("anvil did not start within 5 seconds");
}

async function deploy(bytecode: Hex, args: Hex = "0x"): Promise<Address> {
  const owner = createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account: OWNER });
  const hash = await owner.sendTransaction({
    data: `${bytecode}${args.slice(2)}` as Hex,
    chain: foundry,
    account: OWNER,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy failed");
  return receipt.contractAddress;
}

// The builders' wall-clock default applies when `timestamp` is omitted.
const RISK_SCORE_INPUT: RiskScoreInput = {
  type: "threshold",
  score: 80,
  threshold: 2499,
  direction: "gt",
  providerSetHash: PROVIDER_SET_HASH,
  submitter: ALICE,
};

beforeAll(async () => {
  // The generated verifier is a hair over EIP-170; anvil enforces it by default.
  anvil = spawn(
    "anvil",
    [
      "--port",
      String(ANVIL_PORT),
      "--silent",
      "--code-size-limit",
      "50000",
      "--timestamp",
      String(FIXTURE_TIMESTAMP),
    ],
    { stdio: "ignore" },
  );
  await waitForAnvil();

  const transcriptLib = await deploy(loadBytecode("risk_score_verifier.sol", "ZKTranscriptLib"));
  const verifierLinked = loadBytecode("risk_score_verifier.sol", "RiskScoreVerifier").replace(
    /__\$[a-fA-F0-9]{34}\$__/g,
    transcriptLib.slice(2).toLowerCase(),
  ) as Hex;
  const riskScoreVerifier = await deploy(verifierLinked);

  const router = await deploy(
    loadBytecode("ERC8262Verifier.sol", "ERC8262Verifier"),
    padHex(OWNER, { size: 32 }),
  );
  const owner = createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account: OWNER });
  await publicClient.waitForTransactionReceipt({
    hash: await owner.writeContract({
      address: router,
      abi: parseAbi(["function setVerifierInitial(uint8 proofType, address verifier) external"]),
      functionName: "setVerifierInitial",
      args: [PROOF_TYPES.RISK_SCORE, riskScoreVerifier],
      chain: foundry,
    }),
  });

  oracleAddress = await deploy(
    loadBytecode("ERC8262Oracle.sol", "ERC8262Oracle"),
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      [router, OWNER, DEFAULT_CONFIG_HASH, [1n]],
    ),
  );
  alice = new ERC8262Oracle(
    oracleAddress,
    publicClient,
    createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account: ALICE_ACCOUNT }),
    foundry,
  );
}, 120_000);

afterAll(async () => {
  await prover.destroy();
  await chainProver.destroy();
  if (anvil) anvil.kill("SIGTERM");
});

describe("chainProofTimestamp (anvil behind the local clock)", () => {
  it("returns the latest block timestamp as a decimal string", async () => {
    const timestamp = await chainProofTimestamp(publicClient);
    const latest = await publicClient.getBlock({ blockTag: "latest" });

    expect(timestamp).toBe(String(latest.timestamp));
    expect(Number(timestamp)).toBeGreaterThanOrEqual(FIXTURE_TIMESTAMP);
    expect(Number(timestamp)).toBeLessThan(Math.floor(Date.now() / 1000) - DEFAULT_MAX_PROOF_AGE);
  });

  it("the wall-clock default reverts ProofTimestampInFuture", async () => {
    const proof = await prover.proveRiskScore(RISK_SCORE_INPUT);

    await expect(
      alice.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: proof.proofHex,
        publicInputs: proof.publicInputsHex,
        providerSetHash: PROVIDER_SET_HASH,
      }),
    ).rejects.toBeInstanceOf(ProofTimestampInFutureError);
  });

  it("a RISK_SCORE proof dated by chainProofTimestamp is recorded", async () => {
    const timestamp = await chainProofTimestamp(publicClient);
    const proof = await prover.proveRiskScore({ ...RISK_SCORE_INPUT, timestamp });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: await alice.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: proof.proofHex,
        publicInputs: proof.publicInputsHex,
        providerSetHash: PROVIDER_SET_HASH,
      }),
    });
    expect(receipt.status).toBe("success");
    expect(BigInt(proof.publicInputs[7])).toBe(BigInt(timestamp));
    expect((await alice.checkComplianceByType(ALICE, EU, PROOF_TYPES.RISK_SCORE)).valid).toBe(true);
  });

  it("ERC8262Prover({ client }) dates a proof from the chain when no timestamp is given", async () => {
    const before = await chainProofTimestamp(publicClient);
    const proof = await chainProver.proveRiskScore(RISK_SCORE_INPUT);
    expect(BigInt(proof.publicInputs[7])).toBe(BigInt(before));

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: await alice.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: proof.proofHex,
        publicInputs: proof.publicInputsHex,
        providerSetHash: PROVIDER_SET_HASH,
      }),
    });
    expect(receipt.status).toBe("success");
  });

  it("generateTierProof({ client }) dates a tier proof from the chain", async () => {
    const proof = await generateTierProof(loader, 60, 50, ALICE, { client: publicClient });
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    expect(proof.timestamp).toBe(Number(latest.timestamp));

    const lite = new OracleLite({ address: oracleAddress, rpcUrl: ANVIL_URL });
    const result = await lite.verifyProof(
      ALICE,
      PROOF_TYPES.RISK_SCORE,
      proof.proofHex,
      proof.publicInputsHex,
      undefined,
      EU,
    );
    expect(result.error).toBeUndefined();
    expect(decodeTierProofClaim(result.publicInputs!, { submitter: ALICE })).toEqual({
      threshold: 50,
      timestamp: proof.timestamp,
    });
  });

  it("an explicit timestamp beats the client (generateTierProof and ERC8262Prover)", async () => {
    const stamp = Number(await chainProofTimestamp(publicClient));
    const explicit = String(stamp - 120);

    const tier = await generateTierProof(loader, 60, 50, ALICE, {
      client: publicClient,
      timestamp: explicit,
    });
    expect(tier.timestamp).toBe(Number(explicit));
    expect(BigInt(tier.publicInputs[7])).toBe(BigInt(explicit));

    const proof = await chainProver.proveRiskScore({ ...RISK_SCORE_INPUT, timestamp: explicit });
    expect(BigInt(proof.publicInputs[7])).toBe(BigInt(explicit));
  });

  describe("ERC8262Prover({ client }) dates every unsigned type from the chain", () => {
    // Each asserts the proof's timestamp public input equals the chain stamp,
    // which is years behind the local clock here.
    async function expectChainStamped(
      prove: () => Promise<{ publicInputs: string[] }>,
      timestampIndex: number,
    ): Promise<void> {
      const stamp = await chainProofTimestamp(publicClient);
      expect(Number(stamp)).toBeLessThan(Math.floor(Date.now() / 1000) - DEFAULT_MAX_PROOF_AGE);
      const proof = await prove();
      expect(BigInt(proof.publicInputs[timestampIndex])).toBe(BigInt(stamp));
    }

    it("proveCompliance (input 3)", async () => {
      await expectChainStamped(
        () =>
          chainProver.proveCompliance({
            score: 25,
            jurisdictionId: EU,
            providerSetHash: PROVIDER_SET_HASH,
            submitter: ALICE,
          }),
        3,
      );
    });

    it("proveMembership (input 2)", async () => {
      await expectChainStamped(
        () =>
          chainProver.proveMembership({
            subjectSalt: "0",
            merkleIndex: "0",
            merklePath: Array<string>(20).fill("0"),
            merkleRoot: "0x1d7de002251083fdc312a329d46abde0680cbccc27935c33815c18b1beb3da8c",
            setId: "1",
            submitter: DEAD,
          }),
        2,
      );
    });

    it("proveNonMembership (input 2)", async () => {
      await expectChainStamped(
        () =>
          chainProver.proveNonMembership({
            lowLeaf: "0x100",
            lowLeafSalt: "0",
            highLeaf: "0x10000",
            highLeafSalt: "0",
            lowIndex: "0",
            lowPath: [
              "0x2e3a62a21fa1706df17be5649ad62e45a4dbdbe9a9ce3923058d940cdc6b929d",
              ...Array<string>(19).fill("0"),
            ],
            highIndex: "1",
            highPath: [
              "0x0c57a3ac2ba9abef99b6ab714e307311687782f270b6517717e181e5cd50cce5",
              ...Array<string>(19).fill("0"),
            ],
            merkleRoot: "0x138f818fd4f2eec91e4fd93e14bcc47bc06a3ba333e5a2e7795d0beb752d247c",
            setId: "1",
            submitter: DEAD,
          }),
        2,
      );
    });

    it("provePattern (input 7)", async () => {
      await expectChainStamped(
        () =>
          chainProver.provePattern({
            amounts: [500, 1200, 3000, 7500],
            timestamps: [1699990000, 1699991000, 1699992000, 1699993000],
            numTransactions: 4,
            analysisType: 1,
            reportingThreshold: 10000,
            timeWindow: 86400,
            txSetHash: "0x2b3a892d0f3dfeb2474d341a27f3f48fbab2ae0d5a8b4ecca47ef9be42e20f56",
            submitter: DEAD,
            settlementRoot: "0x" + "0".repeat(64),
          }),
        7,
      );
    });

    it("proveAttestation (current_timestamp, input 4)", async () => {
      await expectChainStamped(
        () =>
          chainProver.proveAttestation({
            credentialAttribute: "999",
            expiryTimestamp: 2000000000,
            merkleIndex: "0",
            merklePath: Array<string>(20).fill("0"),
            providerId: "42",
            credentialType: 1,
            credentialRoot: "0x24ce58f9ed6ca066d25f66b15b0eb1dccebe6e457f5aa0fcd353d82d539f5ed5",
            submitter: DEAD,
          }),
        4,
      );
    });
  });

  it("the proofTimestamp pre-check measures against chain time, not the local clock", async () => {
    // The local clock is years ahead of anvil here. Against it, a chain-dated
    // proof reads as stale; against the latest block it is fresh.
    const timestamp = await chainProofTimestamp(publicClient);
    const proof = await prover.proveRiskScore({ ...RISK_SCORE_INPUT, timestamp });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: await alice.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: proof.proofHex,
        publicInputs: proof.publicInputsHex,
        providerSetHash: PROVIDER_SET_HASH,
        proofTimestamp: Number(timestamp),
      }),
    });
    expect(receipt.status).toBe("success");
  });

  it("the proofTimestamp pre-check refuses a proof dated after the chain head", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const proof = await prover.proveRiskScore({ ...RISK_SCORE_INPUT, timestamp });

    await expect(
      alice.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: proof.proofHex,
        publicInputs: proof.publicInputsHex,
        providerSetHash: PROVIDER_SET_HASH,
        proofTimestamp: Number(timestamp),
      }),
    ).rejects.toThrow("is in the future");
  });
});

describe("chainProofTimestamp (anvil ahead of the local clock)", () => {
  const testClient = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(ANVIL_URL),
  });

  it("caps a head less than MAX_PROOF_AGE ahead at the local clock", async () => {
    const snapshot = await testClient.snapshot();
    try {
      const ahead = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_MAX_PROOF_AGE / 2);
      await testClient.setNextBlockTimestamp({ timestamp: ahead });
      await testClient.mine({ blocks: 1 });
      expect((await publicClient.getBlock({ blockTag: "latest" })).timestamp).toBe(ahead);

      const before = Math.floor(Date.now() / 1000);
      const timestamp = Number(await chainProofTimestamp(publicClient));
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    } finally {
      await testClient.revert({ id: snapshot });
    }
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    expect(Number(latest.timestamp)).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it("refuses a head more than MAX_PROOF_AGE ahead; an explicit timestamp still lands", async () => {
    const snapshot = await testClient.snapshot();
    try {
      const ahead = BigInt(Math.floor(Date.now() / 1000) + 2 * DEFAULT_MAX_PROOF_AGE);
      await testClient.setNextBlockTimestamp({ timestamp: ahead });
      await testClient.mine({ blocks: 1 });

      const err: unknown = await chainProofTimestamp(publicClient).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChainAheadOfClockError);
      expect((err as ChainAheadOfClockError).latestBlockTimestamp).toBe(ahead);
      await expect(chainProver.proveRiskScore(RISK_SCORE_INPUT)).rejects.toBeInstanceOf(
        ChainAheadOfClockError,
      );

      // The remedy the error names: date the proof explicitly from the warped head.
      const proof = await prover.proveRiskScore({ ...RISK_SCORE_INPUT, timestamp: String(ahead) });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await alice.submitCompliance({
          jurisdictionId: EU,
          proofType: PROOF_TYPES.RISK_SCORE,
          proof: proof.proofHex,
          publicInputs: proof.publicInputsHex,
          providerSetHash: PROVIDER_SET_HASH,
        }),
      });
      expect(receipt.status).toBe("success");
    } finally {
      await testClient.revert({ id: snapshot });
    }
  });
});
