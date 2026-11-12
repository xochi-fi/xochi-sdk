// Network pinning (xochi#759): the tool refuses any node that is not the corridor's network.
// Every value is compared, and every mismatch is named, before the tool sends anything.

import type { Corridor } from "./corridor.js";

/** What the node reports, reduced to the compared values. */
export interface ObservedNetwork {
  l1ChainId: string;
  rollupVersion: string;
  rollupAddress: string;
  /** `lastArchive.root` of block 1's header: the corridor's `genesisOrNetworkDigest`. */
  block1LastArchiveRoot: string;
  nodeVersion: string;
}

export class NetworkPinRefused extends Error {
  readonly mismatches: readonly string[];
  constructor(mismatches: string[]) {
    super(`Aztec node is not the pinned network: ${mismatches.join("; ")}`);
    this.name = "NetworkPinRefused";
    this.mismatches = mismatches;
  }
}

/**
 * Throws `NetworkPinRefused` listing every member that differs. The Aztec chain id of a 6.0.0
 * network is its L1 chain id (`NodeInfo` carries no other), as Xochi and pxe-bridge map it.
 */
export function assertPinnedNetwork(observed: ObservedNetwork, corridor: Corridor): void {
  const n = corridor.network;
  const out: string[] = [];
  const check = (name: string, actual: string, expected: string) => {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      out.push(`${name} is ${actual}, pinned ${expected}`);
    }
  };
  check("l1ChainId", observed.l1ChainId, n.l1ChainId);
  check("aztecChainId (= l1ChainId)", observed.l1ChainId, n.aztecChainId);
  check("rollupVersion", observed.rollupVersion, n.protocolVersion);
  check("rollupAddress", observed.rollupAddress, n.rollupAddress);
  check("block 1 lastArchive.root", observed.block1LastArchiveRoot, n.genesisOrNetworkDigest);
  if (!/^v?6\.0\.\d+$/.test(observed.nodeVersion)) {
    out.push(`nodeVersion is ${observed.nodeVersion}, pinned 6.0.x`);
  }
  if (out.length > 0) throw new NetworkPinRefused(out);
}
