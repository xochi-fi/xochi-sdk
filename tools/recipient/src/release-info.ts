import { readFileSync } from "node:fs";
import { platform as hostPlatform, release as hostRelease } from "node:os";
import { fileURLToPath } from "node:url";

import { BACKUP_FORMAT_V1_NAME } from "@xochi/signer";

import { openBackup } from "./backup.js";
import { OXDAI_MAINNET_REV2 } from "./corridor.js";

interface PackageMetadata {
  version: string;
}

export const SUPPORTED_BACKUP_FORMATS = [BACKUP_FORMAT_V1_NAME] as const;

export function packageVersion(): string {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as PackageMetadata).version;
}

export function runtimePlatform(
  platform = hostPlatform(),
  release = hostRelease(),
): "macos" | "linux" | "wsl" {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return /microsoft|wsl/i.test(release) ? "wsl" : "linux";
  throw new Error("xochi-recipient supports macOS, Linux, and WSL only");
}

export function assertSupportedRuntime(nodeVersion = process.versions.node): void {
  if (Number(nodeVersion.split(".")[0]) !== 22) {
    throw new Error("xochi-recipient requires Node.js 22.x exactly");
  }
  runtimePlatform();
}

export function diagnostics(backup?: {
  bytes: Buffer;
  passphrase: string;
}): Record<string, unknown> {
  assertSupportedRuntime();
  const result: Record<string, unknown> = {
    ok: true,
    version: packageVersion(),
    nodeMajor: 22,
    platform: runtimePlatform(),
    telemetry: false,
    hostedPage: false,
    corridorRevision: OXDAI_MAINNET_REV2.corridorRevision,
    manifestDigest: OXDAI_MAINNET_REV2.manifestDigest,
    tokenClassId: OXDAI_MAINNET_REV2.token.classId,
    tokenArtifactHash: OXDAI_MAINNET_REV2.token.artifactHash,
    backupReadFormats: [...SUPPORTED_BACKUP_FORMATS],
    backupWriteFormat: BACKUP_FORMAT_V1_NAME,
  };
  if (backup) {
    const contents = openBackup(backup.bytes, backup.passphrase);
    result.backupCompatible = SUPPORTED_BACKUP_FORMATS.includes(contents.format);
    result.backupCorridorCompatible =
      contents.corridor.corridorRevision === OXDAI_MAINNET_REV2.corridorRevision &&
      contents.corridor.manifestDigest === OXDAI_MAINNET_REV2.manifestDigest &&
      contents.token.classId === OXDAI_MAINNET_REV2.token.classId &&
      contents.token.artifactHash === OXDAI_MAINNET_REV2.token.artifactHash;
  }
  return result;
}
