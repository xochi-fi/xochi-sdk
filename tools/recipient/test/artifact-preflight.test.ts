import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContractArtifact } from "@aztec-labs/stdlib/abi";
import { computeArtifactHash, getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRecipientAccount } from "../src/core/account.js";
import { backupContents, sealBackup } from "../src/core/backup.js";
import { run } from "../src/cli.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "../src/core/corridor.js";
import { NodeKeystoreCrypto } from "../src/node/sealed.js";
import { TEST_SECRETS } from "./fixtures.js";

const PASS = "artifact preflight TEST ONLY";
const originalPassphrase = process.env["XOCHI_RECIPIENT_PASSPHRASE"];

interface InvalidArtifact {
  name: string;
  path: string | null;
  corridor: Corridor;
  error: RegExp;
}

function snapshot(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string, relative: string): void => {
    const stat = lstatSync(current);
    result[relative || "."] = stat.isDirectory()
      ? `directory:${stat.mode & 0o777}`
      : `file:${stat.mode & 0o777}:${readFileSync(current).toString("hex")}`;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        visit(join(current, name), relative ? join(relative, name) : name);
      }
    }
  };
  visit(path, "");
  return result;
}

async function initializeState(root: string, corridor: Corridor): Promise<string> {
  const corridorPath = join(root, "corridor.json");
  const dataDir = join(root, "recipient");
  writeFileSync(corridorPath, `${JSON.stringify(corridor)}\n`);
  await run(["init", "--data-dir", dataDir, "--corridor", corridorPath]);
  return dataDir;
}

async function invalidArtifacts(root: string): Promise<InvalidArtifact[]> {
  const accountArtifactPath = resolve(
    dirname(fileURLToPath(import.meta.resolve("@aztec-labs/accounts/schnorr"))),
    "../../artifacts/SchnorrAccount.json",
  );
  const accountArtifact = loadContractArtifact(
    JSON.parse(readFileSync(accountArtifactPath, "utf8")),
  );
  const accountArtifactHash = (await computeArtifactHash(accountArtifact)).toString().toLowerCase();
  const wrongClassCorridor: Corridor = {
    ...OXDAI_MAINNET_REV2,
    token: { ...OXDAI_MAINNET_REV2.token, artifactHash: accountArtifactHash },
  };
  const initializerlessArtifactPath = join(
    dirname(accountArtifactPath),
    "SchnorrInitializerlessAccount.json",
  );
  const initializerlessArtifact = loadContractArtifact(
    JSON.parse(readFileSync(initializerlessArtifactPath, "utf8")),
  );
  const [initializerlessHash, initializerlessClass] = await Promise.all([
    computeArtifactHash(initializerlessArtifact),
    getContractClassFromArtifact(initializerlessArtifact),
  ]);
  const wrongInstanceCorridor: Corridor = {
    ...OXDAI_MAINNET_REV2,
    token: {
      ...OXDAI_MAINNET_REV2.token,
      artifactHash: initializerlessHash.toString().toLowerCase(),
      classId: initializerlessClass.id.toString().toLowerCase(),
    },
  };
  const unreadable = join(root, "artifact-is-a-directory");
  mkdirSync(unreadable);
  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "{not-json\n");

  return [
    {
      name: "missing argument",
      path: null,
      corridor: OXDAI_MAINNET_REV2,
      error: /--oxide-token-artifact is required/,
    },
    {
      name: "missing file",
      path: join(root, "missing.json"),
      corridor: OXDAI_MAINNET_REV2,
      error: /ENOENT/,
    },
    {
      name: "unreadable file",
      path: unreadable,
      corridor: OXDAI_MAINNET_REV2,
      error: /EISDIR|illegal operation on a directory/,
    },
    {
      name: "malformed file",
      path: malformed,
      corridor: OXDAI_MAINNET_REV2,
      error: /JSON|Unexpected token|Expected property name/,
    },
    {
      name: "wrong artifact hash",
      path: accountArtifactPath,
      corridor: OXDAI_MAINNET_REV2,
      error: /artifactHash .* is not the corridor's/,
    },
    {
      name: "wrong class",
      path: accountArtifactPath,
      corridor: wrongClassCorridor,
      error: /class .* is not the corridor's/,
    },
    {
      name: "wrong derived instance",
      path: initializerlessArtifactPath,
      corridor: wrongInstanceCorridor,
      error: /corridor's immutables give .* not the token/,
    },
  ];
}

beforeAll(() => {
  process.env["XOCHI_RECIPIENT_PASSPHRASE"] = PASS;
});

afterAll(() => {
  if (originalPassphrase === undefined) delete process.env["XOCHI_RECIPIENT_PASSPHRASE"];
  else process.env["XOCHI_RECIPIENT_PASSPHRASE"] = originalPassphrase;
});

describe("OxideToken artifact preflight", () => {
  it("rejects every invalid artifact before all funded/stateful PXE command effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "xochi-artifact-preflight-"));
    try {
      const invalid = await invalidArtifacts(root);
      const commands = [
        ["setup"],
        ["balance"],
        ["spend"],
        ["exit"],
        ["enroll", "start"],
        ["receipt", "3f0c2a5e-8d7b-4e1a-9c6f-0b1d2e3f4a5b"],
      ] as const;

      for (const artifact of invalid) {
        const caseRoot = join(root, artifact.name.replaceAll(" ", "-"));
        mkdirSync(caseRoot);
        const dataDir = await initializeState(caseRoot, artifact.corridor);
        const before = snapshot(dataDir);

        for (const command of commands) {
          const commandName = command.join(" ");
          await expect(
            run([
              ...command,
              "--data-dir",
              dataDir,
              ...(artifact.path === null ? [] : ["--oxide-token-artifact", artifact.path]),
            ]),
            `${commandName}: ${artifact.name}`,
          ).rejects.toThrow(artifact.error);
          expect(snapshot(dataDir), `${commandName}: ${artifact.name}: recipient state`).toEqual(
            before,
          );
          expect(existsSync(join(dataDir, "pxe")), `${commandName}: ${artifact.name}: PXE`).toBe(
            false,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects every invalid artifact before restore creates recipient or PXE state", async () => {
    const root = mkdtempSync(join(tmpdir(), "xochi-artifact-restore-"));
    try {
      const invalid = await invalidArtifacts(root);

      for (const artifact of invalid) {
        const account = await deriveRecipientAccount(TEST_SECRETS, artifact.corridor);
        const sealed = await sealBackup(
          backupContents(artifact.corridor, TEST_SECRETS, account, null, null, 1_800_000_000),
          PASS,
          new NodeKeystoreCrypto(),
        );
        const backupPath = join(root, `${artifact.name.replaceAll(" ", "-")}.sealed`);
        const dataDir = join(root, `${artifact.name.replaceAll(" ", "-")}-restore`);
        writeFileSync(backupPath, sealed.bytes);

        await expect(
          run([
            "restore",
            "--data-dir",
            dataDir,
            "--backup",
            backupPath,
            ...(artifact.path === null ? [] : ["--oxide-token-artifact", artifact.path]),
          ]),
          `restore: ${artifact.name}`,
        ).rejects.toThrow(artifact.error);
        expect(existsSync(dataDir), `restore: ${artifact.name}: recipient/PXE state`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
