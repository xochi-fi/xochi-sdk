import { secp256k1 } from "@noble/curves/secp256k1";

const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;

export function assertValidPrivateKey(value: string, label: string): void {
  if (!PRIVATE_KEY_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid secp256k1 private key`);
  }

  const scalar = BigInt(value.startsWith("0x") ? value : "0x" + value);
  if (scalar === 0n || scalar >= secp256k1.CURVE.n) {
    throw new Error(`${label} must be a valid secp256k1 private key`);
  }
}
