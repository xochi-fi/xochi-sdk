// Cross-checks this SDK against the SERVED wire contract, vendored at
// `@xochi/spec/wire/openapi.json` (SPEC.md Section 3: "Source of truth:
// GET /xochi/openapi.json"). Offline and CI-safe: the file is read off disk, never
// fetched -- the vendored copy's agreement with the live document is the scheduled
// probe's job (`npm run verify:openapi`), not this suite's.
//
// Both sides of every equality below are read, never transcribed, and every case that
// cannot perform its check fails rather than silently reducing to a comparison of two
// empty sets.
//
//
// Scope here: the digest check and the parts of the served contract this repo's own
// code reads -- the fee reference (`@xochi/reference/fee`). The taker-side assertions
// (the IntentLifecycleStatus terminal partition, the quote fields, `aztec_proof`, the
// endpoints and error codes `xochi.ts` branches on) moved with that code to Riddler's
// private e2e harness, which reads the same vendored document from `@xochi/spec`.
// What this suite is NOT: an assertion against a value this repo cannot edit. The
// vendored document and its digest are both in this repo and `generate:wire` writes both,
// so the digest check below catches only an INCONSISTENT PAIR -- a hand-edited document, a
// half-finished refresh, a partial merge. A consistent lie (both files rewritten together)
// passes here by construction; only the nightly probe, which compares against the live
// producer, can catch that.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { FeeBreakdownSchema } from "../src/fee";
import { parseCapabilities, chainVmType, chainAddressFormat } from "@xochi/signer";

const require = createRequire(import.meta.url);

interface OpenApiSchema {
  enum?: string[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  description?: string;
}

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, OpenApiSchema> };
}

// Verified BEFORE the parse, over the same bytes the parse consumes: a document that
// disagrees with its own committed digest is not a contract, and reading fields off it
// would report drift (or agreement) about bytes nobody vouched for.
const DOC_PATH = require.resolve("@xochi/spec/wire/openapi.json");
const DOC_BYTES = fs.readFileSync(DOC_PATH);
const DIGEST_PATH = path.join(path.dirname(DOC_PATH), "openapi.sha256");
const expectedDigest = fs.readFileSync(DIGEST_PATH, "utf8").trim();
const actualDigest = createHash("sha256").update(DOC_BYTES).digest("hex");
if (actualDigest !== expectedDigest) {
  throw new Error(
    `vendored wire contract does not match its committed digest\n` +
      `  ${DOC_PATH}\n    sha256 ${actualDigest}\n` +
      `  ${DIGEST_PATH}\n    sha256 ${expectedDigest}\n` +
      `Neither file is hand-editable. The usual cause is a bad merge or a partial checkout, ` +
      `so restore both from git (\`git checkout -- packages/spec/wire/\`); re-run ` +
      `\`npm run generate:wire\` only if a REFRESH is what you actually want, since it ` +
      `refetches and rewrites both files.`,
  );
}

const doc = JSON.parse(DOC_BYTES.toString("utf8")) as OpenApiDoc;

// A renamed or dropped component must fail here, not read as "no properties to check".
function schema(name: string): OpenApiSchema {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`served document has no component schema \`${name}\``);
  return found;
}

function props(name: string): string[] {
  const keys = Object.keys(schema(name).properties ?? {});
  if (keys.length === 0) throw new Error(`served \`${name}\` declares no properties`);
  return keys;
}

function enumOf(name: string, ...at: string[]): string[] {
  let node = schema(name);
  for (const key of at) {
    const child = node.properties?.[key];
    if (!child) throw new Error(`served \`${name}\` declares no property \`${key}\``);
    node = child;
  }
  const values = node.enum ?? [];
  if (values.length === 0) throw new Error(`served \`${[name, ...at].join(".")}\` declares no enum`);
  return values;
}

// ---------------------------------------------------------------------------

describe("fee_breakdown wire object", () => {
  // Read from the zod schema rather than transcribed: a transcription drifts from
  // `fee.ts` independently of the server and turns this into a third opinion.
  const shape = FeeBreakdownSchema.shape;
  const sdkKeys = Object.keys(shape).sort();
  const sdkRequired = Object.entries(shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key)
    .sort();
  const servedKeys = props("LayeredFeeBreakdown").sort();
  const servedRequired = [...(schema("LayeredFeeBreakdown").required ?? [])].sort();

  it("the served schema declares a required set", () => {
    expect(servedRequired.length).toBeGreaterThan(0);
  });

  // Catches: the server drops or renames a fee layer while `fee.ts`, `fee/schema.json` and
  // `fee/vectors.json` all agree with each other -- the #92 shape, three files in one
  // commit graph. `assertFeeBreakdownInvariants` sums the layers it knows, so a renamed
  // layer reconciles to a total that no longer includes it.
  it("every served property is declared by FeeBreakdownSchema", () => {
    expect(servedKeys.filter((k) => !sdkKeys.includes(k))).toEqual([]);
  });

  // The reverse direction is not symmetric in consequence but is symmetric in evidence:
  // `FeeBreakdownSchema` is `.passthrough()`, so an undeclared key parses fine and is then
  // invisible to every reconciliation the SDK runs on it.
  it("every FeeBreakdownSchema key is served", () => {
    expect(sdkKeys.filter((k) => !servedKeys.includes(k))).toEqual([]);
  });

  // The dangerous direction of the required axis. `parseFeeBreakdown` runs inside
  // `xochiQuote` and THROWS, so a field the SDK requires and the server may omit makes
  // every fee-bearing quote unsignable.
  it("FeeBreakdownSchema requires nothing the server treats as optional", () => {
    const overStrict = sdkRequired.filter((k) => !servedRequired.includes(k));
    expect(overStrict, `required by fee.ts, optional on the wire: ${overStrict.join(", ")}`).toEqual([]);
  });

  // The lenient direction genuinely disagrees TODAY, and is pinned rather than asserted
  // away: the server marks `gas_floor` and `total_usd` required, `fee.ts` marks both
  // `.optional()` on purpose (price-oracle-derived, so a pre-adapter core still parses).
  // Pinned exactly, so a THIRD server-required field going optional here -- which would be
  // a real hole, since the SDK would then accept a breakdown it cannot reconcile -- fails.
  it("the only fields fee.ts relaxes are the two price-oracle-derived ones", () => {
    const relaxed = servedRequired.filter((k) => !sdkRequired.includes(k));
    expect(
      relaxed,
      "known, deliberate divergence: see the FeeBreakdownSchema comment in fee.ts",
    ).toEqual(["gas_floor", "total_usd"]);
  });

  // `asset_class` is a zod ENUM, not `.passthrough()`-tolerated: a third served class
  // fails `parseFeeBreakdown` and makes every quote in that class unsignable. Both sides
  // read, neither transcribed.
  it("FeeBreakdownSchema asset_class options match the served enum", () => {
    const sdkClasses = [...shape.asset_class.options].sort();
    const servedClasses = [...enumOf("LayeredFeeBreakdown", "asset_class")].sort();
    expect(sdkClasses).toEqual(servedClasses);
  });
});

// ---------------------------------------------------------------------------

describe("capability chain encodings the parser recognises", () => {
  // `chains` is an array, so `enumOf` (which walks `properties`) cannot reach its items.
  function chainItemEnum(key: string): string[] {
    const items = (schema("CapabilityMatrix").properties?.chains as { items?: OpenApiSchema } | undefined)
      ?.items;
    const values = items?.properties?.[key]?.enum ?? [];
    if (values.length === 0) throw new Error(`served CapabilityMatrix.chains[].${key} declares no enum`);
    return values;
  }

  // Catches: the server adds a VM family. capabilities.ts drops a chain whose vm_type it
  // does not recognise (an unknown VM is not EVM), so an unlearned served member is a
  // chain silently missing from every accessor. Spec 0.8.0's `cvm` (Canton) was the first:
  // before the parser knew it, it read as an EVM chain with format hex20.
  it("every served vm_type parses as itself", () => {
    const unrecognised = chainItemEnum("vm_type").filter((vm) => {
      const c = parseCapabilities({ chains: [{ chain_id: 1, vm_type: vm }] });
      return c === null || chainVmType(c, 1) !== vm;
    });
    expect(unrecognised, "served vm_type(s) capabilities.ts does not recognise; add them to VmType").toEqual([]);
  });

  // A served format the whitelist lacks falls back to the VM's own, which hides it.
  it("every served address_format parses as itself", () => {
    const unrecognised = chainItemEnum("address_format").filter((format) => {
      const c = parseCapabilities({ chains: [{ chain_id: 1, address_format: format }] });
      return c === null || chainAddressFormat(c, 1) !== format;
    });
    expect(
      unrecognised,
      "served address_format(s) capabilities.ts does not recognise; add them to AddressFormat",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
