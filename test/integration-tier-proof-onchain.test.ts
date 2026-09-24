/**
 * Tier proofs against the real RiskScoreVerifier + ERC8262Oracle on anvil.
 *
 * Covers what bb.js alone cannot: the Oracle's RISK_SCORE bound checks
 * (`_validateRiskBounds` rejects bound_lower 0 and >= 10000) accept the
 * T*100 - 1 encoding at the tier boundaries, including Institutional; and a
 * RISK_SCORE attestation, which ERC-8262's `checkCompliance` reports as valid,
 * does not read as compliance through the SDK clients (review #2, with a real
 * proof instead of a stub verifier).
 *
 * Requires anvil and `forge build` output in ../ERC-8262/out.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  padHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { BundledCircuitLoader } from "../src/circuits.js";
import { ORACLE_ABI } from "../src/abis.js";
import { DEFAULT_CONFIG_HASH, JURISDICTIONS, PROOF_TYPES } from "../src/constants.js";
import { ERC8262Oracle } from "../src/oracle.js";
import { OracleLite } from "../src/oracle-lite.js";
import {
  decodeTierProofClaim,
  generateHighestTierProof,
  generateTierProof,
  type TierProof,
} from "../src/tier-proofs.js";

const ERC_8262 = resolve(new URL(".", import.meta.url).pathname, "../../ERC-8262");

const ANVIL_PORT = 8551;
const ANVIL_URL = `http://127.0.0.1:${String(ANVIL_PORT)}`;

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const EU = JURISDICTIONS.EU;

const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
const loader = new BundledCircuitLoader();

let anvil: ChildProcess;
let oracleAddress: Address;
let lite: OracleLite;

function loadBytecode(contractPath: string, contractName: string): Hex {
  const path = resolve(ERC_8262, `out/${contractPath}/${contractName}.json`);
  if (!existsSync(path)) {
    throw new Error(`forge artifact missing at ${path} -- run \`forge build\` in ERC-8262 first`);
  }
  return (JSON.parse(readFileSync(path, "utf-8")) as { bytecode: { object: Hex } }).bytecode.object;
}

// anvil exposes no readiness signal to a spawner; poll its RPC until it answers.
async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
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

beforeAll(async () => {
  // The generated verifier is a hair over EIP-170; anvil enforces it by default.
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent", "--code-size-limit", "50000"], {
    stdio: "ignore",
  });
  await waitForAnvil();

  // The generated verifier links against ZKTranscriptLib; splice its address
  // into the `__$<34 hex>$__` placeholder (the only library it links).
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

  // Tier proofs commit to the single-provider config (weights [100, 0, ...]).
  oracleAddress = await deploy(
    loadBytecode("ERC8262Oracle.sol", "ERC8262Oracle"),
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      [router, OWNER, DEFAULT_CONFIG_HASH, [1n]],
    ),
  );
  lite = new OracleLite({ address: oracleAddress, rpcUrl: ANVIL_URL });
}, 120_000);

afterAll(() => {
  if (anvil) anvil.kill("SIGTERM");
});

describe("tier proofs on the real Oracle (anvil)", () => {
  let institutional: TierProof;

  beforeAll(async () => {
    const proof = await generateHighestTierProof(loader, 110, ALICE);
    if (!proof) throw new Error("expected an Institutional proof for score 110");
    institutional = proof;
  });

  it("accepts an Institutional proof and returns its claim", async () => {
    const result = await lite.verifyProof(
      ALICE,
      PROOF_TYPES.RISK_SCORE,
      institutional.proofHex,
      institutional.publicInputsHex,
      undefined,
      EU,
    );

    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(decodeTierProofClaim(result.publicInputs!, { submitter: ALICE })).toBe(100);
  });

  it("rejects the same proof submitted by another wallet", async () => {
    const result = await lite.verifyProof(
      BOB,
      PROOF_TYPES.RISK_SCORE,
      institutional.proofHex,
      institutional.publicInputsHex,
      undefined,
      EU,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/revert/i);
  });

  it("records a boundary Trusted proof, which the SDK does not read as compliance", async () => {
    const trusted = await generateTierProof(loader, 25, 25, BOB);
    const bob = new ERC8262Oracle(
      oracleAddress,
      publicClient,
      createWalletClient({ chain: foundry, transport: http(ANVIL_URL), account: BOB }),
      foundry,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await bob.submitCompliance({
        jurisdictionId: EU,
        proofType: PROOF_TYPES.RISK_SCORE,
        proof: trusted.proofHex,
        publicInputs: trusted.publicInputsHex,
        providerSetHash: padHex("0x00", { size: 32 }),
      }),
    });

    const [onChainValid] = (await publicClient.readContract({
      address: oracleAddress,
      abi: ORACLE_ABI,
      functionName: "checkCompliance",
      args: [BOB, EU],
    })) as [boolean, unknown];
    expect(onChainValid).toBe(true); // ERC-8262: meetsThreshold is hard-coded true

    expect((await bob.checkCompliance(BOB, EU)).valid).toBe(false);
    expect((await lite.checkCompliance(BOB, EU))?.valid).toBe(false);
    expect((await lite.checkComplianceByType(BOB, EU, PROOF_TYPES.RISK_SCORE))?.valid).toBe(true);
  });
});
