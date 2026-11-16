import { describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/account.js";
import { backupContents, sealBackup } from "../src/backup.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import type { KeystoreCrypto } from "../src/ports.js";
import { NOW, TEST_SECRETS } from "./support/recipient.js";

describe("sealBackup", () => {
  it("refuses a passphrase shorter than 12 characters before sealing, as the CLI does", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const contents = backupContents(OXDAI_MAINNET_REV2, TEST_SECRETS, account, null, null, NOW);
    const sealed: string[] = [];
    const crypto: KeystoreCrypto = {
      async seal(_kind, plaintext, passphrase) {
        sealed.push(passphrase);
        return plaintext;
      },
      async open(_kind, bytes) {
        return bytes;
      },
    };

    await expect(sealBackup(contents, "eleven char", crypto)).rejects.toThrow(
      "backup passphrase must be at least 12 characters",
    );
    expect(sealed).toEqual([]);
    await sealBackup(contents, "twelve chars", crypto);
    expect(sealed).toEqual(["twelve chars"]);
  });
});
