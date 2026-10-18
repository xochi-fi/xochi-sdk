// `conformance/generate-shielded.ts` is the only writer of shielded.json and its schema.
// Riddler and the Worker vendor those bytes, so a committed file that a fresh run would
// not reproduce is a contract nobody can regenerate. The generator runs into a scratch
// dir (SHIELDED_VECTORS_DIR), twice, and both runs must equal the committed files.
// It imports @xochi/signer's build, so `npm run build -w @xochi/signer` comes first.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SPEC, "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const FILES = ["shielded.json", "shielded.schema.json"];

function generate(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-vectors-"));
  try {
    const run = spawnSync(TSX, ["conformance/generate-shielded.ts"], {
      cwd: SPEC,
      env: { ...process.env, SHIELDED_VECTORS_DIR: dir },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("generate-shielded", () => {
  it("reproduces the committed vectors byte-for-byte on every run", () => {
    const first = generate();
    const second = generate();
    for (const f of FILES) {
      const committed = fs.readFileSync(path.join(SPEC, "conformance", f), "utf8");
      expect(first[f], f).toBe(committed);
      expect(second[f], f).toBe(committed);
    }
  }, 60_000);
});
