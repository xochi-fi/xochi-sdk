import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openEncryptedEphemeralWalletStore } from "../src/node/encrypted-wallet-store.js";

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? filesUnder(child) : [child];
  });
}

describe("encrypted ephemeral WalletDB", () => {
  it("round-trips account data without writing its plaintext to crash residue", async () => {
    const name = `xochi-wallet-test-${randomUUID()}`;
    const store = await openEncryptedEphemeralWalletStore(name);
    try {
      const accounts = store.openMap<string, Buffer>("accounts");
      const plaintext = Buffer.from(`recipient-account-secret-${randomUUID()}`.repeat(8));
      await accounts.set("account-0", plaintext);

      expect(await accounts.getAsync("account-0")).toEqual(plaintext);

      const directory = readdirSync(tmpdir())
        .filter((entry) => entry.startsWith(`${name}-`))
        .map((entry) => join(tmpdir(), entry));
      expect(directory).toHaveLength(1);

      for (const file of filesUnder(directory[0]!)) {
        expect(readFileSync(file).includes(plaintext)).toBe(false);
      }
    } finally {
      await store.close();
    }
  });
});
