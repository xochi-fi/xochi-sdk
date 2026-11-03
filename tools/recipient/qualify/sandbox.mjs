// Qualification harness for R1-R6 (xochi#759, spec section 15) on a LOCAL Aztec 6.0.0 sandbox
// (`qualify/docker-compose.yml`). It stages what mainnet already has and the sandbox does not,
// then drives the built CLI (`dist/cli.js`) exactly as a recipient would, and checks each step
// the way the bridge and the Worker check it. It writes `evidence.json` and prints a Markdown
// table of what it observed.
//
//   npm run build && node qualify/sandbox.mjs --node-url http://localhost:8090 \
//     --l1-rpc http://localhost:8555 --oxide-token-artifact <OxideToken.json> --out <dir>
//
// Staged on the sandbox by this harness (NOT by the tool):
//   - the OxideToken instance at the corridor's address (same class, salt 0, universal deploy,
//     the mainnet `l2TokenImmutables`, so the address equals OXDAI's), published and locked to
//     its class, from a sandbox test account, which also stands in for the Oxide sender;
//   - the sponsor's Fee Juice claim: a fresh one-time L1 EOA (funded by anvil's first account,
//     the "exchange withdrawal" of the operator procedure) calls
//     FeeJuicePortal.depositToAztecPublic for the recipient, the path the operator runs on
//     mainnet, and the claim is handed to the tool as `--fee-juice-claim`.
// What the sandbox cannot give: an enclave-signed OXDAI note (no zk.money enclave, no
// TeeRegistry registration message), so discovery of a REAL payout, `spend` and `exit` run
// here only as dry runs; those three are the operator's mainnet run (OX-18 step 4-5).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, parseEther } from "viem";
import { foundry } from "viem/chains";

import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { SchnorrAccountContract } from "@aztec-labs/accounts/schnorr";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Contract } from "@aztec-labs/aztec.js/contracts";
import { publishContractClass } from "@aztec-labs/aztec.js/deployment";
import { L1FeeJuicePortalManager } from "@aztec-labs/aztec.js/ethereum";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { createExtendedL1Client } from "@aztec-labs/ethereum/client";
import { BlockNumber } from "@aztec-labs/foundation/branded-types";
import { createLogger } from "@aztec-labs/foundation/log";
import { openEphemeralStore } from "@aztec-labs/kv-store/lmdb-v2";
import {
  AuthRegistryArtifact,
  STANDARD_AUTH_REGISTRY_ADDRESS,
} from "@aztec-labs/standard-contracts/auth-registry";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash";
import { TxHash } from "@aztec-labs/stdlib/tx";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";

import { deriveRecipientAccount } from "../dist/account.js";
import { OXDAI_MAINNET_REV2, parseCorridor } from "../dist/corridor.js";
import { loadTokenArtifact, tokenImmutables } from "../dist/oxide-token.js";
import {
  isOxideTokenLockedToArtifact,
  publishAndLockOxideTokenWithArtifact,
} from "../dist/oxide/vendor/oxide-client/token_registration.js";
import { open } from "../dist/sealed.js";

const { values: args } = parseArgs({
  options: {
    "node-url": { type: "string" },
    "l1-rpc": { type: "string" },
    "oxide-token-artifact": { type: "string" },
    "broadcaster-artifact": { type: "string" },
    out: { type: "string" },
  },
});
const need = (k) => args[k] ?? fail(`--${k} is required`);
const nodeUrl = need("node-url");
const l1Rpc = need("l1-rpc");
const artifactPath = resolve(need("oxide-token-artifact"));
const out = resolve(need("out"));
const broadcasterArtifactPath = resolve(need("broadcaster-artifact"));
mkdirSync(out, { recursive: true, mode: 0o700 });

const CLI = resolve("dist/cli.js");
const PASS = "qualification run passphrase (sandbox only)";
const evidence = { steps: [] };
const record = (id, title, facts) => {
  evidence.steps.push({ id, title, ...facts });
  console.log(
    `\n### ${id} ${title}\n${Object.entries(facts)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n")}`,
  );
};
function fail(message) {
  throw new Error(message);
}
function requireMatch(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match) fail(`${label} was not observed`);
  return match;
}
/** Runs the CLI as a recipient would; returns stdout. The passphrase goes in the environment. */
function cli(dataDir, argv) {
  const stdout = execFileSync(process.execPath, [CLI, "--data-dir", dataDir, ...argv], {
    env: { ...process.env, XOCHI_RECIPIENT_PASSPHRASE: PASS, LOG_LEVEL: "silent" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 << 20,
  });
  process.stdout.write(stdout);
  return stdout;
}

const node = createAztecNodeClient(nodeUrl);
const logger = createLogger("qualify");

// 1. The sandbox corridor record: the OXDAI rev 2 record with the sandbox's network identity
//    and a sandbox account standing in for the Oxide sender.
const info = await node.getNodeInfo();
const block1 = (await node.getBlockData(BlockNumber(1))) ?? fail("sandbox has no block 1");
const [stager] = await getInitialTestAccountsData();
const corridor = parseCorridor({
  ...OXDAI_MAINNET_REV2,
  name: "oxdai-sandbox-qualification",
  network: {
    aztecChainId: String(info.l1ChainId),
    protocolVersion: String(info.rollupVersion),
    rollupAddress: info.l1ContractAddresses.rollupAddress.toString().toLowerCase(),
    l1ChainId: String(info.l1ChainId),
    genesisOrNetworkDigest: block1.header.lastArchive.root.toString().toLowerCase(),
  },
  registeredSenders: [stager.address.toString().toLowerCase()],
});
const corridorPath = join(out, "corridor-sandbox.json");
writeFileSync(corridorPath, JSON.stringify(corridor, null, 2) + "\n");
record("S0", "sandbox corridor record", {
  node: nodeUrl,
  nodeVersion: info.nodeVersion,
  l1ChainId: info.l1ChainId,
  rollupVersion: info.rollupVersion,
  rollupAddress: corridor.network.rollupAddress,
  block1LastArchiveRoot: corridor.network.genesisOrNetworkDigest,
  registeredSenders: corridor.registeredSenders.join(","),
  corridorFile: corridorPath,
});

// 2. Stage the OxideToken instance at the corridor's address (the harness, not the tool).
const artifact = await loadTokenArtifact(artifactPath, corridor);
const token = AztecAddress.fromStringUnsafe(corridor.token.address);
const stagerWallet = await EmbeddedWallet.create(nodeUrl, {
  pxe: { proverEnabled: true, dataDirectory: join(out, "stager-pxe") },
  walletDb: { store: await openEphemeralStore("stager_wallet") },
});
await stagerWallet.createSchnorrInitializerlessAccount(
  stager.secret,
  stager.salt,
  stager.signingKey,
);
/**
 * The 6.0.0 local network's sequencer builds a block only when a transaction arrives, so an
 * L1->L2 message is included only once something else is mined. A tick is one harmless L2
 * transaction from the stager (an AuthRegistry entry under a random hash).
 */
async function tick() {
  const registry = Contract.at(STANDARD_AUTH_REGISTRY_ADDRESS, AuthRegistryArtifact, stagerWallet);
  await registry.methods["set_authorized_private"](stager.address, Fr.random(), true).send({
    from: stager.address,
  });
}
let tokenStaging;
if (await isOxideTokenLockedToArtifact(node, artifact, token)) {
  tokenStaging = "already published and locked";
} else {
  const contract = await publishAndLockOxideTokenWithArtifact(
    stagerWallet,
    artifact,
    tokenImmutables(corridor),
    stager.address,
  );
  if (!contract.address.equals(token)) fail(`staged token at ${contract.address}, not ${token}`);
  for (let i = 0; i < 30 && !(await isOxideTokenLockedToArtifact(node, artifact, token)); i++) {
    await tick();
  }
  tokenStaging = "published and locked by the harness";
}
const tokenInstance = (await node.getContract(token)) ?? fail("token instance not on the sandbox");
record("S1", "OxideToken staged on the sandbox (harness)", {
  address: token.toString(),
  classId: tokenInstance.currentContractClassId.toString(),
  lockedToArtifact: await isOxideTokenLockedToArtifact(node, artifact, token),
  how: tokenStaging,
});

// 2b. The stock SchnorrAccount 6.0.0 class is published on mainnet and testnet but not on a
//     fresh sandbox (its test accounts are the initializerless variant). The tool deploys
//     with `skipClassPublication: true` as on mainnet, so the harness publishes the class once.
const schnorrArtifact = await new SchnorrAccountContract(stager.signingKey).getContractArtifact();
const schnorrClass = await getContractClassFromArtifact(schnorrArtifact);
let classStaging = "already published";
if (!(await node.getContractClass(schnorrClass.id))) {
  await (await publishContractClass(stagerWallet, schnorrArtifact)).send({ from: stager.address });
  classStaging = "published by the harness";
}
record("S1b", "stock SchnorrAccount 6.0.0 class on the sandbox (harness)", {
  classId: schnorrClass.id.toString(),
  how: classStaging,
});

// 3. R1: the tool creates the account (sealed keystore, descriptor verified by @xochi/signer).
const dirA = join(out, "recipient-A");
const initOut = cli(dirA, ["init", "--corridor", corridorPath]);
const stateA = JSON.parse(readFileSync(join(dirA, "state.json"), "utf8"));
const recipient = AztecAddress.fromStringUnsafe(stateA.address);
const secretsA = JSON.parse(
  open("keystore", readFileSync(join(dirA, "keystore.sealed")), PASS).toString("utf8"),
);
const accountA = await deriveRecipientAccount(secretsA, corridor);
if (accountA.descriptor.classId !== schnorrClass.id.toString()) {
  fail("R1 descriptor class is not the stock SchnorrAccount 6.0.0 class");
}
record("R1", "Register: stock SchnorrAccount 6.0.0, descriptor verified", {
  address: recipient.toString(),
  classId: accountA.descriptor.classId,
  deployer: accountA.descriptor.deployer,
  keystore: `${join(dirA, "keystore.sealed")} (scrypt + AES-256-GCM)`,
  cli: initOut.trim(),
});

// 4. The sponsor: a one-time L1 EOA bridges Fee Juice for the recipient (mainnet path).
const funder = createWalletClient({
  chain: foundry,
  transport: http(l1Rpc),
  account: privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ),
});
const oneTimeKey = generatePrivateKey();
const oneTime = privateKeyToAccount(oneTimeKey);
const fundTx = await funder.sendTransaction({ to: oneTime.address, value: parseEther("1") });
const sponsor = await L1FeeJuicePortalManager.new(
  node,
  createExtendedL1Client([l1Rpc], oneTimeKey, foundry),
  logger,
);
const claim = await sponsor.bridgeTokensPublic(recipient, undefined, true);
const claimPath = join(out, "claim.json");
writeFileSync(
  claimPath,
  JSON.stringify(
    {
      claimAmount: claim.claimAmount.toString(),
      claimSecret: claim.claimSecret.toString(),
      messageLeafIndex: claim.messageLeafIndex.toString(),
    },
    null,
    2,
  ) + "\n",
);
// The message must be in the L1->L2 tree before the claim can be consumed.
for (let i = 0; i < 30; i++) {
  const witness = await node.getL1ToL2MessageMembershipWitness(
    "latest",
    Fr.fromString(claim.messageHash),
  );
  if (witness !== undefined) break;
  if (i === 29) fail("the Fee Juice message never reached the L1->L2 tree");
  await tick();
}
record("S2", "sponsor: one-time L1 EOA bridged Fee Juice for the recipient (harness)", {
  funderTx: fundTx,
  oneTimeEoa: oneTime.address,
  feeJuicePortal: info.l1ContractAddresses.feeJuicePortalAddress.toString(),
  feeAsset: info.l1ContractAddresses.feeJuiceAddress.toString(),
  claimAmount: claim.claimAmount.toString(),
  messageHash: claim.messageHash,
  messageLeafIndex: claim.messageLeafIndex.toString(),
  claimFile: claimPath,
  note: "the L1 deposit event names the one-time EOA and the recipient; nothing names Xochi",
});

// 5. R2 + R3 + R4: setup publishes and initializes the account with the sponsored claim,
//    registers the corridor senders, registers the OxideToken and stores its immutables.
const setupOut = cli(dirA, [
  "setup",
  "--node-url",
  nodeUrl,
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
  "--fee-juice-claim",
  claimPath,
]);
const deployTx = requireMatch(
  setupOut,
  /account: deployed \S+ in (0x[0-9a-f]+)/,
  "R2 deployment transaction",
)[1];
const receipt = await node.getTxReceipt(TxHash.fromString(deployTx));
const instance = (await node.getContract(recipient)) ?? fail("instance not published");
const initNullifier = await computeSiloedPrivateInitializationNullifier(
  recipient,
  instance.initializationHash,
);
const initWitness = await node.getNullifierMembershipWitness("latest", initNullifier);
const minFees = await node.getCurrentMinFees();
const feePerL2Gas = BigInt(minFees.feePerL2Gas.toString());
const l2Gas = feePerL2Gas > 0n ? (receipt.transactionFee ?? 0n) / feePerL2Gas : null;
if (!receipt.isMined()) fail(`R2 deployment receipt is not mined (${receipt.status})`);
if (initWitness === undefined) fail("R2 initialization nullifier is absent");
if (!setupOut.includes("senders: registered")) fail("R3 sender registration was not observed");
if (!setupOut.includes("token: registered")) fail("R4 token registration was not observed");
record("R2", "RecipientDeployment: instance published and initialized (sponsored)", {
  deployTx,
  block: String(receipt.blockNumber),
  status: receipt.status,
  feePayer: "the recipient account itself, from the claimed Fee Juice",
  transactionFee: `${receipt.transactionFee} (sandbox feePerL2Gas ${feePerL2Gas}, so about ${l2Gas} L2 gas)`,
  nodeGetContract: `class ${instance.currentContractClassId}`,
  initializationNullifierKnown: initWitness !== undefined,
  bridgeVerdict:
    instance && initWitness !== undefined
      ? "deployed: true (pxe-bridge aztec-client.ts)"
      : "pending",
});
record("R3", "Sender registration: registerSender for the corridor's senders", {
  cli: /senders: .*/.exec(setupOut)?.[0] ?? "(not in output)",
});
record("R4", "Oxide-aware PXE: OxideToken registered, store_immutables run", {
  cli: /token: .*/.exec(setupOut)?.[0] ?? "(not in output)",
  tokenRegisteredAt: JSON.parse(readFileSync(join(dirA, "state.json"), "utf8")).tokenRegisteredAt,
});

// 6. Balance after sync (zero: no enclave-signed note exists on the sandbox).
const balanceOut = cli(dirA, [
  "balance",
  "--node-url",
  nodeUrl,
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
]);
if (!/balance: 0(?: OXDAI| base units)/.test(balanceOut)) fail("R4 zero balance was not observed");
record("R4b", "balance after sync (the token's own handler ran; no enclave-signed note here)", {
  cli: /balance: .*/.exec(balanceOut)?.[0] ?? "(not in output)",
});

// 7. Enrollment: challenge + binding (dry-run API), the source wallet signs the binding
//    (a TEST ONLY viem key here), the TokenRegistrationAck is signed after the token
//    registration, the backup written after it carries the ack, then submit + status.
const sourceKey = generatePrivateKey();
const source = privateKeyToAccount(sourceKey);
const startOut = cli(dirA, [
  "enroll",
  "start",
  "--dry-run",
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
  "--source-wallet",
  source.address.toLowerCase(),
]);
const typed = JSON.parse(readFileSync(join(dirA, "binding-typed-data.json"), "utf8"));
const sourceSignature = await source.signTypedData({
  domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
  types: typed.types,
  primaryType: typed.primaryType,
  message: typed.message,
});
const backupA = join(out, "backup-A.bak");
const backupB = join(out, "backup-B.bak");
const backupOut = cli(dirA, ["backup", "--out", backupA, "--out", backupB]);
const commitment = /backupCommitment (0x[0-9a-f]+)/.exec(backupOut)?.[1] ?? fail("no commitment");
const submitG1 = cli(dirA, [
  "enroll",
  "submit",
  "--dry-run",
  "--corridor",
  corridorPath,
  "--source-signature",
  sourceSignature,
]);
const statusOut = cli(dirA, ["enroll", "status", "--dry-run", "--corridor", corridorPath]);
const enrollmentState = JSON.parse(readFileSync(join(dirA, "state.json"), "utf8"));
if (typeof enrollmentState.backupTokenAckSignature !== "string") {
  fail("TokenRegistrationAck was not preserved in the sealed backup state");
}
if (!submitG1.includes("acknowledgements: [BackupPersistenceAck, SenderRegistrationAck]")) {
  fail("G1 enrollment did not submit exactly the two accepted acknowledgements");
}
if (!statusOut.includes("is pending")) fail("synthetic enrollment projection was not pending");
record("E", "Enrollment request built and verified (dry-run API: no Worker on the sandbox)", {
  start: startOut
    .split("\n")
    .filter((l) => l.startsWith("enrollment:"))
    .join(" | "),
  submit: submitG1
    .split("\n")
    .filter((l) => l.includes("acknowledgements"))
    .join(" | "),
  status: statusOut.split("\n").find((l) => l.startsWith("enrollment:")) ?? "",
  backupCommitment: commitment,
  tokenRegistrationAckInBackup: "true",
});

// 8. R6: restore from the second copy into a fresh data directory (no copied wallet database).
const dirB = join(out, "recipient-B");
const restoreOut = cli(dirB, [
  "restore",
  "--backup",
  backupB,
  "--node-url",
  nodeUrl,
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
]);
const stateB = JSON.parse(readFileSync(join(dirB, "state.json"), "utf8"));
if (stateB.address !== stateA.address) fail("R6 restored a different account");
if (stateB.tokenRegisteredAt == null) fail("R6 did not re-register the token");
if (!/balance: 0(?: OXDAI| base units)/.test(restoreOut)) {
  fail("R6 restored balance was not observed");
}
record("R6", "Backup and restore on a fresh data directory", {
  backupFiles: `${backupA}, ${backupB} (${statSync(backupB).size} sealed bytes)`,
  restoredAddress: stateB.address,
  sameAccount: String(stateB.address === stateA.address),
  restoreSteps: restoreOut
    .split("\n")
    .filter((l) => /^(network|account|senders|token|balance):/.test(l))
    .join(" | "),
  tokenRegisteredAfterRestore: String(stateB.tokenRegisteredAt != null),
});

// 9. R5: spend and exit need the zk.money enclave; here only the recorded dry-run sequences.
const spendOut = cli(dirA, [
  "spend",
  "--dry-run",
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
  "--to",
  stager.address.toString(),
  "--amount",
  "1000000000000000000",
  "--l1-rpc",
  l1Rpc,
]);
if (!spendOut.includes("signTokenOperation") || !spendOut.includes("spend:")) {
  fail("R5 spend dry-run did not reach the enclave-signed submission path");
}
const r5 = {
  spendDryRun: spendOut
    .split("\n")
    .filter((l) => l.includes("[dry-run]") || l.startsWith("spend:"))
    .join(" | "),
};
const exitOut = cli(dirA, [
  "exit",
  "--dry-run",
  "--corridor",
  corridorPath,
  "--oxide-token-artifact",
  artifactPath,
  "--broadcaster-artifact",
  broadcasterArtifactPath,
  "--l1-recipient",
  oneTime.address.toLowerCase(),
  "--amount",
  "1000000000000000000",
  "--prover-tip",
  "0",
  "--relayer-tip",
  "1000000000000000",
  "--l1-rpc",
  l1Rpc,
]);
if (
  !exitOut.includes("PlainWithdrawalExecutor") ||
  !exitOut.includes("finalization request broadcast") ||
  !exitOut.includes("recipient receives")
) {
  fail("R5 exit dry-run did not reach the guarded finalization-request path");
}
r5.exitDryRun = exitOut
  .split("\n")
  .filter((l) => l.includes("[dry-run]") || l.startsWith("exit:"))
  .join(" | ");
record("R5", "Spend and exit: dry runs only here (no enclave on the sandbox)", r5);

// 10. No plaintext keys: neither data directory holds the secret key or signing key bytes.
const needles = { secret: accountA.secret.toBuffer(), signingKey: accountA.signingKey.toBuffer() };
const hits = [];
const walk = (path) => {
  for (const name of readdirSync(path)) {
    const p = join(path, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (!p.endsWith("keystore.sealed")) {
      const bytes = readFileSync(p);
      for (const [k, needle] of Object.entries(needles))
        if (bytes.includes(needle)) hits.push(`${k} in ${p}`);
    }
  }
};
walk(dirA);
walk(dirB);
record("K", "No plaintext account keys under either data directory", {
  hits: hits.length === 0 ? "none" : hits.join("; "),
  filesChecked: String(
    [dirA, dirB].reduce((n, d) => n + readdirSync(d, { recursive: true }).length, 0),
  ),
});
if (hits.length > 0) fail("plaintext key bytes found");
evidence.result = "PASS";

await stagerWallet.stop();
writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(`\nevidence written to ${join(out, "evidence.json")}`);
