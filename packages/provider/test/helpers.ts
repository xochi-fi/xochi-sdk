/** Fixed test signing key 0x01..0x20 (NOT a secret; below the secp256k1 order). */
export const TEST_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
