// `conformance/generate-shielded-terms.ts` is the only writer of shielded-terms.json and its
// schema. Riddler vendors those bytes, so a committed file a fresh run would not reproduce is a
// contract nobody can regenerate. The generator runs into a scratch dir
// (SHIELDED_TERMS_VECTORS_DIR), twice, and both runs must equal the committed files; the
// committed vectors must also satisfy the committed schema.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Ajv2020 } from "ajv/dist/2020.js";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SPEC, "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const FILES = ["shielded-terms.json", "shielded-terms.schema.json"];
const committed = (f: string) => fs.readFileSync(path.join(SPEC, "conformance", f), "utf8");

function generate(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-terms-vectors-"));
  try {
    const run = spawnSync(TSX, ["conformance/generate-shielded-terms.ts"], {
      cwd: SPEC,
      env: { ...process.env, SHIELDED_TERMS_VECTORS_DIR: dir },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("generate-shielded-terms", () => {
  it("reproduces the committed vectors byte-for-byte on every run", () => {
    const first = generate();
    const second = generate();
    for (const f of FILES) {
      expect(first[f], f).toBe(committed(f));
      expect(second[f], f).toBe(committed(f));
    }
  }, 60_000);

  it("the committed vectors satisfy the committed schema", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(committed("shielded-terms.schema.json")));
    expect(
      validate(JSON.parse(committed("shielded-terms.json"))),
      ajv.errorsText(validate.errors),
    ).toBe(true);
  });

  it("every vector has its own digest", () => {
    const { vectors } = JSON.parse(committed("shielded-terms.json")) as {
      vectors: { digest: string }[];
    };
    expect(new Set(vectors.map((v) => v.digest)).size).toBe(vectors.length);
  });
});
