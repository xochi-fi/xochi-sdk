// `conformance/solver-registration.json` against its own schema. The digest
// and signature values are asserted by `@xochi/solver-sdk`'s
// `registration-vectors.test.ts` and by the Riddler server, which vendors the
// file; the generator's bytes by CI's solver vector staleness check. This pins
// the shape a port reads.

import { describe, it, expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CONFORMANCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../conformance");
const load = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(CONFORMANCE, file), "utf8"));

describe("solver-registration.json", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(load("solver-registration.schema.json") as object);

  it("matches solver-registration.schema.json", () => {
    const ok = validate(load("solver-registration.json"));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("refuses a vector whose signature is not the canonical lowercase spelling", () => {
    const set = load("solver-registration.json") as {
      vectors: { expected_signature: string }[];
    };
    set.vectors[0]!.expected_signature = set.vectors[0]!.expected_signature.toUpperCase();
    expect(validate(set)).toBe(false);
  });
});
