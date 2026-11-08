// The CLI's data directory as the core's ports: one `NodeKeyValueStore` rooted at it (journals
// and state.json at today's paths), pid liveness for journal holders, the wall clock, and the
// sealed keystore as the account's key source.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod4";

import { ExitJournal } from "../core/backup.js";
import { hex32 } from "../core/corridor.js";
import { parseJsonBytes } from "../core/json.js";
import { OperationJournal, operationsLockName } from "../core/operation-journal.js";
import type { AccountSecrets, Clock, KeystoreCrypto, RecipientKeySource } from "../core/ports.js";
import { ReceiptJournal } from "../core/receipt.js";
import { StateStore } from "../core/state.js";
import { NodeKeyValueStore } from "./kv.js";
import { NodePidLockManager } from "./locks.js";

export const systemClock: Clock = { nowMs: () => Date.now() };

/**
 * The CLI's journal lock namespace. Its locks are pid liveness only (`NodePidLockManager`), which
 * is machine-wide, so the namespace does not need the recipient's address.
 */
const CLI_LOCK_NAME = operationsLockName("cli");

export interface NodeJournals {
  kv: NodeKeyValueStore;
  operations: OperationJournal;
  receipts: ReceiptJournal;
  exits: ExitJournal;
  state: StateStore;
}

export function openNodeJournals(
  dataDir: string,
  hooks: {
    afterReleaseClaimed?: (id: string) => void | Promise<void>;
    afterInitialLockSynced?: (id: string) => void | Promise<void>;
  } = {},
): NodeJournals {
  const kv = new NodeKeyValueStore(dataDir);
  const describeKey = (key: string) => kv.pathOf(key);
  return {
    kv,
    operations: new OperationJournal({
      kv,
      locks: new NodePidLockManager(),
      clock: systemClock,
      lockName: CLI_LOCK_NAME,
      holder: { pid: process.pid, host: hostname() },
      describeKey,
      ...hooks,
    }),
    receipts: new ReceiptJournal(kv, systemClock, describeKey),
    exits: new ExitJournal(kv, describeKey),
    state: new StateStore(kv),
  };
}

const SecretsSchema = z.object({ secret: hex32, salt: hex32 }).strict();

/** `keystore.sealed` opened with the operator's passphrase (asked only when the secrets are). */
export class SealedKeystoreKeySource implements RecipientKeySource {
  constructor(
    private readonly keystorePath: string,
    private readonly passphrase: () => Promise<string>,
    private readonly crypto: KeystoreCrypto,
  ) {}

  async accountSecrets(): Promise<AccountSecrets> {
    const opened = await this.crypto.open(
      "keystore",
      readFileSync(this.keystorePath),
      await this.passphrase(),
    );
    return SecretsSchema.parse(parseJsonBytes(opened));
  }
}
