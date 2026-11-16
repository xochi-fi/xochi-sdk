// The CLI compiles these sources against its own node_modules (`tools/recipient/src/core` links
// here, `preserveSymlinks`), while this package typechecks and tests against its own. So every
// package a CLI-compiled file imports must be pinned identically in both manifests; a package
// only the CLI never compiles (its tsconfig excludes `src/core/browser` and `src/core/attestation`)
// must be named in BROWSER_ONLY.

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const CLI = resolve(ROOT, "../../tools/recipient");

/** Imported only by files the CLI never compiles; each needs only this package's pin. */
const BROWSER_ONLY = new Set(["@peculiar/x509"]);

/**
 * `buffer` is the npm package in a bundle and Node's builtin in the CLI, which therefore pins
 * nothing for it.
 */
const CLI_BUILTIN = new Set(["buffer"]);

interface Manifest {
  dependencies: Record<string, string>;
}
interface TsConfig {
  exclude?: string[];
  include?: string[];
}

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The package a bare specifier names (`@scope/name/sub` -> `@scope/name`), or null. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const [first, second] = specifier.split("/");
  return first!.startsWith("@") ? `${first}/${second}` : first!;
}

function bareImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let specifier: ts.Expression | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = packageOf(specifier.text);
      const builtin = name !== null && builtinModules.includes(name) && !CLI_BUILTIN.has(name);
      if (name !== null && !builtin) found.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(found)];
}

/** Whether the CLI compiles `src/<path>`: its tsconfig, or the vendored project it references. */
function cliCompiles(path: string): boolean {
  const cliPath = `src/core/${path}`;
  const main = readJson<TsConfig>(join(CLI, "tsconfig.json"));
  const vendor = readJson<TsConfig>(join(CLI, "tsconfig.vendor.json"));
  const under = (pattern: string) => cliPath.startsWith(pattern.replace(/\/\*\*\/\*\.ts$/, "/"));
  const excluded = (main.exclude ?? []).some((dir) => cliPath.startsWith(`${dir}/`));
  return !excluded || (vendor.include ?? []).some(under);
}

function importers(): Map<string, { cli: string[]; other: string[] }> {
  const byPackage = new Map<string, { cli: string[]; other: string[] }>();
  for (const file of sourceFiles(SRC)) {
    const path = relative(SRC, file);
    for (const name of bareImports(file)) {
      const entry = byPackage.get(name) ?? { cli: [], other: [] };
      (cliCompiles(path) ? entry.cli : entry.other).push(path);
      byPackage.set(name, entry);
    }
  }
  return byPackage;
}

describe("manifest pins", () => {
  const core = readJson<Manifest>(join(ROOT, "package.json")).dependencies;
  const cli = readJson<Manifest>(join(CLI, "package.json")).dependencies;
  const byPackage = importers();

  it("reads the CLI's tsconfig excludes: browser adapters and attestation are not compiled", () => {
    expect(cliCompiles("core.ts")).toBe(true);
    expect(cliCompiles("oxide/vendor/oxide-client/capsules.ts")).toBe(true);
    expect(cliCompiles("browser/storage/indexeddb-kv-store.ts")).toBe(false);
    expect(cliCompiles("attestation/verifier.ts")).toBe(false);
  });

  it("declares every package src/ imports", () => {
    expect([...byPackage.keys()].filter((name) => core[name] === undefined)).toEqual([]);
  });

  it("pins every package a CLI-compiled file imports identically in tools/recipient", () => {
    const drift = [...byPackage]
      .filter(([name, { cli: files }]) => files.length > 0 && !CLI_BUILTIN.has(name))
      .filter(([name]) => cli[name] !== core[name])
      .map(([name]) => `${name}: core ${core[name]}, cli ${cli[name] ?? "(missing)"}`);
    expect(drift).toEqual([]);
  });

  it("allows only packages no CLI-compiled file imports as browser-only", () => {
    for (const name of BROWSER_ONLY) {
      expect(byPackage.get(name)?.cli ?? [], name).toEqual([]);
    }
    const unlisted = [...byPackage]
      .filter(([name, { cli: files }]) => files.length === 0 && !BROWSER_ONLY.has(name))
      .filter(([name]) => cli[name] !== core[name])
      .map(([name]) => name);
    expect(unlisted).toEqual([]);
  });
});
