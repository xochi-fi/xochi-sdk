// Smoke check: after the tool adds an account to its PXE, neither the account's secret key nor
// its signing key may exist anywhere under the data directory: they live only in the sealed
// keystore. (The salt is not checked: it is part of the account instance the PXE registers and
// the chain publishes.) Read-only against the node you name: it syncs and registers the account
// locally; it sends no transaction.
//
//   npm run build && node scripts/smoke-no-plaintext-keys.mjs <aztec-node-url>
//
// Uses a TEST ONLY account. Exit 0 = clean, 1 = key bytes found (each hit listed).

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";

import { deriveRecipientAccount } from "../dist/core/account.js";
import { LiveAztec } from "../dist/core/chain.js";
import { OXDAI_MAINNET_REV2 } from "../dist/core/corridor.js";
import { NodeAttestationVerifier } from "../dist/node/attestation.js";
import { openNodeJournals } from "../dist/node/data-dir.js";
import { NodeWalletStorage } from "../dist/node/wallet-storage.js";

const nodeUrl = process.argv[2];
if (!nodeUrl) {
  console.error("usage: node scripts/smoke-no-plaintext-keys.mjs <aztec-node-url>");
  process.exit(2);
}
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const field = (label) =>
  `0x${(BigInt(keccak256(toHex(label))) % R).toString(16).padStart(64, "0")}`;
const secrets = {
  secret: field("xochi-recipient TEST ONLY smoke secret"),
  salt: field("xochi-recipient TEST ONLY smoke salt"),
};
const account = await deriveRecipientAccount(secrets, OXDAI_MAINNET_REV2);
const needles = {
  secret: account.secret.toBuffer(),
  signingKey: account.signingKey.toBuffer(),
};

const dir = mkdtempSync(join(tmpdir(), "xochi-recipient-smoke-"));
const port = await LiveAztec.connect({
  nodeUrl,
  walletStorage: new NodeWalletStorage(join(dir, "pxe")),
  scope: account.descriptor.aztecAddress,
  corridor: OXDAI_MAINNET_REV2,
  l1RpcUrl: null,
  journal: openNodeJournals(dir).operations,
  attestation: new NodeAttestationVerifier(),
});
try {
  await port.addAccount(account);
} finally {
  await port.close();
}

const hits = [];
const walk = (path) => {
  for (const name of readdirSync(path)) {
    const p = join(path, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const bytes = readFileSync(p);
      for (const [key, needle] of Object.entries(needles)) {
        if (bytes.includes(needle)) hits.push(`${key} in ${p}`);
      }
    }
  }
};
walk(dir);
rmSync(dir, { recursive: true, force: true });
if (hits.length > 0) {
  console.error(`FAIL: account key bytes in the data directory:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `PASS: no secret key or signing key bytes under the data directory (${account.address})`,
);
