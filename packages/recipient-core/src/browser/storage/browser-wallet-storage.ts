import { EthAddress } from "@aztec-labs/foundation/eth-address";
import { createLogger, type Logger } from "@aztec-labs/foundation/log";
import {
  AztecSQLiteOPFSStore,
  SqliteCorruptionError,
  SqliteEncryptionError,
  deletePoolDirectory,
  openTmpStore,
  storePoolDirectory,
} from "@aztec-labs/kv-store/sqlite-opfs";
import { PXE_DATA_SCHEMA_VERSION } from "@aztec-labs/pxe/client/lazy";
import { DatabaseVersion } from "@aztec-labs/stdlib/database-version/version";
import { EmbeddedWalletEncryptionError } from "@aztec-labs/wallets/embedded/store-encryption";
import type {
  EmbeddedWalletStorageOptions,
  WalletStorage,
  WalletStorageNetwork,
} from "../../wallet-storage.js";
import { assertScope } from "./scope.js";

/** A PXE store whose recorded identity is not the one in its name: a naming bug; data untouched. */
export class StoreIdentityMismatchError extends Error {
  constructor(
    readonly storeName: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Store '${storeName}' records identity ${actual} but was opened as ${expected}`);
    this.name = "StoreIdentityMismatchError";
  }
}

function rollupOf(network: WalletStorageNetwork): EthAddress {
  if (!Number.isSafeInteger(network.l1ChainId) || network.l1ChainId <= 0) {
    throw new TypeError(`invalid L1 chain id ${JSON.stringify(network.l1ChainId)}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(network.rollupAddress)) {
    throw new TypeError(`invalid rollup address ${JSON.stringify(network.rollupAddress)}`);
  }
  return EthAddress.fromString(network.rollupAddress);
}

/**
 * The persisted PXE store's name for a recipient, network and PXE schema version. Mirrors the
 * upstream browser store naming (@aztec-labs/pxe 6.0.0 `effectiveStoreName`,
 * `<name>_<l1ChainId>-<rollupAddress>-v<schemaVersion>`), so a new network, rollup or schema
 * opens a fresh store instead of reading another one's data.
 */
export function pxeStoreName(
  scope: string,
  network: WalletStorageNetwork,
  schemaVersion: number,
): string {
  assertScope(scope);
  const rollup = rollupOf(network).toString();
  return `xochi-recipient-${scope}-pxe_${network.l1ChainId}-${rollup}-v${schemaVersion}`;
}

/**
 * The browser's PXE and wallet DB.
 *
 * - The PXE store persists: one encrypted sqlite-opfs store in its own OPFS SAH pool
 *   (`storePoolDirectory(name)`), named by `pxeStoreName` and encrypted with the caller's key.
 *   On open it records, or checks, its identity like upstream `assertStoreIdentity`.
 * - The wallet DB is ephemeral: an in-memory sqlite store, so the account secret and signing key
 *   it holds never reach disk. The core re-adds the account every session, as the CLI does with its
 *   ephemeral LMDB wallet store. sqlite3mc cannot encrypt `:memory:`, and nothing of it is written.
 *
 * The returned stores belong to the EmbeddedWallet built from them (`wallet.stop()` closes both).
 * If `EmbeddedWallet.create` throws, the caller closes both stores: an open PXE store keeps its
 * OPFS pool locked, so a retry in the same tab would fail with SqlitePoolBusyError.
 */
export class BrowserWalletStorage implements WalletStorage {
  /**
   * @param pxeStoreKey returns the PXE store's 32-byte key as a fresh buffer on every call (opening
   *   transfers, so detaches, the buffer). The app passes the passkey-derived `pxeStoreKey`; it is
   *   never persisted.
   */
  constructor(private readonly pxeStoreKey: () => Promise<Uint8Array>) {}

  async embeddedWalletOptions(
    scope: string,
    network: WalletStorageNetwork,
  ): Promise<EmbeddedWalletStorageOptions> {
    const name = pxeStoreName(scope, network, PXE_DATA_SCHEMA_VERSION);
    const log = createLogger("recipient-core:wallet-storage");
    const pxeStore = await this.openPxeStore(name, log);
    try {
      await assertStoreIdentity(pxeStore, name, rollupOf(network));
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

/** Mirrors @aztec-labs/pxe 6.0.0 `assertStoreIdentity` (not exported) on the `dbVersion` singleton. */
async function assertStoreIdentity(
  store: AztecSQLiteOPFSStore,
  storeName: string,
  rollup: EthAddress,
): Promise<void> {
  const expected = new DatabaseVersion(PXE_DATA_SCHEMA_VERSION, rollup)
    .toBuffer()
    .toString("utf-8");
  const singleton = store.openSingleton<string>("dbVersion");
  const stored = await singleton.getAsync();
  if (stored === undefined) {
    await singleton.set(expected);
    return;
  }
  if (stored !== expected) throw new StoreIdentityMismatchError(storeName, expected, stored);
}
