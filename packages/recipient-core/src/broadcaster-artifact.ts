// The Oxide L2 Broadcaster artifact `exit` broadcasts the withdrawal's finalization request
// through. Built from source (tools/recipient scripts/build-broadcaster.sh); refused unless its
// class is the deployment's broadcaster class. `exit` also re-reads the live instance's class on
// the pinned node before it uses the artifact (chain.ts).

import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/stdlib/abi";
import { computeArtifactHash, getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";

/**
 * Class of the deployment's l2Broadcaster (releases.json dep-v6 `l2Broadcaster`
 * 0x1baa4519...77f9): `node_getContract` current = original class, read 2026-11-03 on
 * aztec-mainnet.drpc.org. A new Broadcaster class is a new deployment, re-pinned after review.
 */
export const OXIDE_BROADCASTER_CLASS_ID =
  "0x24f2762acb13987a767a20c311d980936ed4379147c8bf6db04c193aa93778ae";
/** That class's in-protocol `artifactHash` (`node_getContractClass`, same node and day). */
export const OXIDE_BROADCASTER_ARTIFACT_HASH =
  "0x2d001a2ea588d65725e79e660e70055698b95b749be2b94d946484792c4b7d70";

/**
 * Refuses the artifact JSON unless both its artifact hash and class id are pinned. `source`
 * names it in refusals (the CLI: its file path).
 */
export async function validateBroadcasterArtifact(
  json: unknown,
  source: string,
): Promise<ContractArtifact> {
  const artifact = loadContractArtifact(json as Parameters<typeof loadContractArtifact>[0]);
  const [klass, artifactHash] = await Promise.all([
    getContractClassFromArtifact(artifact),
    computeArtifactHash(artifact),
  ]);
  if (artifactHash.toString().toLowerCase() !== OXIDE_BROADCASTER_ARTIFACT_HASH) {
    throw new Error(
      `Broadcaster artifact ${source} has artifactHash ${artifactHash.toString()}, not the deployed ${OXIDE_BROADCASTER_ARTIFACT_HASH}`,
    );
  }
  if (klass.id.toString().toLowerCase() !== OXIDE_BROADCASTER_CLASS_ID) {
    throw new Error(
      `Broadcaster artifact ${source} has class ${klass.id.toString()}, not the deployed ${OXIDE_BROADCASTER_CLASS_ID}`,
    );
  }
  return artifact;
}
