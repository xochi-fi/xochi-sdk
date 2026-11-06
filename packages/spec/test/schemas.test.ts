// Every committed vector file against its schema, with Ajv2020 strict. The schema is
// the file's relative `$schema`, else its `<stem>.schema.json` sibling, else the
// entry in SCHEMA_FOR. A new vector file with none of these fails here until it gets
// a schema or an UNSCHEMED entry.

import { describe, it, expect } from "vitest";
import { Ajv2020, type Options } from "ajv/dist/2020.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(SPEC, rel), "utf8"));

const SCHEMA_FOR: Record<string, string> = {
  "conformance/conformance.json": "conformance/schema.json",
};
// Validated per vector below, or schema-free by design.
const UNSCHEMED = new Set(["fee/vectors.json", "fee/schedule.json"]);
// conformance/schema.json names `quote` in a `then`-branch `required` without
// declaring it there, which strictRequired rejects; the frozen bytes stay.
const AJV_OVERRIDES: Record<string, Options> = {
  "conformance/schema.json": { strictRequired: false },
};

const compile = (schemaRel: string) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, ...AJV_OVERRIDES[schemaRel] });
  return ajv.compile(load(schemaRel) as object);
};

const vectorFiles = ["conformance", "fee", "erc8262"].flatMap((dir) =>
  fs
    .readdirSync(path.join(SPEC, dir))
    .filter((f) => f.endsWith(".json") && !f.endsWith("schema.json"))
    .map((f) => `${dir}/${f}`),
);

function schemaOf(rel: string): string | undefined {
  const doc = load(rel);
  const declared = doc && typeof doc === "object" && "$schema" in doc ? doc.$schema : undefined;
  if (typeof declared === "string" && declared.startsWith("./")) {
    return path.posix.join(path.posix.dirname(rel), declared);
  }
  const sibling = rel.replace(/\.json$/, ".schema.json");
  if (fs.existsSync(path.join(SPEC, sibling))) return sibling;
  return SCHEMA_FOR[rel];
}

describe("committed vectors satisfy their schemas", () => {
  const schemed = vectorFiles.filter((f) => !UNSCHEMED.has(f));

  it("every vector file has a schema or an UNSCHEMED entry", () => {
    expect(schemed.filter((f) => schemaOf(f) === undefined)).toEqual([]);
    expect([...UNSCHEMED].filter((f) => !vectorFiles.includes(f))).toEqual([]);
  });

  it.each(schemed)("%s", (rel) => {
    const validate = compile(schemaOf(rel)!);
    validate(load(rel));
    expect(validate.errors ?? []).toEqual([]);
  });

  it("fee/vectors.json: every expected breakdown satisfies fee/schema.json", () => {
    const validate = compile("fee/schema.json");
    for (const v of load("fee/vectors.json") as { name: string; expected: unknown }[]) {
      expect(validate(v.expected), `${v.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});
