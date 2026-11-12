// Where the PXE and the wallet DB live (contract C). Not in `ports.ts` because it needs the
// Aztec 6.0.0 option types. Node (the CLI): `{ pxe: { dataDirectory }, walletDb: { store } }`
// with an encrypted ephemeral LMDB wallet store. Browser: `{ pxe: { store }, walletDb: { store } }`
// from `openEncryptedEmbeddedStores`, one sqlite-opfs pool per store (`storePoolDirectory`).
// The core adds `proverEnabled: true` to `pxe` itself.

import type { EmbeddedWalletOptions } from "@aztec-labs/wallets/embedded";

/** The `pxe` and `walletDb` members of `EmbeddedWallet.create`'s options. */
export type EmbeddedWalletStorageOptions = Required<
  Pick<EmbeddedWalletOptions, "pxe" | "walletDb">
>;

/** The network the stores belong to: browser stores fold it into their names (identity check). */
export interface WalletStorageNetwork {
  l1ChainId: number;
  rollupAddress: string;
}

export interface WalletStorage {
  /**
   * `scope` names the stores of one recipient (its address); `network` is the corridor's pinned
   * network, which the node is checked against before any account is added.
   */
  embeddedWalletOptions(
    scope: string,
    network: WalletStorageNetwork,
  ): Promise<EmbeddedWalletStorageOptions>;
}
