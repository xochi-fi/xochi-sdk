// Refusals `wire/generate.mjs` takes about its BASELINE, driven end to end.
//
// The script writes beside itself, so it runs from a scratch tree that mirrors the repo
// layout it imports through (`packages/spec/wire/*.mjs` + `scripts/probe-lib.mjs`): the
// checked-in artifact is never touched. The baseline is the pair committed at HEAD, so
// the scratch tree is its own git repository and each case commits the prior it means.
//
// No network. Without a stub the server is an https origin nothing listens on, so a run
// that gets past the baseline checks ends INCONCLUSIVE (2) at the fetch -- which is how
// "not refused" is observed. With `serve(text)` a preloaded module replaces `fetch` and
// answers with `text`, so the BREAKING gate runs against a document of the case's
// choosing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WIRE = path.join(REPO, "packages/spec/wire");
const REAL_DOC = fs.readFileSync(path.join(WIRE, "openapi.json"), "utf8");

// Answers every fetch with the file named by WIRE_TEST_SERVED.
const STUB = `import { readFileSync } from "node:fs";
const file = process.env.WIRE_TEST_SERVED;
if (file) {
  globalThis.fetch = async () =>
    new Response(readFileSync(file), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}
`;

let root: string;
let wire: string;
let served: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wire-generate-")));
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
  fs.writeFileSync(path.join(root, "stub-fetch.mjs"), STUB);
  served = undefined;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Git confined to the scratch tree: never discovers a repository above it. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[k];
  }
  return env;
}

function git(...args: string[]) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, env: gitEnv(), encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
}

/** Write a pair into the working tree (the document's own digest, unless one is given). */
function place(text: string, digest = sha(text)) {
  fs.writeFileSync(path.join(wire, "openapi.json"), text);
  fs.writeFileSync(path.join(wire, "openapi.sha256"), `${digest}\n`);
}

/** Commit a pair as the baseline at HEAD. */
function commit(text: string, digest = sha(text)) {
  place(text, digest);
  if (!fs.existsSync(path.join(root, ".git"))) git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
}

/** Have the stubbed server answer with `text`. */
function serve(text: string) {
  served = path.join(root, "served.json");
  fs.writeFileSync(served, text);
}

function generate(...flags: string[]) {
  const env = gitEnv();
  env.RIDDLER_URL_PROD = "https://127.0.0.1:9";
  delete env.RIDDLER_SERVER;
  if (served) env.WIRE_TEST_SERVED = served;
  else delete env.WIRE_TEST_SERVED;
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.join(root, "stub-fetch.mjs")).href,
      path.join(wire, "generate.mjs"),
      "--allow-non-prod",
      ...flags,
    ],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const unchanged = (text: string, digest = sha(text)) => {
  expect(fs.readFileSync(path.join(wire, "openapi.json"), "utf8")).toBe(text);
  expect(fs.readFileSync(path.join(wire, "openapi.sha256"), "utf8")).toBe(`${digest}\n`);
};

/** The real contract with one path dropped: BREAKING against it. */
const withoutQuote = () => {
  const d = JSON.parse(REAL_DOC);
  delete d.paths["/xochi/quote"];
  return JSON.stringify(d);
};

/**
 * The real contract cut to one path: still an OpenAPI contract by
 * `unrecognisedContract`'s test, declaring almost none of the real surface.
 */
const gutted = () => {
  const d = JSON.parse(REAL_DOC);
  d.paths = { "/xochi/chains": d.paths["/xochi/chains"] };
  return JSON.stringify(d);
};

describe("generate.mjs grades against the pair committed at HEAD", () => {
  it("the real, committed pair passes the baseline checks", () => {
    commit(REAL_DOC);
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
  ])("a committed baseline %s is REFUSED (exit 4)", (_name, text) => {
    commit(text);
    const { status, out } = generate();
    expect(status, out).toBe(4);
    expect(out).toContain("not recognisably an OpenAPI contract");
    unchanged(text);
  });

  it("a committed pair that does not agree is REFUSED, with or without --first-vendoring", () => {
    const digest = "0".repeat(64);
    commit(REAL_DOC, digest);
    for (const flags of [[], ["--first-vendoring"]]) {
      const { status, out } = generate(...flags);
      expect(status, out).toBe(4);
      expect(out).toContain("does not agree");
      expect(out).not.toMatch(/say so with --first-vendoring/);
      unchanged(REAL_DOC, digest);
    }
  });

  it("--first-vendoring consents to an unrecognisable committed baseline", () => {
    commit("{}", "0".repeat(64));
    const { status, out } = generate("--first-vendoring");
    expect(status, out).toBe(2);
  });

  it("outside a git checkout there is no baseline: REFUSED unless --first-vendoring", () => {
    place(REAL_DOC);
    const refusedRun = generate();
    expect(refusedRun.status, refusedRun.out).toBe(4);
    expect(refusedRun.out).toContain("no committed baseline");
    unchanged(REAL_DOC);
    const consented = generate("--first-vendoring");
    expect(consented.status, consented.out).toBe(2);
  });

  it("an uncommitted openapi.json is no baseline", () => {
    fs.writeFileSync(path.join(root, "README"), "x");
    git("init", "-q");
    git("add", "README");
    git("commit", "-q", "-m", "init");
    place(REAL_DOC);
    const { status, out } = generate();
    expect(status, out).toBe(4);
    expect(out).toContain("not committed at HEAD");
  });
});

describe("the working tree cannot move the baseline", () => {
  // Gut the working-tree copy to a recognisable sliver and re-digest it: the pair agreed
  // with itself and with `unrecognisedContract`, so a served BREAKING change graded
  // STALE against it and installed with no flag.
  it("a gutted, re-digested working tree: a served BREAKING change is still refused", () => {
    commit(REAL_DOC);
    const sliver = gutted();
    place(sliver);
    serve(withoutQuote());
    const { status, out } = generate();
    expect(status, out).toBe(4);
    expect(out).toMatch(/path \/xochi\/quote is vendored but no longer served/);
    expect(out).toContain("differs from HEAD");
    unchanged(sliver);
  });

  // The state an interrupted refresh used to leave: the intact document beside a digest
  // that is not its own. That read as "untrusted prior", the refusal steered to
  // --first-vendoring, and the flag then dropped the BREAKING diff.
  it("a stale working-tree digest under --first-vendoring still reports BREAKING", () => {
    commit(REAL_DOC);
    const stale = "f".repeat(64);
    place(REAL_DOC, stale);
    serve(withoutQuote());
    const { status, out } = generate("--first-vendoring");
    expect(status, out).toBe(4);
    expect(out).toMatch(/1 BREAKING/);
    expect(out).toMatch(/path \/xochi\/quote is vendored but no longer served/);
    unchanged(REAL_DOC, stale);
  });

  it("--first-vendoring does not skip the diff against an intact committed baseline", () => {
    commit(REAL_DOC);
    serve(withoutQuote());
    const { status, out } = generate("--first-vendoring");
    expect(status, out).toBe(4);
    expect(out).toContain("breaks the copy committed at HEAD");
  });

  it("a served copy equal to HEAD replaces a gutted working tree", () => {
    commit(REAL_DOC);
    place(gutted());
    serve(REAL_DOC);
    const { status, out } = generate();
    expect(status, out).toBe(0);
    expect(out).toMatch(/0 BREAKING, 0 STALE/);
    unchanged(REAL_DOC);
  });
});
