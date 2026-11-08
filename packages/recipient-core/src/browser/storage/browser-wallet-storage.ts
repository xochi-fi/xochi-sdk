import { createLogger } from "@aztec-labs/foundation/log";
import { storePoolDirectory } from "@aztec-labs/kv-store/sqlite-opfs";
import type { EmbeddedWalletOptions } from "@aztec-labs/wallets/embedded";
import { openEncryptedEmbeddedStores } from "@aztec-labs/wallets/embedded/store-encryption";

/** The storage members of `EmbeddedWallet.create`'s options (@aztec-labs/wallets 6.0.0). */
export type EmbeddedWalletStorageOptions = Required<
  Pick<EmbeddedWalletOptions, "pxe" | "walletDb">
>;

const SCOPE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * The PXE and wallet stores in the browser: encrypted sqlite-opfs stores, each in its own OPFS
 * SAH pool (`storePoolDirectory(name)`), named per recipient address. The returned stores belong to
 * the EmbeddedWallet built from them; `wallet.stop()` closes both.
 */
export class BrowserWalletStorage {
  /**
   * @param encryptionKey returns the 32-byte store key as a fresh buffer on every call: each store
   *   open transfers (detaches) the buffer it is given.
   */
  constructor(private readonly encryptionKey: () => Promise<Uint8Array>) {}

  async embeddedWalletOptions(scope: string): Promise<EmbeddedWalletStorageOptions> {
    if (!SCOPE.test(scope)) {
      throw new TypeError(`invalid wallet storage scope ${JSON.stringify(scope)}`);
    }
    const pxe = `xochi-recipient-${scope}-pxe`;
    const wallet = `xochi-recipient-${scope}-wallet`;
    const { pxeStore, walletStore } = await openEncryptedEmbeddedStores(
      {
        pxe: { name: pxe, poolDirectory: storePoolDirectory(pxe) },
        wallet: { name: wallet, poolDirectory: storePoolDirectory(wallet) },
      },
      this.encryptionKey,
      createLogger("recipient-core:wallet-storage"),
    );
    return { pxe: { store: pxeStore }, walletDb: { store: walletStore } };
  }
}
