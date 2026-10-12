// Classification tests for `packages/spec/wire/compare.mjs`, the differ that is BOTH
// the nightly probe's verdict and the refresh's refusal. Each axis is pinned by a case
// that fails when the axis is removed: a silent pass leaves no trace to notice later.
//
// The fixture is the real vendored contract, mutated per case. A synthetic two-key
// document would pass every one of these while proving nothing about the shapes the
// producer actually serves -- `additionalProperties` in its object form, a two-branch
// `oneOf`, an inline `enum` on a property.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);

const DOC_PATH = require.resolve("@xochi/spec/wire/openapi.json");
const RAW = fs.readFileSync(DOC_PATH, "utf8");

interface Findings {
  breaking: string[];
  stale: string[];
  stats: { checks: number; nodes: number; nameOnly: number };
}

// Computed specifier: the differ is a plain .mjs with no declarations, and a literal
// import would need one. The shape it returns is asserted by every case below.
const wire = (await import(path.join(path.dirname(DOC_PATH), "compare.mjs"))) as {
  compareContract: (served: unknown, vendored: unknown) => Findings;
  numberTokens: (text: string) => string[];
  numberTokenDiff: (
    servedText: string,
    vendoredText: string,
  ) => { servedOnly: string[]; vendoredOnly: string[] };
  IncomparableDocument: new (message?: string) => Error;
  CONSTRAINTS: string[];
  NARROWING: Set<string>;
};

// The writer's serializer, reached the same way and for the same reason: a plain .mjs
// with no declarations, sitting beside the document this file resolves through the
// package's `exports`, so the specifier is computed and a static import cannot express
// it. The bytes it produces ARE the vendored artifact, so it is pinned against the
// checked-in copy below and not against an expectation retyped here.
const format = (await import(path.join(path.dirname(DOC_PATH), "format.mjs"))) as {
  formatDocument: (text: string) => string;
  MalformedDocument: new (message?: string) => Error;
};

type Doc = Record<string, any>;

const vendored = (): Doc => JSON.parse(RAW);

/** Compare a mutated served copy against the untouched vendored one. */
function served(mutate: (d: Doc) => void): Findings {
  const doc = vendored();
  mutate(doc);
  return wire.compareContract(doc, vendored());
}

const one = (list: string[]) => (list.length === 1 ? list[0] : JSON.stringify(list));

// ---------------------------------------------------------------------------

describe("differ baseline", () => {
  // Guards every case below: if the differ silently stopped descending, the mutations
  // would still "pass" by reporting nothing, and so would this -- except for the counts.
  it("the document compared against itself yields nothing, having actually looked", () => {
    const { breaking, stale, stats } = wire.compareContract(vendored(), vendored());
    expect(breaking).toEqual([]);
    expect(stale).toEqual([]);
    expect(stats.nodes).toBeGreaterThan(300);
    expect(stats.checks).toBeGreaterThan(500);
  });

  // The five schemas whose ONLY cover is the constraint axis (`EthAddress`,
  // `BigIntString`, `ChainAddress`, `CompressedSecp256k1PubKey`, `WalletSignature`) each
  // still declare `type`/`pattern`/`oneOf`, so the count is 0, not five, pinned exactly.
  it("no schema in the real contract is checked by name alone", () => {
    const { stats } = wire.compareContract(vendored(), vendored());
    expect(
      stats.nameOnly,
      "a schema lost every axis this differ compares -- properties, required, enum, constraints, branches -- so only its NAME is still checked",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("value constraints", () => {
  it("a loosened pattern is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.EthAddress.pattern = "^.*$";
    });
    expect(one(breaking)).toMatch(/EthAddress\.pattern/);
  });

  it("a retyped scalar is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.BigIntString.type = "integer";
    });
    expect(one(breaking)).toMatch(/BigIntString\.type/);
  });

  it("a dropped union branch is BREAKING", () => {
    // ChainAddress is hex-or-base58; losing the base58 half takes Tron with it.
    const { breaking } = served((d) => {
      d.components.schemas.ChainAddress.oneOf.pop();
    });
    expect(one(breaking)).toMatch(/ChainAddress\.oneOf/);
  });

  // The constraint list is a closed allowlist and the descent skips any key that is a
  // scalar on both sides, so a keyword missing from the list is invisible in both directions.
  it("readOnly added to a request property is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.QuoteRequest.properties.from_amount.readOnly = true;
    });
    expect(one(breaking)).toMatch(/QuoteRequest\.properties\.from_amount\.readOnly/);
  });

  it("a served-only deprecated is STALE, not BREAKING", () => {
    const { breaking, stale } = served((d) => {
      d.components.schemas.EthAddress.deprecated = true;
    });
    expect(breaking).toEqual([]);
    expect(one(stale)).toMatch(/EthAddress\.deprecated/);
  });

  it("a served-only default is STALE, but a vendored-only one is BREAKING", () => {
    // `deadline` declares no default today, which is what makes both directions
    // reachable from the real document.
    const added = served((d) => {
      d.components.schemas.QuoteRequest.properties.deadline.default = 300;
    });
    expect(added.breaking).toEqual([]);
    expect(one(added.stale)).toMatch(/deadline\.default/);

    const removed = wire.compareContract(
      vendored(),
      (() => {
        const v = vendored();
        v.components.schemas.QuoteRequest.properties.deadline.default = 300;
        return v;
      })(),
    );
    expect(one(removed.breaking)).toMatch(/deadline\.default/);
  });

  it("every keyword the preamble advertises is one the differ actually holds", () => {
    // The probe prints CONSTRAINTS as its self-description. A name in that list that
    // the loop does not read would be a false claim on every green run.
    for (const key of wire.CONSTRAINTS) {
      if (key === "additionalProperties" || key === "$ref" || key === "type") continue;
      const { breaking, stale } = served((d) => {
        d.components.schemas.EthAddress[key] = "__probe__";
      });
      expect(
        [...breaking, ...stale].join("\n"),
        `\`${key}\` is advertised but not compared`,
      ).toMatch(new RegExp(`EthAddress\\.\\$?${key.replace("$", "")}`));
    }
  });
});

// ---------------------------------------------------------------------------

describe("additionalProperties in its object form", () => {
  // `pull_recipients` is the per-chain {erc3009, permit2} matrix behind the recipient pin.
  // Deleting the node deletes its whole value contract; the constraint loop sees no
  // boolean and the descent treats it as a known constraint key, so it needs its own axis.
  it("dropping the pull-recipient matrix's value schema is BREAKING", () => {
    const { breaking } = served((d) => {
      delete d.components.schemas.CapabilityMatrix.properties.pull_recipients.additionalProperties;
    });
    expect(one(breaking)).toMatch(/pull_recipients\.additionalProperties/);
  });

  it("repointing the value schema is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.TokenCapability.properties.addresses.additionalProperties = {
        $ref: "#/components/schemas/ErrorResponse",
      };
    });
    expect(one(breaking)).toMatch(/addresses\.additionalProperties\.\$ref/);
  });

  it("the boolean form is compared by value", () => {
    const { breaking } = served((d) => {
      d.components.schemas.QuoteRequest.additionalProperties = true;
    });
    expect(one(breaking)).toMatch(/QuoteRequest\.additionalProperties/);
  });
});

// ---------------------------------------------------------------------------

describe("servers", () => {
  // `servers` is where the bytes go: an array at the document root the object walk never
  // reaches.
  it("repointing the base URL is BREAKING", () => {
    const { breaking } = served((d) => {
      d.servers = [{ url: "https://evil.example" }];
    });
    expect(breaking.join("\n")).toMatch(/servers: served no longer offers/);
  });

  it("dropping servers entirely is BREAKING", () => {
    const { breaking } = served((d) => {
      delete d.servers;
    });
    expect(breaking.join("\n")).toMatch(/servers: served no longer offers/);
  });

  // Not STALE, unlike an added `security` alternative: this array's FIRST element is the
  // base URL a generated client bakes in, so an insertion changes what consumers dial
  // even though nothing was removed.
  it("an appended alternative is BREAKING", () => {
    const { breaking } = served((d) => {
      d.servers.push({ url: "https://new.example" });
    });
    expect(one(breaking)).toMatch(/servers: served also offers https:\/\/new\.example at index 2/);
  });

  it("reordering the same hosts is BREAKING", () => {
    // A permutation adds and removes nothing, so a sorted set diff is empty on both
    // sides while the base URL a generator reads has changed.
    const { breaking, stale } = served((d) => {
      d.servers.reverse();
    });
    expect(stale).toEqual([]);
    expect(one(breaking)).toMatch(
      /servers: same urls in a new order -- served leads with https:\/\/localhost:4000/,
    );
  });

  it("an operation-level override reroutes one operation and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].post.servers = [{ url: "https://evil.example" }];
    });
    expect(one(breaking)).toMatch(
      /POST \/xochi\/quote servers: served declares an operation-level override/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("enum and required grading", () => {
  it("an appended enum member is STALE (ErrorCode is append-only)", () => {
    const { breaking, stale } = served((d) => {
      d.components.schemas.ErrorCode.enum.push("brand_new_code");
    });
    expect(breaking).toEqual([]);
    expect(one(stale)).toMatch(/ErrorCode\.enum: served adds "brand_new_code"/);
  });

  it("a dropped enum member is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.IntentLifecycleStatus.enum =
        d.components.schemas.IntentLifecycleStatus.enum.filter((s: string) => s !== "completed");
    });
    expect(one(breaking)).toMatch(/IntentLifecycleStatus\.enum: served drops "completed"/);
  });

  it("a newly required property is BREAKING while a new optional one is STALE", () => {
    const req = served((d) => {
      d.components.schemas.QuoteRequest.properties.new_field = { type: "string" };
      d.components.schemas.QuoteRequest.required.push("new_field");
    });
    expect(req.breaking.join("\n")).toMatch(/new_field is served but not vendored \(required\)/);

    const opt = served((d) => {
      d.components.schemas.QuoteRequest.properties.new_field = { type: "string" };
    });
    expect(opt.breaking).toEqual([]);
    expect(one(opt.stale)).toMatch(/new_field is served but not vendored \(optional\)/);
  });
});

// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("dropping an operation's security requirement is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].post.security = [];
    });
    expect(breaking.join("\n")).toMatch(/security: served no longer accepts/);
  });

  it("renaming the API-key header is BREAKING", () => {
    // `securitySchemes` has a SCALAR contract (`type`, `scheme`, `in`, `name`) that the
    // node walk does not reach, so it is compared whole. Every scheme, not the first:
    // picking one by index tests whichever the generator happened to emit first.
    const names = Object.keys(vendored().components.securitySchemes ?? {});
    expect(
      names.length,
      "the served contract declares no security scheme to rename",
    ).toBeGreaterThan(0);
    for (const name of names) {
      const { breaking } = served((d) => {
        d.components.securitySchemes[name].name = "X-Not-The-Api-Key";
      });
      expect(one(breaking)).toMatch(new RegExp(`components\\.securitySchemes\\.${name}`));
    }
  });
});

// ---------------------------------------------------------------------------

describe("documents this differ refuses to grade", () => {
  // A RangeError from unbounded recursion reaches a crash handler that has to guess
  // what it meant; a typed refusal lets both callers say "nothing was concluded".
  it("nesting past the depth bound throws IncomparableDocument, not RangeError", () => {
    const deep = (n: number) => {
      let node: Doc = { type: "object" };
      for (let i = 0; i < n; i += 1) node = { type: "object", properties: { a: node } };
      return node;
    };
    const doc = (): Doc => ({
      openapi: "3.0.3",
      paths: {},
      components: { schemas: { D: deep(5000) } },
    });
    expect(() => wire.compareContract(doc(), doc())).toThrow(wire.IncomparableDocument);
  });

  // Every WHOLE-VALUE comparison is bounded too: `canon` is applied to arbitrary
  // constraint values and `withoutProse` to a whole `securitySchemes` node, and an
  // unbounded recursion there raises RangeError, not IncomparableDocument.
  it("a deep constraint VALUE throws IncomparableDocument, not RangeError", () => {
    const deepValue = (n: number) => {
      let node: Doc = { a: 1 };
      for (let i = 0; i < n; i += 1) node = { a: node };
      return node;
    };
    const doc = (): Doc => {
      const d = vendored();
      d.components.schemas.EthAddress.const = deepValue(5000);
      return d;
    };
    expect(() => wire.compareContract(doc(), doc())).toThrow(wire.IncomparableDocument);
  });
});

// ---------------------------------------------------------------------------

describe("the path item as a node", () => {
  // The shared-path loop enumerates a path item's HTTP methods; every other Path Item
  // Object key needs its own axis.
  it("a path-item servers override reroutes every operation under the path and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].servers = [{ url: "https://evil.example" }];
    });
    expect(one(breaking)).toMatch(
      /path \/xochi\/quote servers: served declares a path-item override/,
    );
  });

  it("a path-item $ref replaces the whole item and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].$ref = "#/paths/~1xochi~1health";
    });
    expect(one(breaking)).toMatch(
      /path \/xochi\/quote\.\$ref: served replaces the whole path item/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the document's own header", () => {
  // `openapi` is the DIALECT that defines the keywords the constraint loop compares by
  // value: 3.0.x `exclusiveMinimum` is a boolean modifying `minimum` and `nullable`
  // exists, 3.1 makes the first a numeric bound and drops the second. Under a changed
  // dialect every axis below compares two identical values that mean different things.
  it("a changed openapi dialect is BREAKING", () => {
    const { breaking } = served((d) => {
      d.openapi = "3.1.0";
    });
    expect(one(breaking)).toMatch(/openapi: served "3\.1\.0", vendored "3\.0\.3"/);
  });

  it("a changed info.version is STALE", () => {
    const { breaking, stale } = served((d) => {
      d.info.version = "9.9.9";
    });
    expect(breaking).toEqual([]);
    expect(one(stale)).toMatch(/info\.version: served "9\.9\.9", vendored "1\.0\.0"/);
  });

  // The other half of every axis above: prose is not protocol, and a probe that reports
  // a reword as drift is one whose red nobody reads.
  it("rewording prose at the root, on a path and on a schema exits clean", () => {
    const { breaking, stale } = served((d) => {
      d.info.description = "reworded";
      d.info.title = "reworded";
      d.paths["/xochi/quote"].post.summary = "reworded";
      d.paths["/xochi/quote"].post.description = "reworded";
      d.components.schemas.QuoteRequest.description = "reworded";
    });
    expect(breaking).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("served-only narrowing applicators", () => {
  // The generic descent grades any served-only key STALE -- "an addition a vendored-built
  // client survives" -- which is right for `content` or a new media type and wrong for
  // every applicator that REJECTS a request the vendored copy calls legal, in object or
  // boolean form: `unevaluatedProperties: false` is the canonical spelling of "reject every
  // field I did not declare" and `not: false` rejects everything, and the writer refuses
  // only on BREAKING.
  //
  // Driven off the EXPORTED set rather than a retyped list, as `CONSTRAINTS` is: a keyword
  // the differ does not hold would be a false claim in its header, wire/README.md and the
  // probe preamble.
  const OBJECT_FORM: Record<string, unknown> = {
    not: { required: ["from_amount"] },
    if: { required: ["from_amount"] },
    then: { required: ["origin"] },
    else: { required: ["origin"] },
    propertyNames: { pattern: "^x_" },
    contains: { type: "string" },
    dependentSchemas: { from_amount: { required: ["origin"] } },
    dependentRequired: { from_amount: ["origin"] },
    unevaluatedProperties: { type: "string" },
    unevaluatedItems: { type: "string" },
  };

  it("the exported set is the ten the differ advertises", () => {
    expect([...wire.NARROWING].sort()).toEqual(Object.keys(OBJECT_FORM).sort());
  });

  for (const key of wire.NARROWING) {
    it(`a served-only ${key} on QuoteRequest is BREAKING as an object and as false`, () => {
      // Both forms, and the node named: an axis that fires without saying where leaves the
      // reviewer of a 2000-line refresh diff nothing to act on.
      for (const value of [OBJECT_FORM[key], false]) {
        const { breaking, stale } = served((d) => {
          d.components.schemas.QuoteRequest[key] = value;
        });
        const where = `${key} = ${JSON.stringify(value)}`;
        expect(stale, where).toEqual([]);
        expect(one(breaking), where).toMatch(
          new RegExp(`components\\.schemas\\.QuoteRequest\\.${key} is served but not vendored`),
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------

describe("required in its boolean form", () => {
  // `required` is compared where it is an ARRAY and is not in CONSTRAINTS, so the boolean
  // form on a Parameter or Header Object needs its own axis.
  const header = (d: Doc) => d.paths["/xochi/quote"].post.responses["503"].headers["Retry-After"];

  it("a flipped response-header required is BREAKING in both directions", () => {
    const requiring = vendored();
    header(requiring).required = true;
    expect(one(wire.compareContract(requiring, vendored()).breaking)).toMatch(
      /Retry-After\.required: served true, vendored false/,
    );
    expect(one(wire.compareContract(vendored(), requiring).breaking)).toMatch(
      /Retry-After\.required: served false, vendored true/,
    );
  });

  // OpenAPI 3.0.3 defaults `required` to false on a Parameter or Header Object, so an
  // absent flag and `false` are the same contract. Reporting that pair would redden an
  // honest reformat, which is the one thing this probe must not do.
  it("dropping a required:false flag is not drift", () => {
    const { breaking, stale } = served((d) => {
      delete header(d).required;
    });
    expect(breaking).toEqual([]);
    expect(stale).toEqual([]);
  });

  // A `$ref`'d Parameter or Request Body carries `required` on its target, so a
  // newly served one is graded on the target, not on the bare ref object.
  it("a newly served required $ref parameter or requestBody is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.parameters = {
        Tenant: { in: "header", name: "X-Tenant", required: true, schema: { type: "string" } },
      };
      d.components.requestBodies = {
        Filter: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      };
      const op = d.paths["/xochi/chains"].get;
      op.parameters = [...(op.parameters ?? []), { $ref: "#/components/parameters/Tenant" }];
      op.requestBody = { $ref: "#/components/requestBodies/Filter" };
    });
    const all = breaking.join("\n");
    expect(all).toMatch(
      /parameter #\/components\/parameters\/Tenant is served but not vendored \(required\)/,
    );
    expect(all).toMatch(/requestBody is served but not vendored \(required\)/);
  });

  // A served-only ref nobody can resolve must not be graded on the bare ref object, whose
  // `required` is absent: that reads "(optional)", STALE.
  describe("a served-only parameter whose $ref cannot be resolved is BREAKING", () => {
    const claimWith = (ref: string, parameters: Doc = {}) =>
      served((d) => {
        d.components.parameters = { ...(d.components.parameters ?? {}), ...parameters };
        const op = d.paths["/xochi/claim"].post;
        op.parameters = [...(op.parameters ?? []), { $ref: ref }];
      });

    it.each([
      ["external", "https://evil.example/params.json#/X", {}, "not a local ref"],
      ["dangling", "#/components/parameters/Nowhere", {}, "dangling"],
      [
        "cyclic",
        "#/components/parameters/A",
        { A: { $ref: "#/components/parameters/B" }, B: { $ref: "#/components/parameters/A" } },
        "cyclic",
      ],
      ["malformed percent-encoding", "#/components/parameters/X%ZZ", {}, "malformed"],
    ])("%s", (_name, ref, parameters, reason) => {
      const { breaking, stale } = claimWith(ref, parameters);
      const line = breaking.find((b) => b.includes(`parameter ${ref}`));
      expect(line, breaking.join("\n")).toContain("cannot be resolved");
      expect(line).toContain(reason);
      expect(stale.join("\n")).not.toContain(`parameter ${ref}`);
    });

    it("a percent-encoded ref resolves and is graded on its required target", () => {
      const ref = "#/components/parameters/X%20Y";
      const { breaking } = claimWith(ref, {
        "X Y": { in: "header", name: "X-Y", required: true, schema: { type: "string" } },
      });
      expect(breaking).toContain(
        `POST /xochi/claim parameter ${ref} is served but not vendored (required)`,
      );
    });

    // RFC 6901 §6: percent-decode the whole fragment, THEN split on `/`, THEN unescape.
    it("%2F in a fragment separates tokens; ~1 is the slash inside a key", () => {
      const nested = { a: { b: { in: "header", name: "X-AB", required: true } } };
      expect(claimWith("#/components/parameters/a%2Fb", nested).breaking).toContain(
        "POST /xochi/claim parameter #/components/parameters/a%2Fb is served but not vendored (required)",
      );
      const slashKey = { "a/b": { in: "header", name: "X-AB", required: true } };
      expect(claimWith("#/components/parameters/a~1b", slashKey).breaking).toContain(
        "POST /xochi/claim parameter #/components/parameters/a~1b is served but not vendored (required)",
      );
      // Decoding per segment after the split read `%2F` as part of the key `a/b`.
      const line = claimWith("#/components/parameters/a%2Fb", slashKey).breaking.find((b) =>
        b.includes("parameters/a%2Fb"),
      );
      expect(line).toContain("dangling");
    });

    it("an unknown ~ escape is malformed", () => {
      const line = claimWith("#/components/parameters/a~2b").breaking.find((b) =>
        b.includes("parameters/a~2b"),
      );
      expect(line).toContain("malformed ~ escape");
    });
  });
});

// ---------------------------------------------------------------------------

// The walks follow the vendored copy's shape, so a served-only subtree is graded by its
// NAME and never entered; a dangling or external `$ref` inside one would read as an
// optional addition, STALE.
describe("a served $ref that does not resolve is BREAKING wherever it sits", () => {
  const addProperty = (schema: Doc) =>
    served((d) => {
      d.components.schemas.QuoteResponse.properties.zz = schema;
    });

  it.each([
    ["a served-only property", { $ref: "#/components/schemas/DoesNotExist" }, "dangling"],
    ["an external ref", { $ref: "https://evil.example/s.json#/X" }, "not a local ref"],
    [
      "nested under items/allOf",
      { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Nope" }] } },
      "dangling",
    ],
    ["a malformed fragment", { $ref: "#/components/schemas/%ZZ" }, "malformed"],
    ["a plain-name fragment", { $ref: "#Anchor" }, "malformed"],
  ])("%s", (_name, schema, reason) => {
    const { breaking } = addProperty(schema);
    const line = breaking.find((b) => b.includes("cannot be resolved"));
    expect(line, breaking.join("\n")).toContain(reason);
    expect(line).toContain("QuoteResponse.properties.zz");
  });

  it("a cyclic chain through served-only components", () => {
    const { breaking } = served((d) => {
      d.components.schemas.CycA = { $ref: "#/components/schemas/CycB" };
      d.components.schemas.CycB = { $ref: "#/components/schemas/CycA" };
    });
    expect(breaking.join("\n")).toMatch(/CycB cannot be resolved .*\(cyclic\)/);
  });

  it("a served-only path and response are entered too", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/new"] = {
        get: { responses: { "200": { $ref: "#/components/responses/Gone" } } },
      };
    });
    expect(one(breaking)).toMatch(/components\/responses\/Gone .*paths\.\/xochi\/new\.get/);
  });

  it("a recursive schema resolves", () => {
    const { breaking } = served((d) => {
      d.components.schemas.Tree = {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Tree" } },
      };
    });
    expect(breaking).toEqual([]);
  });

  it("a $ref inside an example or an x- extension is data", () => {
    const { breaking } = addProperty({
      type: "object",
      example: { $ref: "#/nowhere" },
      "x-note": { $ref: "#/nowhere" },
    });
    expect(breaking).toEqual([]);
  });

  it("a member NAMED like a payload keyword is entered", () => {
    const { breaking } = addProperty({
      type: "object",
      properties: { default: { $ref: "#/components/schemas/Nope" } },
    });
    expect(one(breaking)).toMatch(/zz\.properties\.default/);
  });

  it("a ref the vendored copy already fails at the same place is not a change", () => {
    const broken = vendored();
    broken.components.schemas.QuoteResponse.properties.zz = {
      $ref: "#/components/schemas/Nope",
    };
    const { breaking, stale } = wire.compareContract(broken, structuredClone(broken));
    expect(breaking).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("an existing ref whose target was dropped is reported on both axes", () => {
    const { breaking } = served((d) => {
      delete d.components.schemas.EthAddress;
    });
    const all = breaking.join("\n");
    expect(all).toMatch(/components\.schemas\.EthAddress is vendored but no longer served/);
    expect(all).toMatch(/\$ref #\/components\/schemas\/EthAddress cannot be resolved/);
  });
});

// ---------------------------------------------------------------------------

describe("numeric literals", () => {
  // The axis no structural diff can carry: both sides reach compareContract through
  // JSON.parse, which folds every number to a double, so a re-spelled bound compares
  // EQUAL there while Go's json.Number and serde_json's arbitrary_precision can tell.
  it("the scanner finds every literal in the real document and nothing inside a string", () => {
    const tokens = new Set(wire.numberTokens(RAW));
    const parsed = new Set<string>();
    (function walk(node: unknown): void {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") return Object.values(node).forEach(walk);
      if (typeof node === "number") parsed.add(String(node));
    })(JSON.parse(RAW));
    expect([...tokens].sort()).toEqual([...parsed].sort());
  });

  it("a re-spelled literal is invisible to the structural diff and visible to the scanner", () => {
    const respelled = RAW.replace('"maxLength": 8194', '"maxLength": 8194.0');
    expect(respelled).not.toBe(RAW);

    const structural = wire.compareContract(JSON.parse(respelled), vendored());
    expect(structural.breaking, "a double-folded literal cannot differ structurally").toEqual([]);
    expect(structural.stale).toEqual([]);

    // The probe's axis: an ordered multiset over both texts.
    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(respelled, RAW);
    expect(servedOnly).toEqual(["8194.0"]);
    expect(vendoredOnly).toEqual(["8194"]);
  });
});

// ---------------------------------------------------------------------------

describe("numberTokenDiff", () => {
  // `8194` occurs once. `0` occurs many times in the real document (every one a `minimum`
  // or `default` bound), so re-spelling ONE of them leaves the folded spelling present
  // elsewhere, which a de-duplicated one-directional set difference cannot see. The count
  // is derived, not pinned: a refresh moves it.
  const respelledVendored = RAW.replace('"minimum": 0,', '"minimum": 0.0,');
  const zeros = (text: string) => wire.numberTokens(text).filter((t) => t === "0").length;

  it("a duplicated literal re-spelled in the VENDORED copy is caught", () => {
    expect(respelledVendored).not.toBe(RAW);
    expect(zeros(respelledVendored)).toBe(zeros(RAW) - 1);
    expect(
      zeros(respelledVendored),
      "the folded spelling must still occur elsewhere",
    ).toBeGreaterThan(0);

    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(RAW, respelledVendored);
    expect(vendoredOnly, "the local fault this axis exists to catch").toEqual(["0.0"]);
    expect(servedOnly).toEqual(["0"]);
  });

  it("the same re-spelling in the SERVED copy is caught, with the sides swapped", () => {
    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(respelledVendored, RAW);
    expect(servedOnly).toEqual(["0.0"]);
    expect(vendoredOnly).toEqual(["0"]);
  });

  it("two identical texts report nothing on either side", () => {
    expect(wire.numberTokenDiff(RAW, RAW)).toEqual({ servedOnly: [], vendoredOnly: [] });
  });
});

// ---------------------------------------------------------------------------

describe("the vendored form", () => {
  // `formatDocument` is what `generate.mjs` writes, so this file's bytes are its output.
  // Idempotence is therefore the whole contract: anything that changes it -- key order,
  // indent, the empty-collection spelling, a folded literal -- rewrites 82 KB of a
  // published artifact that `runners/{python,go,rust}` parse and `openapi.sha256` covers.
  it("re-formatting the vendored contract reproduces it byte-for-byte", () => {
    expect(format.formatDocument(RAW)).toBe(RAW);
  });

  // The reason it exists. `JSON.parse` folds every number to an IEEE-754 double, so a
  // `JSON.stringify` round trip re-spells all seven of these -- `1e400` becomes `null` and
  // `0.0` becomes `0`. Go's `json.Number` and serde_json's `arbitrary_precision` keep the
  // literal, so for those consumers a folded bound is a value the producer never served,
  // and `verify-openapi.mjs` grades a vendored fold RE-SPELLED on every nightly run, with
  // the refresh it names as the remedy reproducing the same bytes.
  it("every literal the JSON round trip rewrites survives verbatim", () => {
    const literals = [
      "1e400",
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      "0.0",
      "1.0",
      "8194.0",
      "-0",
      "1E+2",
    ];
    const source = `{\n${literals.map((t, i) => `  "k${i}": ${t}`).join(",\n")}\n}`;

    expect(wire.numberTokens(format.formatDocument(source))).toEqual(literals);
    // The JSON round trip, on the same input, for contrast.
    expect(wire.numberTokens(JSON.stringify(JSON.parse(source), null, 2))).not.toEqual(literals);
  });

  // A formatter that degrades to `JSON.parse` on the inputs its own scanner cannot read
  // reintroduces the folding on exactly those inputs, silently. So it throws, and the
  // caller reports INCONCLUSIVE rather than writing.
  it("malformed input throws instead of falling back", () => {
    for (const bad of [
      '{"a":1,}',
      '{"a": 01}',
      "{} {}",
      '{"a": +1}',
      '{"a": .5}',
      "{'a':1}",
      "{",
    ]) {
      expect(() => format.formatDocument(bad), bad).toThrow(format.MalformedDocument);
    }
  });

  // The bound the reformat shares with the differ, and the one refusal here that is not
  // about the bytes being JSON: a document nested past it was never walked, so nothing
  // has been concluded about it.
  it("nesting past the depth bound is incomparable, not malformed", () => {
    let deep = "1";
    for (let i = 0; i < 105; i += 1) deep = `[${deep}]`;
    expect(() => format.formatDocument(deep)).toThrow(wire.IncomparableDocument);
  });
});
