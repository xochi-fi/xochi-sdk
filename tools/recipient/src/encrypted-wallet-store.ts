// The Aztec 6.0.0 WalletDB persists account secret and signing-key bytes in its `accounts` map.
// LMDB's ephemeral mode still writes pages under the OS temporary directory until close, so a
// crash can leave plaintext. This adapter encrypts every accounts-map value before LMDB sees it.
// The random AES key exists only in this process and is zeroed on close; crash residue is ciphertext.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { AztecAsyncKVStore, AztecAsyncMap, Key } from "@aztec-labs/kv-store";
import { openEphemeralStore } from "@aztec-labs/kv-store/lmdb-v2";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

function assertWalletKey(key: Key): string {
  if (typeof key !== "string") throw new Error("wallet database account key must be a string");
  return key;
}

function assertBuffer(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("wallet database account value must be a Buffer");
  return value;
}

function aad(mapName: string, key: Key): Buffer {
  return Buffer.from(`xochi-recipient-wallet-db-v1\0${mapName}\0${assertWalletKey(key)}`, "utf8");
}

function encrypt(value: Buffer, mapName: string, mapKey: Key, encryptionKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad(mapName, mapKey));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(value: Buffer, mapName: string, mapKey: Key, encryptionKey: Buffer): Buffer {
  if (value.length < HEADER_BYTES || value[0] !== VERSION) {
    throw new Error("wallet database account value has an unknown encrypted format");
  }
  const iv = value.subarray(1, 1 + IV_BYTES);
  const tag = value.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = value.subarray(HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAAD(aad(mapName, mapKey));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptedBufferMap(
  base: AztecAsyncMap<Key, Buffer>,
  mapName: string,
  encryptionKey: Buffer,
): AztecAsyncMap<Key, Buffer> {
  return new Proxy(base, {
    get(target, property) {
      switch (property) {
        case "set":
          return (key: Key, value: Buffer) =>
            target.set(key, encrypt(assertBuffer(value), mapName, key, encryptionKey));
        case "setMany":
          return (entries: { key: Key; value: Buffer }[]) =>
            target.setMany(
              entries.map(({ key, value }) => ({
                key,
                value: encrypt(assertBuffer(value), mapName, key, encryptionKey),
              })),
            );
        case "setIfNotExists":
          return (key: Key, value: Buffer) =>
            target.setIfNotExists(key, encrypt(assertBuffer(value), mapName, key, encryptionKey));
        case "getAsync":
          return async (key: Key) => {
            const value = await target.getAsync(key);
            return value === undefined ? undefined : decrypt(value, mapName, key, encryptionKey);
          };
        case "getManyAsync":
          return async (keys: Key[]) => {
            const values = await target.getManyAsync(keys);
            return values.map((value, index) =>
              value === undefined
                ? undefined
                : decrypt(value, mapName, keys[index]!, encryptionKey),
            );
          };
        case "entriesAsync":
          return async function* (range?: Parameters<typeof target.entriesAsync>[0]) {
            for await (const [key, value] of target.entriesAsync(range)) {
              yield [key, decrypt(value, mapName, key, encryptionKey)] as [Key, Buffer];
            }
          };
        case "valuesAsync":
          return async function* (range?: Parameters<typeof target.valuesAsync>[0]) {
            for await (const [key, value] of target.entriesAsync(range)) {
              yield decrypt(value, mapName, key, encryptionKey);
            }
          };
        default: {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

/** Opens a crash-safe-at-rest WalletDB: temporary LMDB pages contain ciphertext, never keys. */
export async function openEncryptedEphemeralWalletStore(
  name = `wallet_data-${process.pid}-${randomUUID()}`,
): Promise<AztecAsyncKVStore> {
  const base = await openEphemeralStore(name);
  const encryptionKey = randomBytes(32);

  return new Proxy(base, {
    get(target, property) {
      if (property === "openMap") {
        return (mapName: string) => {
          const map = target.openMap<Key, Buffer>(mapName);
          return mapName === "accounts" ? encryptedBufferMap(map, mapName, encryptionKey) : map;
        };
      }
      if (property === "close") {
        return async () => {
          try {
            await target.close();
          } finally {
            encryptionKey.fill(0);
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AztecAsyncKVStore;
}
