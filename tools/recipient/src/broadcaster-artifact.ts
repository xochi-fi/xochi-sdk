// The Oxide L2 Broadcaster artifact `exit` broadcasts the withdrawal's finalization request
// through. Built from source (scripts/build-broadcaster.sh); refused unless its class is the
// deployment's broadcaster class. `exit` also re-reads the live instance's class on the
// pinned node before it uses the artifact (chain.ts).

import { readFileSync } from "node:fs";
import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/stdlib/abi";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";

/**
 * Class of the deployment's l2Broadcaster (releases.json dep-v6 `l2Broadcaster`
 * 0x1baa4519...77f9): `node_getContract` current = original class, read 2026-11-03 on
 * aztec-mainnet.drpc.org. A new Broadcaster class is a new deployment, re-pinned after review.
 */
export const OXIDE_BROADCASTER_CLASS_ID =
  "0x24f2762acb13987a767a20c311d980936ed4379147c8bf6db04c193aa93778ae";

export async function loadBroadcasterArtifact(path: string): Promise<ContractArtifact> {
  const artifact = loadContractArtifact(JSON.parse(readFileSync(path, "utf8")));
  const klass = await getContractClassFromArtifact(artifact);
  if (klass.id.toString().toLowerCase() !== OXIDE_BROADCASTER_CLASS_ID) {
    throw new Error(
      `Broadcaster artifact ${path} has class ${klass.id.toString()}, not the deployed ${OXIDE_BROADCASTER_CLASS_ID}`,
    );
  }
  return artifact;
}

// `node dist/broadcaster-artifact.js <artifact>`: the build script's gate.
if (process.argv[1]?.endsWith("/broadcaster-artifact.js")) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node dist/broadcaster-artifact.js <artifact.json>\n");
    process.exit(2);
  }
  loadBroadcasterArtifact(path).then(
    () =>
      process.stdout.write(`${path}: class ${OXIDE_BROADCASTER_CLASS_ID} (deployed Broadcaster)\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
