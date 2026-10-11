// Refusals `wire/generate.mjs` takes about the PRIOR copy, driven end to end.
//
// The script writes beside itself, so it runs from a scratch tree that mirrors the repo
// layout it imports through (`packages/spec/wire/*.mjs` + `scripts/probe-lib.mjs`): the
// checked-in artifact is never touched. The prior-copy checks run before the fetch, and
// the server is an https origin nothing listens on, so a run that gets past them ends
// INCONCLUSIVE (2) at the fetch -- which is how "not refused" is observed without a
// network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WIRE = path.join(REPO, "packages/spec/wire");
const REAL_DOC = fs.readFileSync(path.join(WIRE, "openapi.json"), "utf8");

let root: string;
let wire: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wire-generate-"));
  wire = path.join(root, "packages/spec/wire");
  fs.mkdirSync(wire, { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of ["generate.mjs", "compare.mjs", "format.mjs"]) {
    fs.copyFileSync(path.join(WIRE, f), path.join(wire, f));
  }
  fs.copyFileSync(
    path.join(REPO, "scripts/probe-lib.mjs"),
    path.join(root, "scripts/probe-lib.mjs"),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Install a prior copy and a digest (its own, unless one is given). */
function prior(text: string, digest = sha(text)) {
  fs.writeFileSync(path.join(wire, "openapi.json"), text);
  fs.writeFileSync(path.join(wire, "openapi.sha256"), `${digest}\n`);
}

function generate(...flags: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, RIDDLER_URL_PROD: "https://127.0.0.1:9" };
  delete env.RIDDLER_SERVER;
  const r = spawnSync(
    process.execPath,
    [path.join(wire, "generate.mjs"), "--allow-non-prod", ...flags],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const unchanged = (text: string, digest = sha(text)) => {
  expect(fs.readFileSync(path.join(wire, "openapi.json"), "utf8")).toBe(text);
  expect(fs.readFileSync(path.join(wire, "openapi.sha256"), "utf8")).toBe(`${digest}\n`);
};

describe("generate.mjs refuses a prior copy that is no baseline", () => {
  it("the real, self-consistent prior passes the prior checks", () => {
    prior(REAL_DOC);
    const { status, out } = generate();
    expect(status, out).toBe(2);
    unchanged(REAL_DOC);
  });

  it.each([
    ["gutted to {}", "{}"],
    ["no paths operations", JSON.stringify({ openapi: "3.0.3", paths: {}, components: {} })],
    [
      "no components",
      JSON.stringify({ openapi: "3.0.3", paths: { "/x": { get: { responses: {} } } } }),
    ],
  ])("a re-digested prior %s is REFUSED (exit 4)", (_name, text) => {
    prior(text);
    const { status, out } = generate();
    expect(status, out).toBe(4);
    expect(out).toContain("not recognisably an OpenAPI contract");
    unchanged(text);
  });

  it("a prior that does not match openapi.sha256 is REFUSED (exit 4)", () => {
    const digest = "0".repeat(64);
    prior(REAL_DOC, digest);
    const { status, out } = generate();
    expect(status, out).toBe(4);
    expect(out).toContain("does not match openapi.sha256");
    unchanged(REAL_DOC, digest);
  });

  it("--first-vendoring consents to an untrusted prior", () => {
    prior("{}", "0".repeat(64));
    const { status, out } = generate("--first-vendoring");
    expect(status, out).toBe(2);
  });
});
