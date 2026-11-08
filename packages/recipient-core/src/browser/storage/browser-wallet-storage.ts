import { createLogger, type Logger } from "@aztec-labs/foundation/log";
import {
  AztecSQLiteOPFSStore,
  SqliteCorruptionError,
  SqliteEncryptionError,
  deletePoolDirectory,
  openTmpStore,
  storePoolDirectory,
} from "@aztec-labs/kv-store/sqlite-opfs";
import type { EmbeddedWalletOptions } from "@aztec-labs/wallets/embedded";
import { EmbeddedWalletEncryptionError } from "@aztec-labs/wallets/embedded/store-encryption";
import { assertScope } from "./scope.js";

/** The storage members of `EmbeddedWallet.create`'s options (@aztec-labs/wallets 6.0.0). */
export type EmbeddedWalletStorageOptions = Required<
  Pick<EmbeddedWalletOptions, "pxe" | "walletDb">
>;

/**
 * The browser's PXE and wallet DB.
 *
 * - The PXE store persists: one encrypted sqlite-opfs store in its own OPFS SAH pool
 *   (`storePoolDirectory(name)`), named per recipient, encrypted with the caller's key.
 * - The wallet DB is ephemeral: an in-memory sqlite store, so the account secret and signing key
 *   it holds never reach disk. The core re-adds the account every session, as the CLI does with its
 *   ephemeral LMDB wallet store. sqlite3mc cannot encrypt `:memory:`, and nothing of it is written.
 *
 * The returned stores belong to the EmbeddedWallet built from them (`wallet.stop()` closes both).
 * If `EmbeddedWallet.create` throws, the caller closes both stores: an open PXE store keeps its
 * OPFS pool locked, so a retry in the same tab would fail with SqlitePoolBusyError.
 */
export class BrowserWalletStorage {
  /**
   * @param pxeStoreKey returns the PXE store's 32-byte key as a fresh buffer on every call (opening
   *   transfers, so detaches, the buffer). The app passes the passkey-derived `pxeStoreKey`; it is
   *   never persisted.
   */
  constructor(private readonly pxeStoreKey: () => Promise<Uint8Array>) {}

  async embeddedWalletOptions(scope: string): Promise<EmbeddedWalletStorageOptions> {
    assertScope(scope);
    const log = createLogger("recipient-core:wallet-storage");
    const pxeStore = await this.openPxeStore(`xochi-recipient-${scope}-pxe`, log);
    try {
      const walletStore = await openTmpStore(true);
      return { pxe: { store: pxeStore }, walletDb: { store: walletStore } };
    } catch (error) {
      await pxeStore
        .close()
        .catch((closeError: unknown) => log.error("closing the PXE store failed", closeError));
      throw error;
    }
  }

  /** As `openEncryptedEmbeddedStores` opens each store (@aztec-labs/wallets 6.0.0). */
  private async openPxeStore(name: string, log: Logger): Promise<AztecSQLiteOPFSStore> {
    const poolDirectory = storePoolDirectory(name);
    try {
      return await AztecSQLiteOPFSStore.open(
        log,
        name,
        false,
        poolDirectory,
        await this.pxeStoreKey(),
      );
    } catch (error) {
      if (error instanceof SqliteEncryptionError && error.code === "decrypt_failed") {
        throw new EmbeddedWalletEncryptionError("pxe", { cause: error });
      }
      if (!(error instanceof SqliteCorruptionError)) throw error;
      // A corrupt image never opens again; the PXE resyncs from the chain into a fresh store.
      log.warn(`PXE store ${name} is corrupt (${error.message}); wiping and reopening fresh`);
      await deletePoolDirectory(poolDirectory);
      return AztecSQLiteOPFSStore.open(log, name, false, poolDirectory, await this.pxeStoreKey());
    }
  }
}
