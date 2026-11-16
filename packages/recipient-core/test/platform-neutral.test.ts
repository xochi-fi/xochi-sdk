// Contract C: no Node API anywhere in `src/`. Every source file is checked (static, dynamic and
// `require` imports of `node:*` or a builtin; `process`; `Buffer` other than the `buffer`
// package's), and both entry points must bundle for the browser.
//
// The one documented exception: the vendored Oxide subset (`src/oxide/vendor`, kept byte for
// byte upstream) reads Node's *global* `Buffer`, some of it at module load. Browser builds install
// the `buffer` package as `globalThis.Buffer` first (README, VENDORED.md), and `openRecipientCore`
// refuses to run without it. It may still import no builtin and use no `process`.

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const VENDOR = join(SRC, "oxide", "vendor");
const BUILTINS = new Set(builtinModules);

/**
 * Builtins only the Aztec SDK's Node-only corners import (`@aztec-labs/accounts` ssh agent and
 * `@aztec-labs/foundation` test port allocator: `net`; `colorette`, its logger's colours: `tty`).
 * The browser bundle leaves them external; no module under `src/` may import them.
 */
const DEPENDENCY_ONLY_BUILTINS = ["net", "tty"];

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!);

interface Finding {
  file: string;
  what: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Module specifiers a file names: import/export declarations, `import x = require()`, `import()`, `require()`. */
function specifierOf(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    const [argument] = node.arguments;
    return argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed>";
  }
  return null;
}

function scan(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const name = relative(SRC, file);
  const vendored = file.startsWith(VENDOR);
  const findings: Finding[] = [];
  let importsBufferPackage = false;
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier === "buffer") importsBufferPackage = true;
    else if (specifier === "<computed>") findings.push({ file: name, what: "computed import" });
    else if (specifier !== null && isBuiltin(specifier)) {
      findings.push({ file: name, what: `imports ${specifier}` });
    }
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (node.text === "process") findings.push({ file: name, what: "uses process" });
      if (node.text === "Buffer" && !vendored && !importsBufferPackage) {
        findings.push({ file: name, what: "uses the global Buffer" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** `x.process` or `{ process: 1 }` names a property, not the global. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node)
  );
}

async function browserBundle(entry: string): Promise<Metafile> {
  const result = await build({
    entryPoints: [join(SRC, entry)],
    absWorkingDir: ROOT,
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    outdir: "out",
    external: DEPENDENCY_ONLY_BUILTINS,
  });
  return result.metafile;
}

describe("platform-neutral core", () => {
  it("names no Node API in any file under src/", () => {
    const files = sourceFiles(SRC);
    expect(files.map((file) => relative(SRC, file))).toEqual(
      expect.arrayContaining(["core.ts", "oxide/enclave.ts", "browser/index.ts"]),
    );
    expect(files.flatMap((file) => scan(file, readFileSync(file, "utf8")))).toEqual([]);
  });

  it("catches dynamic, require and computed imports, and a global Buffer", () => {
    const file = join(SRC, "probe.ts");
    expect(
      scan(
        file,
        [
          'const a = await import("node:fs");',
          'const b = require("crypto");',
          'import c = require("node:path");',
          "const d = await import(name);",
          'const e = Buffer.from("x");',
          "const f = process.env;",
          "const g = { process: 1 }.process;",
        ].join("\n"),
      ).map((finding) => finding.what),
    ).toEqual([
      "imports node:fs",
      "imports crypto",
      "imports node:path",
      "computed import",
      "uses the global Buffer",
      "uses process",
    ]);
  });

  it.each(["index.ts", "browser/index.ts"])(
    "bundles src/%s for the browser with no Node builtin from src/",
    async (entry) => {
      const metafile = await browserBundle(entry);
      const fromSrc = Object.entries(metafile.inputs).filter(([path]) => path.startsWith("src/"));
      expect(fromSrc.map(([path]) => path)).toContain(`src/${entry}`);
      expect(
        fromSrc.flatMap(([path, input]) =>
          input.imports.filter((i) => isBuiltin(i.path)).map((i) => `${path} -> ${i.path}`),
        ),
      ).toEqual([]);
      const external = new Set(
        Object.values(metafile.outputs).flatMap((output) =>
          output.imports.filter((i) => i.external).map((i) => i.path),
        ),
      );
      expect([...external].every((path) => DEPENDENCY_ONLY_BUILTINS.includes(path))).toBe(true);
    },
  );
});
