import { z } from "zod";
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const mapping = z.strictObject({
  operationRef: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  escrowAddress: address,
  depositId: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .nullable(),
  creationTxHash: hash.nullable(),
  legRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
export type ProtectedMakerMapping = z.infer<typeof mapping>;
export type MakerMappingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Provider-private, distinct from public activity. No handle, account, intent, quote or error data. */
export class ProtectedMakerMappings {
  readonly #key: string;
  constructor(
    private readonly storage: MakerMappingStorage,
    wallet: string,
    private readonly escrow: string,
  ) {
    if (!address.safeParse(wallet).success || !address.safeParse(escrow).success)
      throw new Error("invalid_request");
    this.#key = `xochi:peer-maker-private:8453:${wallet.toLowerCase()}:${escrow.toLowerCase()}`;
  }
  #read(): ProtectedMakerMapping[] {
    try {
      const raw = this.storage.getItem(this.#key);
      if (!raw) return [];
      if (raw.length > 131072) throw new Error();
      const values = z.array(mapping).max(256).parse(JSON.parse(raw));
      if (
        values.some((v) => v.escrowAddress.toLowerCase() !== this.escrow.toLowerCase()) ||
        new Set(values.map((v) => v.operationRef)).size !== values.length
      )
        throw new Error();
      return values;
    } catch {
      throw new Error("peer_in_doubt");
    }
  }
  get(operationRef: string): ProtectedMakerMapping | undefined {
    return this.#read().find((v) => v.operationRef === operationRef);
  }
  put(value: ProtectedMakerMapping): void {
    try {
      const safe = mapping.parse(value);
      if (safe.escrowAddress.toLowerCase() !== this.escrow.toLowerCase()) throw new Error();
      const values = this.#read().filter((v) => v.operationRef !== safe.operationRef);
      if (values.length >= 256) throw new Error();
      this.storage.setItem(this.#key, JSON.stringify([...values, safe]));
    } catch {
      throw new Error("peer_in_doubt");
    }
  }
  remove(operationRef: string): void {
    try {
      const values = this.#read().filter((v) => v.operationRef !== operationRef);
      if (values.length) this.storage.setItem(this.#key, JSON.stringify(values));
      else this.storage.removeItem(this.#key);
    } catch {
      throw new Error("peer_in_doubt");
    }
  }
}
export function browserMakerStorage(): MakerMappingStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
