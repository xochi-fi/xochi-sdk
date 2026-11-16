// `state.json`: what a data directory (CLI) or a browser profile records about its recipient:
// the corridor and address, the backup commitment, the enrollment in progress and the binding
// it produced, and when the token was registered. Never a key. The CLI's flags it saved
// (`nodeUrl`, `oxideTokenArtifact`) are part of the record so its file opens unchanged.

import { z } from "zod4";

import { SignedAckSchema } from "./backup.js";
import { CorridorSchema, decimal, evm, hex32 } from "./corridor.js";
import { parseJsonBytes, prettyJsonBytes } from "./json.js";
import type { KeyValueStore } from "./ports.js";

const BindingSchema = z
  .object({
    sourceWallet: evm,
    sourceChainId: decimal,
    aztecRecipient: hex32,
    aztecToken: hex32,
    descriptorDigest: hex32,
    corridorId: hex32,
    corridorRevision: decimal,
    manifestDigest: hex32,
    nonce: hex32,
    challengeExpiry: decimal,
    purpose: z.string(),
  })
  .strict();

export const StateSchema = z
  .object({
    corridor: CorridorSchema,
    address: hex32,
    backupCommitment: hex32.optional(),
    pending: z
      .object({
        challenge: z
          .object({ challenge_id: z.string(), nonce: z.string(), expires_at: z.number().int() })
          .strict(),
        binding: BindingSchema,
        tokenRegistrationAck: SignedAckSchema.nullable(),
      })
      .strict()
      .optional(),
    bindingId: z.string().optional(),
    /** The RecipientBinding digest enrolled here (`enroll submit`, or restored): `receipt` pins it. */
    bindingDigest: hex32.optional(),
    /** The node URL and artifact path the last live setup, enroll start or restore used. */
    nodeUrl: z.string().min(1).optional(),
    oxideTokenArtifact: z.string().min(1).optional(),
    /** The TokenRegistrationAck signature the last backup carries, if any. */
    backupTokenAckSignature: z.string().nullable().optional(),
    /** Unix seconds of this data directory's last successful token registration. */
    tokenRegisteredAt: z.number().int().positive().optional(),
    /** Last signed TokenRegistrationAck, preserved across submit, backup and restore. */
    tokenRegistrationAck: SignedAckSchema.nullable().optional(),
  })
  .strict();
export type State = z.infer<typeof StateSchema>;

const STATE_KEY = "state.json";

export class StateStore {
  constructor(private readonly kv: KeyValueStore) {}

  /** The record, or null before `init`/`restore` (CLI) or the first open (browser). */
  async read(): Promise<State | null> {
    const bytes = await this.kv.get(STATE_KEY);
    return bytes === null ? null : StateSchema.parse(parseJsonBytes(bytes));
  }

  async write(state: State): Promise<void> {
    await this.kv.put(STATE_KEY, prettyJsonBytes(StateSchema.parse(state)));
  }
}
