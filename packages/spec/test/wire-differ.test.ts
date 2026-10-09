// Classification tests for `packages/spec/wire/compare.mjs`, the differ that is BOTH
// the nightly probe's verdict and the refresh's refusal.
//
// Why these exist as tests rather than as mutations somebody ran once: every blind spot
// this file pins was found by reading the differ, not by running it, and each one
// reported OK against the real prod document while the writer installed the mutation
// with no flag and the probe then verified that installed copy against the same server
// forever. A silent pass leaves no trace to notice later, so the only thing that keeps
// an axis alive is a case that fails when it is removed.
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
const wire = (await import(
  path.join(path.dirname(DOC_PATH), "compare.mjs")
)) as {
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
  // still declare `type`/`pattern`/`oneOf`, so the measured count is 0, not five: pinned
  // exactly, because a `<= 5` bound had five units of slack sized precisely to the
  // five-schema hollowing the differ's header describes.
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

  // These four were on no axis at all: the constraint list is a closed allowlist and
  // the descent skips any key that is a scalar on both sides, so a keyword missing from
  // the list is invisible in both directions.
  it("readOnly added to a request property is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.QuoteRequest.properties.from_amount.readOnly = true;
    });
    expect(one(breaking)).toMatch(/QuoteRequest\.properties\.from_amount\.readOnly/);
  });

  it("uniqueItems added is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.QuoteRequest.properties.slippage_bps.uniqueItems = true;
    });
    expect(one(breaking)).toMatch(/uniqueItems/);
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
      expect([...breaking, ...stale].join("\n"), `\`${key}\` is advertised but not compared`).toMatch(
        new RegExp(`EthAddress\\.\\$?${key.replace("$", "")}`),
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe("additionalProperties in its object form", () => {
  // Both sites are live in the served contract. `pull_recipients` is the per-chain
  // {erc3009, permit2} matrix behind the recipient pin; `addresses` pins every token
  // address to ChainAddress. Deleting either node deletes its whole value contract, and
  // it reported OK on every axis: the constraint loop skipped it because neither side
  // was a boolean, and the descent skipped it again as a known constraint key.
  it("dropping the pull-recipient matrix's value schema is BREAKING", () => {
    const { breaking } = served((d) => {
      delete d.components.schemas.CapabilityMatrix.properties.pull_recipients.additionalProperties;
    });
    expect(one(breaking)).toMatch(/pull_recipients\.additionalProperties/);
  });

  it("dropping the token-address map's value schema is BREAKING", () => {
    const { breaking } = served((d) => {
      delete d.components.schemas.TokenCapability.properties.addresses.additionalProperties;
    });
    expect(one(breaking)).toMatch(/addresses\.additionalProperties/);
  });

  it("repointing the value schema is BREAKING", () => {
    const { breaking } = served((d) => {
      d.components.schemas.TokenCapability.properties.addresses.additionalProperties = {
        $ref: "#/components/schemas/ErrorResponse",
      };
    });
    expect(one(breaking)).toMatch(/addresses\.additionalProperties\.\$ref/);
  });

  it("the boolean form is still compared by value", () => {
    const { breaking } = served((d) => {
      d.components.schemas.QuoteRequest.additionalProperties = true;
    });
    expect(one(breaking)).toMatch(/QuoteRequest\.additionalProperties/);
  });
});

// ---------------------------------------------------------------------------

describe("servers", () => {
  // `servers` is where the bytes go and it is an array, so the object walk never saw it
  // and nothing else reached the document root. A repointed base URL installed itself.
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
  // even though nothing was removed. Graded STALE, the writer -- which refuses only on
  // `breaking.length > 0` -- wrote it with no flag.
  it("an appended alternative is BREAKING", () => {
    const { breaking } = served((d) => {
      d.servers.push({ url: "https://new.example" });
    });
    expect(one(breaking)).toMatch(/servers: served also offers https:\/\/new\.example at index 2/);
  });

  it("prepending a host is BREAKING even though nothing was removed", () => {
    // Measured before this graded: b=0 s=1, and the reformat preserves array order, so
    // the refresh installed the attacker's host at servers[0].
    const { breaking } = served((d) => {
      d.servers.unshift({ url: "https://evil.example" });
    });
    expect(one(breaking)).toMatch(/servers: served also offers https:\/\/evil\.example at index 0/);
  });

  it("reordering the same hosts is BREAKING", () => {
    // A permutation adds and removes nothing, so a sorted set diff is empty on both
    // sides while the base URL a generator reads has changed.
    const { breaking, stale } = served((d) => {
      d.servers.reverse();
    });
    expect(stale).toEqual([]);
    expect(one(breaking)).toMatch(/servers: same urls in a new order -- served leads with https:\/\/localhost:4000/);
  });

  it("an operation-level override reroutes one operation and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].post.servers = [{ url: "https://evil.example" }];
    });
    expect(one(breaking)).toMatch(/POST \/xochi\/quote servers: served declares an operation-level override/);
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
    expect(names.length, "the served contract declares no security scheme to rename").toBeGreaterThan(0);
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
    const doc = (): Doc => ({ openapi: "3.0.3", paths: {}, components: { schemas: { D: deep(5000) } } });
    expect(() => wire.compareContract(doc(), doc())).toThrow(wire.IncomparableDocument);
  });

  // Every WHOLE-VALUE comparison escaped that bound: `canon` is applied to arbitrary
  // constraint values and `withoutProse` to a whole `securitySchemes` node, neither
  // depth-counted. Measured on a `const` payload 200k deep, the unbounded `canon` raised
  // `RangeError: Maximum call stack size exceeded`, which is not an IncomparableDocument,
  // so the callers reported an internal error instead of INCONCLUSIVE.
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
  // The shared-path loop enumerates a path item's HTTP methods and nothing else, so
  // every other Path Item Object key was on no axis in either direction. Both of these
  // graded b=0 s=0 against the real document -- and the same `servers` array one level
  // down, on `post`, was caught, which is what makes this a gap rather than a policy.
  it("a path-item servers override reroutes every operation under the path and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].servers = [{ url: "https://evil.example" }];
    });
    expect(one(breaking)).toMatch(/path \/xochi\/quote servers: served declares a path-item override/);
  });

  it("a path-item servers override on every path is BREAKING once per path", () => {
    const paths = Object.keys(vendored().paths);
    const { breaking } = served((d) => {
      for (const p of paths) d.paths[p].servers = [{ url: "https://evil.example" }];
    });
    expect(breaking).toHaveLength(paths.length);
  });

  it("a path-item $ref replaces the whole item and is BREAKING", () => {
    const { breaking } = served((d) => {
      d.paths["/xochi/quote"].$ref = "#/paths/~1xochi~1health";
    });
    expect(one(breaking)).toMatch(/path \/xochi\/quote\.\$ref: served replaces the whole path item/);
  });
});

// ---------------------------------------------------------------------------

describe("the document's own header", () => {
  // `openapi` is the DIALECT that defines the keywords the constraint loop compares by
  // value: 3.0.x `exclusiveMinimum` is a boolean modifying `minimum` and `nullable`
  // exists, 3.1 makes the first a numeric bound and drops the second. Under a changed
  // dialect every axis below compares two identical values that mean different things,
  // and it graded b=0 s=0.
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
  it("rewording prose at the root, on a path and on a schema still exits clean", () => {
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
  // every applicator that REJECTS a request the vendored copy calls legal. Each of these
  // graded b=0 s=1 in its object form, and b=0 s=0 as a BOOLEAN, which was on no axis in
  // either direction: the descent short-circuits on a key that is not an object on either
  // side. `unevaluatedProperties: false` is the canonical spelling of "reject every field
  // I did not declare" and `not: false` rejects everything, so the boolean form is the one
  // that costs a client requests, and the writer refuses only on BREAKING -- so all twenty
  // of these installed unrefused.
  //
  // Driven off the EXPORTED set rather than a retyped list, which is the rule `CONSTRAINTS`
  // already carries: a keyword in the list that the differ does not hold is a false claim
  // on every green run, and the differ's own header, wire/README.md and the probe preamble
  // all advertise these ten.
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
  // `required` was compared only where it is an ARRAY, and it is not in CONSTRAINTS, so
  // the boolean form on a Header Object was on no axis: flipping POST /xochi/quote's 503
  // `Retry-After.required` graded b=0 s=0, while the differ's docstring and the probe's
  // preamble both claim `required` is compared at every node.
  const header = (d: Doc) => d.paths["/xochi/quote"].post.responses["503"].headers["Retry-After"];

  it("a flipped response-header required is BREAKING", () => {
    const { breaking } = served((d) => {
      header(d).required = true;
    });
    expect(one(breaking)).toMatch(
      /POST \/xochi\/quote response 503\.headers\.Retry-After\.required: served true, vendored false/,
    );
  });

  it("a header that stops being required is BREAKING in the other direction too", () => {
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
    expect(all).toMatch(/parameter #\/components\/parameters\/Tenant is served but not vendored \(required\)/);
    expect(all).toMatch(/requestBody is served but not vendored \(required\)/);
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

    // The probe's axis, as it is now computed: an ordered multiset over both texts.
    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(respelled, RAW);
    expect(servedOnly).toEqual(["8194.0"]);
    expect(vendoredOnly).toEqual(["8194"]);
  });
});

// ---------------------------------------------------------------------------

describe("numberTokenDiff", () => {
  // `8194` occurs once, which is the only case the de-duplicated one-directional set
  // difference this replaces could see. `0` occurs many times in the real document
  // (every one a `minimum` or `default` bound), so re-spelling ONE of them leaves the
  // folded spelling present elsewhere and the old expression reported nothing at all
  // while the probe printed OK. The count is derived, not pinned: a refresh moves it.
  const respelledVendored = RAW.replace('"minimum": 0,', '"minimum": 0.0,');
  const zeros = (text: string) => wire.numberTokens(text).filter((t) => t === "0").length;

  it("a duplicated literal re-spelled in the VENDORED copy is caught", () => {
    expect(respelledVendored).not.toBe(RAW);
    expect(zeros(respelledVendored)).toBe(zeros(RAW) - 1);
    expect(zeros(respelledVendored), "the folded spelling must still occur elsewhere").toBeGreaterThan(0);

    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(RAW, respelledVendored);
    expect(vendoredOnly, "the local fault this axis exists to catch").toEqual(["0.0"]);
    expect(servedOnly).toEqual(["0"]);
  });

  it("the same re-spelling in the SERVED copy is caught, with the sides swapped", () => {
    const { servedOnly, vendoredOnly } = wire.numberTokenDiff(respelledVendored, RAW);
    expect(servedOnly).toEqual(["0.0"]);
    expect(vendoredOnly).toEqual(["0"]);
  });

  it("the de-duplicated one-directional filter it replaces sees neither direction", () => {
    const vendoredTokens = new Set(wire.numberTokens(respelledVendored));
    expect([...new Set(wire.numberTokens(RAW))].filter((t) => !vendoredTokens.has(t))).toEqual([]);
    expect(wire.compareContract(JSON.parse(RAW), JSON.parse(respelledVendored)).breaking).toEqual([]);
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
  // published artifact that `sdks/{python,go,rust}` parse and `openapi.sha256` covers.
  it("re-formatting the vendored contract reproduces it byte-for-byte", () => {
    expect(format.formatDocument(RAW)).toBe(RAW);
  });

  // The reason it exists. `JSON.parse` folds every number to an IEEE-754 double, so the
  // `JSON.stringify` round trip this replaced re-spelled all seven of these -- `1e400`
  // became `null` and `0.0` became `0`. Go's `json.Number` and serde_json's
  // `arbitrary_precision` keep the literal, so for those consumers a folded bound is a
  // value the producer never served. Measured through the old path, the multiset diff
  // against the served text reported `servedOnly:['0.0'] vendoredOnly:['0']`, which
  // `verify-openapi.mjs` grades RE-SPELLED -> exit 1, on every nightly run, with the
  // refresh it names as the remedy reproducing the same bytes forever.
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
    // The path this replaced, on the same input, for contrast rather than for its own sake.
    expect(wire.numberTokens(JSON.stringify(JSON.parse(source), null, 2))).not.toEqual(literals);
  });

  // A formatter that degrades to `JSON.parse` on the inputs its own scanner cannot read
  // reintroduces the folding on exactly those inputs, silently. So it throws, and the
  // caller reports INCONCLUSIVE rather than writing.
  it("malformed input throws instead of falling back", () => {
    for (const bad of ['{"a":1,}', "{\"a\": 01}", "{} {}", '{"a": +1}', '{"a": .5}', "{'a':1}", "{"]) {
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
