// `WalletStorage` for the CLI: the durable PXE store in `<data-dir>/pxe` (0700; Aztec checks its
// network identity itself) and a WalletDB that never reaches the data directory.

import { mkdirSync } from "node:fs";

import type {
  EmbeddedWalletStorageOptions,
  WalletStorage,
  WalletStorageNetwork,
} from "../core/wallet-storage.js";
import { openEncryptedEphemeralWalletStore } from "./encrypted-wallet-store.js";

export class NodeWalletStorage implements WalletStorage {
  constructor(private readonly pxeDirectory: string) {}

  async embeddedWalletOptions(
    _scope: string,
    _network: WalletStorageNetwork,
  ): Promise<EmbeddedWalletStorageOptions> {
    mkdirSync(this.pxeDirectory, { recursive: true, mode: 0o700 });
    return {
      pxe: { dataDirectory: this.pxeDirectory },
      // Aztec 6.0.0 stores the account secret, salt and signing key in its WalletDB.
      // Keep the DB outside the durable PXE directory and encrypt every account value with
      // a random process-only key, so a crash cannot leave key bytes in temporary LMDB pages.
      // Every run restores the account from the sealed keystore.
      walletDb: { store: await openEncryptedEphemeralWalletStore() },
    };
  }
}
