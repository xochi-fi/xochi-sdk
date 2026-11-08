// `ArtifactLoader` over the files the operator names (`--oxide-token-artifact`, or the path
// state.json saved; `--broadcaster-artifact`). The loader only reads JSON: the core validates
// each artifact against its pins.

import { readFileSync } from "node:fs";
import type { ContractArtifact } from "@aztec-labs/stdlib/abi";

import { validateBroadcasterArtifact } from "../core/broadcaster-artifact.js";
import type { Corridor } from "../core/corridor.js";
import { validateTokenArtifact } from "../core/oxide-token.js";
import type { ArtifactLoader } from "../core/ports.js";

export class NodeArtifactLoader implements ArtifactLoader {
  constructor(
    private readonly paths: { tokenArtifact: string | null; broadcasterArtifact: string | null },
  ) {}

  async tokenArtifact(): Promise<unknown> {
    if (this.paths.tokenArtifact === null) throw new Error("--oxide-token-artifact is required");
    return JSON.parse(readFileSync(this.paths.tokenArtifact, "utf8"));
  }

  async broadcasterArtifact(): Promise<unknown> {
    if (this.paths.broadcasterArtifact === null) {
      throw new Error("--broadcaster-artifact is required");
    }
    return JSON.parse(readFileSync(this.paths.broadcasterArtifact, "utf8"));
  }
}

/** Reads the OxideToken artifact file and completes every offline validation of it. */
export async function loadTokenArtifact(
  path: string,
  corridor: Corridor,
): Promise<ContractArtifact> {
  const loader = new NodeArtifactLoader({ tokenArtifact: path, broadcasterArtifact: null });
  return validateTokenArtifact(await loader.tokenArtifact(), corridor);
}

/** Reads the Broadcaster artifact file and refuses it unless its hash and class are pinned. */
export async function loadBroadcasterArtifact(path: string): Promise<ContractArtifact> {
  const loader = new NodeArtifactLoader({ tokenArtifact: null, broadcasterArtifact: path });
  return validateBroadcasterArtifact(await loader.broadcasterArtifact(), path);
}
