// pxe-bridge's settlement v2 request fingerprint (`src/settlement.ts` `fingerprintLines` /
// `fingerprintTerms`), for the Oxide send only: the value an OXDAI payout's `Transfer` meta
// carries as its order fingerprint (`order-fingerprint.ts`). Riddler builds the terms from the
// signed ShieldedTermsV1 (`destination_admission.ex` `aztec_terms`), so the recipient can
// recompute the fingerprint of the payout it expects and select only that transfer. Pinned by
// the vendored `oxide.createNote` vector.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** `pxe-bridge.settlement.v2` terms of an Oxide send (`accountMode` standard, `sendMode` oxide). */
export interface OxideSettlementTerms {
  network: {
    aztecChainId: string;
    protocolVersion: string;
    rollupAddress: string;
    l1ChainId: string;
    genesisOrNetworkDigest: string;
  };
  corridor: { corridorId: string; corridorRevision: number; manifestDigest: string };
  accountMode: "standard";
  sendMode: "oxide";
  recipient: string;
  recipientDescriptorDigest: string;
  token: string;
  amount: string;
  /** Unix seconds: the terms' `settlementServiceDeadline`. */
  validUntil: number;
}

const FINGERPRINT_DOMAIN = "pxe-bridge/settlement-fingerprint/v1";

/** The fingerprint's preimage, one line per element; hex members lowercased. */
export function fingerprintLines(terms: OxideSettlementTerms): string[] {
  const { network, corridor } = terms;
  return [
    FINGERPRINT_DOMAIN,
    `network.aztecChainId=${network.aztecChainId}`,
    `network.protocolVersion=${network.protocolVersion}`,
    `network.rollupAddress=${network.rollupAddress.toLowerCase()}`,
    `network.l1ChainId=${network.l1ChainId}`,
    `network.genesisOrNetworkDigest=${network.genesisOrNetworkDigest.toLowerCase()}`,
    `corridor.corridorId=${corridor.corridorId.toLowerCase()}`,
    `corridor.corridorRevision=${corridor.corridorRevision}`,
    `corridor.manifestDigest=${corridor.manifestDigest.toLowerCase()}`,
    `accountMode=${terms.accountMode}`,
    `sendMode=${terms.sendMode}`,
    `recipient=${terms.recipient.toLowerCase()}`,
    `recipientDescriptorDigest=${terms.recipientDescriptorDigest.toLowerCase()}`,
    `token=${terms.token.toLowerCase()}`,
    `amount=${terms.amount}`,
    `validUntil=${terms.validUntil}`,
  ];
}

/** `0x` + SHA-256 of the lines joined with `\n`. */
export function fingerprintTerms(terms: OxideSettlementTerms): string {
  return `0x${bytesToHex(sha256(utf8ToBytes(fingerprintLines(terms).join("\n"))))}`;
}
