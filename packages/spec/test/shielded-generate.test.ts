// The shielded generators are the only writers of their vector files and schemas:
// `generate-shielded.ts` (shielded.json), `generate-shielded-recipient.ts`
// (shielded-recipient.json) and `generate-shielded-readiness.ts` (shielded-readiness.json,
// which reads shielded-recipient.json from the same directory). Riddler, the Worker and
// pxe-bridge vendor those bytes, so a committed file that a fresh run would not reproduce is
// a contract nobody can regenerate. The generators run into a scratch dir
// (SHIELDED_VECTORS_DIR), twice, and both runs must equal the committed files. They need
// only ethers and @zkpassport/poseidon2: no generator imports @xochi/signer.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SPEC, "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
// In run order: readiness reads the recipient file the step before it wrote.
const GENERATORS = [
  { script: "generate-shielded.ts", files: ["shielded.json", "shielded.schema.json"] },
  {
    script: "generate-shielded-recipient.ts",
    files: ["shielded-recipient.json", "shielded-recipient.schema.json"],
  },
  {
    script: "generate-shielded-readiness.ts",
    files: ["shielded-readiness.json", "shielded-readiness.schema.json"],
  },
];
const FILES = GENERATORS.flatMap((g) => g.files);

function generate(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-vectors-"));
  try {
    for (const g of GENERATORS) {
      const run = spawnSync(TSX, [`conformance/${g.script}`], {
        cwd: SPEC,
        env: { ...process.env, SHIELDED_VECTORS_DIR: dir },
        encoding: "utf8",
      });
      expect(run.status, `${g.script}: ${run.stderr}`).toBe(0);
    }
    return Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("generate-shielded*", () => {
  it("reproduces the committed vectors byte-for-byte on every run", () => {
    const first = generate();
    const second = generate();
    for (const f of FILES) {
      const committed = fs.readFileSync(path.join(SPEC, "conformance", f), "utf8");
      expect(first[f], f).toBe(committed);
      expect(second[f], f).toBe(committed);
    }
  }, 240_000);

  it("never imports @xochi/signer (the #41 rule)", () => {
    for (const g of GENERATORS) {
      const src = fs.readFileSync(path.join(SPEC, "conformance", g.script), "utf8");
      expect(src, g.script).not.toMatch(/from\s+["']@xochi\/signer["']/);
    }
  });
});
