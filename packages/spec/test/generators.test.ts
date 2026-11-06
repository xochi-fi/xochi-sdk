// Determinism of the signer-free generators: each chain runs into a scratch dir
// (SPEC_VECTORS_DIR) twice, and both runs must equal the committed files. They are
// the only writers of those files, and Riddler, the Worker and pxe-bridge vendor
// the bytes, so a committed file a fresh run does not reproduce is a contract
// nobody can regenerate. The other generators import built workspace packages and
// are checked by `npm run check:vectors`.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SPEC, "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

type Step = { script: string; files: string[] };
const pair = (stem: string) => [`${stem}.json`, `${stem}.schema.json`];

// Each chain runs in order into one dir: readiness reads the recipient file the
// step before it wrote.
const CHAINS: { name: string; steps: Step[]; timeout: number }[] = [
  {
    name: "shielded",
    timeout: 240_000,
    steps: [
      { script: "generate-shielded.ts", files: pair("shielded") },
      { script: "generate-shielded-recipient.ts", files: pair("shielded-recipient") },
      { script: "generate-shielded-readiness.ts", files: pair("shielded-readiness") },
    ],
  },
  {
    name: "shielded-terms",
    timeout: 60_000,
    steps: [{ script: "generate-shielded-terms.ts", files: pair("shielded-terms") }],
  },
];

function generate(steps: Step[]): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-vectors-"));
  try {
    for (const { script } of steps) {
      const run = spawnSync(TSX, [`conformance/${script}`], {
        cwd: SPEC,
        env: { ...process.env, SPEC_VECTORS_DIR: dir },
        encoding: "utf8",
      });
      expect(run.status, `${script}: ${run.stderr}`).toBe(0);
    }
    const files = steps.flatMap((s) => s.files);
    return Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(CHAINS)("$name generators", ({ steps, timeout }) => {
  it(
    "reproduce the committed vectors byte-for-byte on every run",
    () => {
      const first = generate(steps);
      const second = generate(steps);
      for (const f of Object.keys(first)) {
        const committed = fs.readFileSync(path.join(SPEC, "conformance", f), "utf8");
        expect(first[f], f).toBe(committed);
        expect(second[f], f).toBe(committed);
      }
    },
    timeout,
  );

  it("never import @xochi/signer, directly or through _lib.ts", () => {
    for (const script of [...steps.map((s) => s.script), "_lib.ts"]) {
      const src = fs.readFileSync(path.join(SPEC, "conformance", script), "utf8");
      expect(src, script).not.toMatch(/from\s+["']@xochi\/signer["']/);
    }
  });
});
