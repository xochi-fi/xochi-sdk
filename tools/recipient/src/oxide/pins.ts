// The Oxide pins `enclave.ts` checks, in the shape pxe-bridge's `OXIDE_V6_MAINNET` has, built
// from the tool's trusted corridor record so the tool keeps one source of truth.

import type { Corridor } from "../corridor.js";

export interface OxidePins {
  l1ChainId: bigint;
  rollupVersion: bigint;
  teeRegistry: string;
  pcr0: string;
  pcr0Hash: string;
  rootCaCertHash: string;
  enclaveUrl: string;
  bridge: {
    portal: string;
    l2Token: string;
    l2TokenImmutables: { maxNoteAmount: bigint };
  };
}

export function oxidePins(corridor: Corridor): OxidePins {
  return {
    l1ChainId: BigInt(corridor.network.l1ChainId),
    rollupVersion: BigInt(corridor.network.protocolVersion),
    teeRegistry: corridor.oxide.teeRegistry,
    pcr0: corridor.oxide.pcr0,
    pcr0Hash: corridor.oxide.pcr0Hash,
    rootCaCertHash: corridor.oxide.rootCaCertHash,
    enclaveUrl: corridor.oxide.enclaveUrl,
    bridge: {
      portal: corridor.token.immutables.portal,
      l2Token: corridor.token.address,
      l2TokenImmutables: { maxNoteAmount: BigInt(corridor.token.immutables.maxNoteAmount) },
    },
  };
}
