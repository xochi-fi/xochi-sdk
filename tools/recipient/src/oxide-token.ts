// The OxideToken artifact and the token's immutables, checked against the corridor record
// before the PXE sees either. The artifact is not shipped (about 4 MB; zk.money publishes none,
// xochi#760): the recipient builds it from the Noir sources pxe-bridge vendors
// (`npm run build:oxide-token` there) or takes it from a party it trusts, and the tool refuses
// it unless its class and in-protocol artifact hash are the corridor's.

import { readFileSync } from "node:fs";
import { EthAddress } from "@aztec-labs/foundation/eth-address";
import {
  EventSelector,
  decodeFunctionSignature,
  loadContractArtifact,
  type ContractArtifact,
  type EventMetadataDefinition,
} from "@aztec-labs/stdlib/abi";
import { computeArtifactHash, getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { oxideTokenImmutablesHash } from "@xochi/signer";

import type { Corridor } from "./corridor.js";
import { predictOxideTokenInstanceWithArtifact } from "./oxide/vendor/oxide-client/token_registration.js";
import {
  computeTokenImmutablesHash,
  type OxideTokenImmutables,
} from "./oxide/vendor/oxide-lib/token_immutables.js";

export class ArtifactRefused extends Error {
  constructor(detail: string) {
    super(`OxideToken artifact refused: ${detail}`);
    this.name = "ArtifactRefused";
  }
}

/**
 * Loads the artifact and completes every offline validation before any caller may open a PXE:
 * artifact hash, class, derived instance address and immutable hash.
 */
export async function loadTokenArtifact(
  path: string,
  corridor: Corridor,
): Promise<ContractArtifact> {
  const artifact = loadContractArtifact(JSON.parse(readFileSync(path, "utf8")));
  const [klass, artifactHash] = await Promise.all([
    getContractClassFromArtifact(artifact),
    computeArtifactHash(artifact),
  ]);
  if (artifactHash.toString().toLowerCase() !== corridor.token.artifactHash) {
    throw new ArtifactRefused(
      `artifactHash ${artifactHash.toString()} is not the corridor's ${corridor.token.artifactHash}`,
    );
  }
  if (klass.id.toString().toLowerCase() !== corridor.token.classId) {
    throw new ArtifactRefused(
      `class ${klass.id.toString()} is not the corridor's ${corridor.token.classId}`,
    );
  }
  await assertTokenInstance(artifact, corridor);
  return artifact;
}

/** The corridor's `l2TokenImmutables` in the vendored client's shape. */
export function tokenImmutables(corridor: Corridor): OxideTokenImmutables {
  const i = corridor.token.immutables;
  return {
    portal: EthAddress.fromString(i.portal),
    teeRegistry: EthAddress.fromString(i.teeRegistry),
    name: i.name,
    symbol: i.symbol,
    decimals: i.decimals,
    maxNoteAmount: BigInt(i.maxNoteAmount),
  };
}

/**
 * Offline: the instance the corridor's immutables give with this artifact must be the
 * corridor's token, and the SDK's immutables hash must equal `@xochi/signer`'s (the hash the
 * `TokenRegistrationAck` names).
 */
export async function assertTokenInstance(
  artifact: ContractArtifact,
  corridor: Corridor,
): Promise<void> {
  const immutables = tokenImmutables(corridor);
  const [instance, sdkHash] = await Promise.all([
    predictOxideTokenInstanceWithArtifact(artifact, immutables),
    computeTokenImmutablesHash(immutables),
  ]);
  if (instance.address.toString().toLowerCase() !== corridor.token.address) {
    throw new ArtifactRefused(
      `the corridor's immutables give ${instance.address.toString()}, not the token ${corridor.token.address}`,
    );
  }
  if (sdkHash.toString().toLowerCase() !== oxideTokenImmutablesHash(corridor.token.immutables)) {
    throw new Error("the SDK and @xochi/signer disagree on the token immutables hash");
  }
}

/** `OxideToken::Transfer` as `getPrivateEvents` takes it, from the artifact. */
export async function transferEventMetadata(
  artifact: ContractArtifact,
): Promise<EventMetadataDefinition> {
  const struct = artifact.outputs.structs["events"]?.find(
    (e) => e.kind === "struct" && e.path.endsWith("::Transfer"),
  );
  if (!struct || struct.kind !== "struct") throw new ArtifactRefused("no Transfer event");
  // The selector is over the member types only (`Transfer((Field),(Field),u128,[Field;7])`);
  // the parameter shape wants a visibility, which does not enter the signature.
  const params = struct.fields.map((f) => ({ ...f, visibility: "private" as const }));
  return {
    eventSelector: await EventSelector.fromSignature(decodeFunctionSignature("Transfer", params)),
    abiType: struct,
    fieldNames: struct.fields.map((f) => f.name),
  };
}
