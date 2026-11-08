// The core's import graph (from the package entry points) names no Node API: no `node:*` or
// builtin module import, and outside the unmodified vendored Oxide subset no `process` and no
// `Buffer` except the `buffer` package's. The vendored Node-only Nitro verifier stays out of it:
// the CLI injects it as its `AttestationVerifier`.

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ENTRY_POINTS = ["index.ts", "core.ts"];
const VENDOR = join(SRC, "oxide", "vendor");
const BUILTINS = new Set(builtinModules);

interface Finding {
  file: string;
  what: string;
}

function importGraph(): { files: string[]; findings: Finding[] } {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const queue = ENTRY_POINTS.map((entry) => join(SRC, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    const name = relative(SRC, file);
    const vendored = file.startsWith(VENDOR);
    let importsBufferPackage = false;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith(".")) {
          queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        } else if (specifier === "buffer") {
          importsBufferPackage = true;
        } else if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!)) {
          findings.push({ file: name, what: `imports ${specifier}` });
        }
      }
      if (
        !vendored &&
        ts.isIdentifier(node) &&
        (node.text === "process" || (node.text === "Buffer" && !importsBufferPackage))
      ) {
        findings.push({ file: name, what: `uses ${node.text}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...seen].map((file) => relative(SRC, file)).sort(), findings };
}

describe("platform-neutral core", () => {
  it("imports no Node API from its entry points", () => {
    const { files, findings } = importGraph();
    expect(files).toContain("core.ts");
    expect(files).toContain("oxide/enclave.ts");
    expect(files).not.toContain(
      "oxide/vendor/oxide-lib/attestation/nitro_attestation/verify_nitro_attestation.ts",
    );
    expect(findings).toEqual([]);
  });
});
