/**
 * The structural comparison behind BOTH the nightly wire probe and the refresh
 * that writes the vendored copy. No imports at all: it sits in the trust path
 * of a file this repo signs against. Axes and finding classes: `./README.md`.
 *
 * ONE differ, TWO callers, and that is the point. `scripts/verify-openapi.mjs`
 * holds the served document to the vendored one; `./generate.mjs` holds the
 * served document to the copy it is about to REPLACE and refuses a BREAKING
 * result without `--allow-breaking`. A writer whose refusal is narrower than
 * its checker's comparison is a laundering path for exactly the drift the
 * checker exists to find (a served copy keeping every name while stripping
 * `pattern` from `EthAddress` would be written, re-digested, then verified OK
 * against the same server forever). Keep the refusal and the comparison the
 * same function.
 *
 * Structural, never byte-for-byte: a reformat or a description edit is not
 * protocol drift, and a probe that reports it as drift is one whose red nobody
 * reads. Not compared: descriptions, summaries, titles and examples.
 *
 * The constraint keywords are not decoration. Five component schemas
 * (`EthAddress`, `BigIntString`, `ChainAddress`, `CompressedSecp256k1PubKey`,
 * `WalletSignature`) declare no `properties`, `required` or `enum` at all, so
 * on those axes only their NAME is checked -- and they are the value encodings
 * every signing path depends on. `ChainAddress`'s two-branch `oneOf` is what
 * lets a Tron `recipient_address` survive verbatim; dropping a branch,
 * loosening `EthAddress.pattern` to `^.*$` or retyping `BigIntString` from
 * string to integer is each a silent re-encoding of signed bytes. Nothing else
 * in this repo reads those five schemas, so this axis is their only cover.
 *
 * Verdicts: STALE is an addition a vendored-built client survives (new path,
 * method, OPTIONAL property or parameter, appended `enum` member, served-only
 * `default`, added `security` alternative); BREAKING is a removal, a REQUIRED
 * served addition, a changed value constraint, a dropped `security`
 * requirement, a node whose JSON type disagrees, or a served `$ref` that does
 * not resolve.
 *
 * Eight rules here are easy to undo and each would be a silent pass:
 *
 *   1. The generic descent walks the UNION of both sides' keys. Walking the
 *      served side only makes every vendored-side subtree removal invisible:
 *      `content`, `schema`, `items` and `headers` are on no other axis, so
 *      deleting the 200 body schema of POST /xochi/quote, repointing its media
 *      type's `$ref`, dropping `requestBody.content`, an array's `items` or
 *      `components.responses.ValidationError.content` would each report OK.
 *   2. A node that is not a plain object on both sides is REPORTED, not skipped.
 *      A JSON Schema subschema may legally be a boolean, so a served
 *      `QuoteResponse.properties.to_amount: true` deletes `$ref`, `type` and
 *      `pattern` in one edit while the property name still matches.
 *   3. A served-only `default` is STALE, not BREAKING. It is the most ordinary
 *      annotation a generator emits and breaks no vendored-built client;
 *      grading it BREAKING puts it beside `EthAddress.pattern` loosening and
 *      teaches the on-call to stop reading the body. A `default` that
 *      DISAPPEARS or CHANGES is BREAKING -- it is what the server does with an
 *      omitted field.
 *   4. `security` is on an axis at all. It is an array, so the object walk
 *      skips it; without this axis dropping auth from POST /xochi/quote and
 *      renaming the API-key header from `X-API-Key` both report OK, on the one
 *      axis this repo hardcodes per server key.
 *   5. `additionalProperties` is compared for PRESENCE even in its object form.
 *      The constraint loop compares its BOOLEAN form by value, and the descent
 *      skips it as a known constraint key, so "served object vs vendored
 *      absent" is covered only here: deleting the object-form
 *      `additionalProperties` of `CapabilityMatrix.pull_recipients` (the
 *      per-chain matrix behind the recipient pin) or of
 *      `TokenCapability.addresses` would otherwise report OK on every axis.
 *      The skip requires BOTH sides to declare the object form, the only case
 *      the descent actually covers.
 *   6. The constraint list is a CLOSED allowlist, so a keyword absent from it
 *      is invisible in both directions -- the descent skips any key that is a
 *      scalar on both sides. `readOnly: true` added to a request property
 *      means a client must stop sending it. Adding a keyword to `CONSTRAINTS`
 *      is the whole cost of covering it. Two are annotations rather than
 *      contracts when served-only (`default`, `deprecated`): those are in
 *      `STALE_IF_SERVED_ONLY`.
 *   7. `servers` is compared as an ORDERED list and ANY addition is BREAKING.
 *      That is where it parts company with `security`, whose entries are
 *      alternatives. Here the FIRST element is the base URL a generated client
 *      bakes in, so a prepend removes nothing, grades STALE against a sorted
 *      set, and the writer -- which refuses only on `breaking.length > 0` --
 *      would write another host into `servers[0]` with no flag.
 *   8. Served-only is not automatically additive, and a narrowing applicator is
 *      graded on PRESENCE whatever its JSON type. The generic descent grades an
 *      object-valued served-only key STALE, right for `content`, `headers` or
 *      a new media type and wrong for every keyword in `NARROWING`: those
 *      REJECT requests the vendored copy says are legal. The BOOLEAN form
 *      matters most (`unevaluatedProperties: false` is the canonical "reject
 *      every field I did not declare"; `not: false` rejects everything) and
 *      the descent short-circuits on a key that is a scalar on both sides, so
 *      without this rule each installs with no flag and nothing in the
 *      provenance delta.
 *
 * Every server-controlled fragment of every finding goes through `sanitize`.
 */

/** Plain object. An array satisfies `typeof x === "object"` and is not a map. */
export const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Why `doc` is not recognisably an OpenAPI contract of this shape, or `null` if
 * it is: an `openapi` string, a `paths` object declaring at least one
 * operation, and a `components` object. The probe reads a served document
 * failing it as INCONCLUSIVE (not the producer disagreeing about the protocol);
 * the writer refuses a PRIOR copy failing it, because a gutted prior leaves the
 * BREAKING gate nothing to compare against -- the absent-prior case again.
 */
export const unrecognisedContract = (doc) => {
  if (!isObj(doc)) return "not a JSON object";
  if (typeof doc.openapi !== "string") return 'no "openapi" string';
  if (!isObj(doc.paths)) return 'no "paths" object';
  const hasOperation = Object.values(doc.paths).some(
    (item) => isObj(item) && OPERATION_METHODS.some((m) => isObj(item[m])),
  );
  if (!hasOperation) return '"paths" declares no operation';
  if (!isObj(doc.components)) return 'no "components" object';
  return null;
};

/**
 * The comparison ran out of depth. Not a finding: a document this differ cannot
 * walk is one it has said nothing about, so the callers report it as
 * INCONCLUSIVE rather than letting `RangeError: Maximum call stack size
 * exceeded` reach a handler that has to guess what it meant. The real document
 * nests 12 deep.
 */
export class IncomparableDocument extends Error {}

/**
 * Eight times the real document's depth. A served copy past it is not one.
 * Exported because the refresh's own reformat (`./format.mjs`) runs BEFORE the
 * comparison and must refuse on the same bound rather than retype it.
 */
export const MAX_DEPTH = 100;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * One cap for every server-controlled fragment, name and value alike. It is not
 * a size budget: a finding already carries its own `at` path, so 90 leaves the
 * whole line inside a normal terminal width, and no single served string can
 * push the finding it appears in off the screen or flood the BREAKING list
 * around it. A truncated fragment still identifies the node -- `openapi.sha256`
 * and the served document are where exact bytes live.
 */
const MAX_FRAGMENT_CHARS = 90;

/**
 * Served strings are interpolated into findings that land in a PUBLIC Actions
 * log (`vars.*` is not masked) and into the provenance block a human reads to
 * approve a refresh. A schema name carrying a newline plus `::error title=...::`
 * forges a workflow annotation at column 0; `::group::` or `::stop-commands::`
 * collapses the BREAKING list on the one gate guarding the wire contract; an
 * ANSI escape rewrites a local terminal. So C0/C1 controls become their escapes
 * and the result is capped, here, before any interpolation -- every call site
 * takes the default, so no finding string carries a cap of its own.
 */
export const sanitize = (value, max = MAX_FRAGMENT_CHARS) => {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const clean = raw.replace(CONTROL, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`);
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

/**
 * The JSON number tokens in a document's SOURCE TEXT, with string contents
 * skipped. A regex cannot do this: the contract is full of digits inside
 * strings (`"^0x[a-fA-F0-9]{40}$"`, the example amount `"1000000000"`, every
 * `"400"` response key), and a `pattern` is not a bound.
 *
 * Lexical because the hazard is at parse. `JSON.parse` folds every number to an
 * IEEE-754 double, so re-serializing re-spells literals: `115792089...639935`
 * becomes `1.157920892373162e+77` and `1e400` becomes `null`. `compareContract`
 * reads both sides through `JSON.parse`, so it is structurally incapable of
 * seeing that, and so is a diff of the two parsed documents. It lives here
 * rather than in the writer because both callers need it: the writer refuses to
 * CREATE a re-spelling, and the probe refuses to let one that reached the
 * vendored copy by any other route (a formatter, a merge, a hand edit plus a
 * re-digest) go on verifying green forever.
 */
export const numberTokens = (text) => {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i;
      i += 1;
      while (i < text.length && "0123456789.eE+-".includes(text[i])) i += 1;
      out.push(text.slice(start, i));
      continue;
    }
    i += 1;
  }
  return out;
};

/**
 * The two documents' numeric literals as an ordered MULTISET diff: every
 * literal SPELLING whose occurrence count differs, listed once per surplus
 * occurrence, in each text's own first-occurrence order.
 *
 * Both directions and per-occurrence: a de-duplicated one-directional set
 * difference (served \ vendored) is blind whenever the re-spelled literal's
 * spelling still occurs somewhere else in the file. The real vendored document
 * has `0` eleven times and `1` six times, every one a `minimum` or `default`
 * bound, so editing a single `"minimum": 0` in the VENDORED copy to `0.0`
 * leaves `0` present elsewhere and the set difference empty. A vendored-only
 * literal is the local fault this axis exists to catch, so it is reported too.
 *
 * Two lexes total, not one per distinct served token: the served body
 * `probe-lib` permits is 4 MB.
 */
export const numberTokenDiff = (servedText, vendoredText) => {
  const counts = (text) => {
    const out = new Map();
    for (const t of numberTokens(text)) out.set(t, (out.get(t) ?? 0) + 1);
    return out;
  };
  const s = counts(servedText);
  const v = counts(vendoredText);
  const surplus = (a, b) => {
    const out = [];
    for (const [t, n] of a) {
      for (let i = b.get(t) ?? 0; i < n; i += 1) out.push(t);
    }
    return out;
  };
  return { servedOnly: surplus(s, v), vendoredOnly: surplus(v, s) };
};

/**
 * Value constraints, compared by VALUE: `type` is a string or an array of
 * strings across OpenAPI 3.0/3.1, so `["string"]` and `"string"` are the same
 * constraint. Absent on one side only counts too -- a bound appearing or
 * disappearing is a contract change, and `pattern` disappearing is the whole
 * `EthAddress` case.
 *
 * A keyword absent from this list is invisible in BOTH directions -- the
 * descent below skips any key that is a scalar on both sides -- and membership
 * here is also what makes `STALE_IF_SERVED_ONLY` do anything. A keyword that is
 * an annotation rather than a contract when it appears on the served side only
 * goes in both lists.
 */
export const CONSTRAINTS = [
  "$ref",
  "type",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "const",
  "readOnly",
  "writeOnly",
  "nullable",
  "additionalProperties",
  "default",
  "deprecated",
];

/**
 * Served-only occurrences of these are annotations, not contracts: a `default`
 * is what the server does with an omitted field and `deprecated` is an
 * announcement, so neither breaks a vendored-built client by appearing. Both
 * are still BREAKING when they DISAPPEAR or CHANGE.
 *
 * Membership here does NOTHING on its own. This set is read at exactly one
 * place, inside `for (const k of CONSTRAINTS)`, so a keyword added only here is
 * never looked at in either direction and nothing fails.
 */
const STALE_IF_SERVED_ONLY = new Set(["default", "deprecated"]);
const CONSTRAINT_SET = new Set(CONSTRAINTS);

/**
 * JSON Schema's narrowing applicators, BREAKING when the served copy declares
 * one the vendored copy does not -- whatever the JSON type of the value.
 *
 * The generic descent grades a served-only key STALE, "an addition a
 * vendored-built client survives", which each of these is the opposite of: they
 * REJECT requests the vendored copy says are legal. The BOOLEAN form is on no
 * other axis in either direction (the descent skips a key that is not an
 * object on either side and the constraint loop never reads these keywords),
 * and it is the form that matters most.
 *
 * Exported, and `wire-differ.test.ts` drives BOTH forms of every member: a
 * keyword in this list the descent does not actually hold is a false claim on
 * every green run, which is the rule `CONSTRAINTS` already carries.
 */
export const NARROWING = new Set([
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contains",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** Array-valued subschemas, walked element-wise by index. */
const BRANCHES = ["oneOf", "anyOf", "allOf", "prefixItems"];

/**
 * Skipped by the generic walk. An `example` object carries arbitrary keys, and
 * one named `type` would be diffed as a constraint. `properties` is skipped
 * because it is a MAP whose keys are field names (the contract has a field named
 * `type`) and is handled by name instead. `default` is skipped because it is
 * already compared by VALUE as a constraint: descending into it would diff a
 * payload as a schema.
 */
const NOT_SCHEMA = new Set([
  "example",
  "examples",
  "description",
  "summary",
  "title",
  "externalDocs",
  "default",
  "properties",
]);

/** OpenAPI operation keys. A `parameters` sibling is not a method. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Prose, at any depth. Stripped before a whole-node comparison. */
const PROSE = new Set(["description", "summary", "title", "example", "examples", "externalDocs"]);

/**
 * `compareNode` refuses a document it cannot walk, and every WHOLE-VALUE
 * comparison must share that bound: `canon` is applied to arbitrary constraint
 * values (`const`, `default`, the object form of `additionalProperties`), to
 * each `security` requirement and to a non-object `servers` entry, and
 * `withoutProse` to a whole `securitySchemes` node. A served `const` nested a
 * few hundred thousand deep would otherwise raise `RangeError`, which is not
 * an `IncomparableDocument`, so the callers would report an internal error
 * rather than INCONCLUSIVE. One bound, one class, every walk.
 */
const tooDeep = (where) =>
  new IncomparableDocument(
    `nesting deeper than ${MAX_DEPTH} in ${where}. The real contract nests 12 deep, so this ` +
      "is not that document; nothing was concluded about it.",
  );

const withoutProse = (node, depth = 0) => {
  if (depth > MAX_DEPTH) throw tooDeep("a whole-node comparison with prose stripped");
  if (Array.isArray(node)) return node.map((e) => withoutProse(e, depth + 1));
  if (isObj(node)) {
    return Object.fromEntries(
      Object.keys(node)
        .filter((k) => !PROSE.has(k))
        .map((k) => [k, withoutProse(node[k], depth + 1)]),
    );
  }
  return node;
};

const canon = (x, depth = 0) => {
  if (depth > MAX_DEPTH) throw tooDeep("a whole-value comparison");
  if (Array.isArray(x))
    return `[${x
      .map((e) => canon(e, depth + 1))
      .sort()
      .join(",")}]`;
  if (isObj(x)) {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(x[k], depth + 1)}`)
      .join(",")}}`;
  }
  return JSON.stringify(x) ?? "undefined";
};

/** A one-element `type` array is the scalar form of the same constraint. */
const canonConstraint = (key, x) =>
  key === "type" && Array.isArray(x) && x.length === 1 ? canon(x[0]) : canon(x);

const keysOf = (node) => (isObj(node) ? Object.keys(node) : []);
const setDiff = (a, b) => a.filter((k) => !b.includes(k));
const methodsOf = (item) => METHODS.filter((m) => keysOf(item).includes(m));
const isRequired = (node) => isObj(node) && node.required === true;

/**
 * Follow a local `$ref` chain in `doc` from `node` to the first node that is
 * not itself a reference. Returns `{ node }`, or `{ unresolved }` naming why
 * not: an external ref, a malformed fragment or escape, a dangling pointer or
 * a cycle.
 *
 * RFC 6901 §6 fixes the order for a pointer carried in a URI fragment: the
 * WHOLE fragment is percent-decoded first, then split on `/`, then each token
 * unescaped (`~1` -> `/`, then `~0` -> `~`). So `#/a%2Fb` is the path `a` ->
 * `b`, and the key `a/b` is spelled `#/a~1b`. Decoding per segment after the
 * split read `%2F` as part of a key and resolved `#/a%2Fb` to `a/b`.
 *
 * A cycle is detected on the TARGET object, not the ref string, so two
 * spellings of one pointer (`#/A` and `#/%41`) cannot hide a loop.
 */
const resolveRef = (doc, node) => {
  const seen = new Set();
  let cur = node;
  while (isObj(cur) && typeof cur.$ref === "string") {
    const ref = cur.$ref;
    if (!ref.startsWith("#")) return { unresolved: "not a local ref" };
    let pointer;
    try {
      pointer = decodeURIComponent(ref.slice(1));
    } catch {
      return { unresolved: "malformed percent-encoding" };
    }
    if (pointer !== "" && !pointer.startsWith("/")) {
      return { unresolved: "malformed: the fragment is not a JSON pointer" };
    }
    let target = doc;
    for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
      if (/~(?![01])/.test(token)) return { unresolved: "malformed ~ escape" };
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      target =
        target !== null && typeof target === "object" && Object.hasOwn(target, key)
          ? target[key]
          : undefined;
    }
    if (!isObj(target)) return { unresolved: "dangling" };
    if (seen.has(target)) return { unresolved: "cyclic" };
    seen.add(target);
    cur = target;
  }
  return { node: cur };
};

/**
 * Keys whose value is a PAYLOAD rather than a schema or an OpenAPI object, so a
 * `$ref` string inside one is data and not a reference: `example`/`examples`
 * (and an Example Object's `value`), the constraint payloads `default`,
 * `const` and `enum`, and `x-*` extensions. Not applied inside a NAME MAP,
 * where a key is a name chosen by the producer -- a property called `default`
 * is a schema, and `responses.default` is a response.
 */
const PAYLOAD_KEYS = new Set([
  "example",
  "examples",
  "value",
  "default",
  "const",
  "enum",
  "externalDocs",
]);

/**
 * Keys whose value is a map from producer-chosen NAMES to objects (OpenAPI's
 * paths, component sections, status codes, media types, header names; JSON
 * Schema's property maps). A member of one is an object of keywords, so the
 * flag holds for exactly one level.
 */
const NAME_MAPS = new Set([
  "paths",
  "webhooks",
  "components",
  "schemas",
  "responses",
  "parameters",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
  "pathItems",
  "content",
  "encoding",
  "variables",
  "scopes",
  "mapping",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * Every string `$ref` in `doc` that does not resolve, as a map from the ref to
 * `{ reason, hits: [{ node, loc }] }`. Walked with an explicit stack, so a deep
 * document costs heap rather than the call stack, and bounded by `MAX_DEPTH`
 * like every other walk here. Each stack entry links to its parent instead of
 * carrying its path, so a location is spelled only for a ref that failed.
 * `resolveRef` depends only on the ref string, so each distinct one is
 * resolved once.
 */
const unresolvedRefs = (doc, side) => {
  const locOf = (entry) => {
    const parts = [];
    for (let e = entry; e.up !== null; e = e.up) {
      parts.push(typeof e.key === "number" ? `[${e.key}]` : `.${e.key}`);
    }
    return parts.reverse().join("").replace(/^\./, "") || "(document root)";
  };
  const verdicts = new Map();
  const out = new Map();
  const stack = [{ node: doc, up: null, key: null, depth: 0, nameMap: false }];
  while (stack.length > 0) {
    const entry = stack.pop();
    const { node, depth, nameMap } = entry;
    if (depth > MAX_DEPTH) throw tooDeep(`the ${side} document's $ref scan`);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], up: entry, key: i, depth: depth + 1, nameMap: false });
      }
      continue;
    }
    if (!isObj(node)) continue;
    if (!nameMap && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!verdicts.has(ref)) verdicts.set(ref, resolveRef(doc, node).unresolved ?? null);
      const reason = verdicts.get(ref);
      if (reason !== null) {
        if (!out.has(ref)) out.set(ref, { reason, hits: [] });
        out.get(ref).hits.push({ node, loc: locOf(entry) });
      }
    }
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const k = keys[i];
      if (!nameMap && (PAYLOAD_KEYS.has(k) || k.startsWith("x-"))) continue;
      stack.push({
        node: node[k],
        up: entry,
        key: k,
        depth: depth + 1,
        nameMap: !nameMap && NAME_MAPS.has(k),
      });
    }
  }
  return out;
};

/**
 * Compare a served OpenAPI document against a vendored one.
 *
 * Pure: no I/O, no exits, no logging. The caller decides what a finding means --
 * DRIFT for the probe, a refusal for the writer.
 *
 * Returns `{ breaking, stale, stats }`, both lists of already-sanitized
 * human-readable lines. `stats.checks` and `stats.nodes` are reported by the
 * callers because "agreed" and "never looked" are otherwise the same output
 * (probe-lib rule 2).
 */
export const compareContract = (served, vendored) => {
  const breaking = [];
  const stale = [];
  let nodes = 0;
  let checks = 0;
  let operations = 0;
  let nameOnly = 0;

  const show = (x) => sanitize(JSON.stringify(x) ?? String(x));
  const quoted = (list) => list.map((x) => `"${sanitize(String(x))}"`).join(", ");
  const at = (prefix, key) => `${prefix}.${sanitize(String(key))}`;

  /**
   * Everything a client is held to at one node, at every node reachable in
   * either copy -- not just a named schema's top level. Eleven of the served
   * enums are inline on a property (`QuoteRequest.properties.swap_kind`,
   * `IntentStatus.properties.attestationStatus`, ...), and an enum a client
   * switches on is drift wherever it is declared.
   */
  const compareNode = (s, v, path, depth = 0) => {
    if (depth > MAX_DEPTH) throw tooDeep(path);
    if (!isObj(s) || !isObj(v)) {
      // Rule 2 above: one side is a boolean subschema, a scalar or absent, and
      // every constraint the other side declares is gone with it.
      if (s === undefined && v === undefined) return;
      if (canon(s) === canon(v)) return;
      checks += 1;
      breaking.push(`${path}: served ${show(s)}, vendored ${show(v)}`);
      return;
    }
    nodes += 1;

    for (const k of CONSTRAINTS) {
      const sHas = Object.hasOwn(s, k);
      const vHas = Object.hasOwn(v, k);
      if (!sHas && !vHas) continue;
      // Rule 5 above. Only the BOOLEAN form is a constraint by value (false ->
      // true is an open object with no contract) and only the object form is
      // walked below -- so the skip needs BOTH sides to be walking. Object
      // against absent is a constraint that appeared or vanished.
      if (
        k === "additionalProperties" &&
        sHas &&
        vHas &&
        typeof s[k] !== "boolean" &&
        typeof v[k] !== "boolean"
      ) {
        continue;
      }
      checks += 1;
      if (sHas !== vHas) {
        // Rule 3/6 above: served-only, these two are annotations, not breaks.
        (sHas && STALE_IF_SERVED_ONLY.has(k) ? stale : breaking).push(
          sHas
            ? `${at(path, k)}: served has ${show(s[k])}, vendored has none`
            : `${at(path, k)}: vendored has ${show(v[k])}, served has none`,
        );
      } else if (canonConstraint(k, s[k]) !== canonConstraint(k, v[k])) {
        breaking.push(`${at(path, k)}: served ${show(s[k])}, vendored ${show(v[k])}`);
      }
    }

    // Every property NAME checked against the other side counts, not only the
    // ones that differed: a comparison that passed is still one that ran.
    const sProps = keysOf(s.properties);
    const vProps = keysOf(v.properties);
    checks += sProps.length + setDiff(vProps, sProps).length;
    for (const k of setDiff(sProps, vProps)) {
      const required = Array.isArray(s.required) && s.required.includes(k);
      // A newly REQUIRED property is not additive: a client built against the
      // vendored copy omits it and the request is now rejected.
      (required ? breaking : stale).push(
        `${path}.properties.${sanitize(k)} is served but not vendored (${required ? "required" : "optional"})`,
      );
    }
    for (const k of setDiff(vProps, sProps)) {
      breaking.push(`${path}.properties.${sanitize(k)} is vendored but no longer served`);
    }
    for (const k of sProps.filter((k) => vProps.includes(k))) {
      compareNode(s.properties[k], v.properties[k], `${path}.properties.${sanitize(k)}`, depth + 1);
    }

    /**
     * `required` and `enum` as sets: neither array's order is semantic. They
     * grade their additions differently. Adding a name to `required` rejects
     * requests a vendored-built client knows how to send; adding a member to an
     * `enum` the server documents as append-only does not, so it is STALE.
     * Removals are BREAKING on both.
     */
    const listDiff = (key, addedList, addedNote) => {
      const sList = Array.isArray(s[key]) ? s[key].map(String) : null;
      const vList = Array.isArray(v[key]) ? v[key].map(String) : null;
      if (sList === null && vList === null) {
        // `required` has a second, non-array form: the BOOLEAN on a Parameter,
        // Header or Request Body Object. It is not in `CONSTRAINTS`, so this is
        // its only axis (flipping POST /xochi/quote's 503
        // `headers.Retry-After.required` is a contract change). Compared as the
        // EFFECTIVE flag, since OpenAPI 3.0.3 defaults it to false: absent and
        // `false` are the same contract, and reporting that pair as drift
        // reddens an honest reformat.
        if (key === "required" && (Object.hasOwn(s, key) || Object.hasOwn(v, key))) {
          checks += 1;
          if (isRequired(s) !== isRequired(v)) {
            breaking.push(`${at(path, key)}: served ${isRequired(s)}, vendored ${isRequired(v)}`);
          }
        }
        return;
      }
      checks += 1;
      if (sList === null || vList === null) {
        breaking.push(
          `${at(path, key)}: ${sList === null ? "served has none, vendored has one" : "served has one, vendored has none"}`,
        );
        return;
      }
      const added = setDiff(sList, vList);
      const removed = setDiff(vList, sList);
      if (added.length > 0)
        addedList.push(`${at(path, key)}: served adds ${quoted(added)}${addedNote}`);
      if (removed.length > 0) breaking.push(`${at(path, key)}: served drops ${quoted(removed)}`);
    };
    listDiff("required", breaking, "");
    listDiff("enum", stale, " (append-only per the served description; a DROP is BREAKING)");

    for (const k of BRANCHES) {
      const sa = s[k];
      const va = v[k];
      if (!Array.isArray(sa) && !Array.isArray(va)) continue;
      checks += 1;
      if (!Array.isArray(sa) || !Array.isArray(va)) {
        breaking.push(
          `${at(path, k)}: ${Array.isArray(sa) ? "served has one, vendored has none" : "vendored has one, served has none"}`,
        );
        continue;
      }
      // Length first, and reported even when the surviving branches agree: a
      // dropped branch is a narrowed union, which is `ChainAddress` losing the
      // base58 half of hex-or-base58 and taking Tron with it.
      if (sa.length !== va.length) {
        breaking.push(
          `${at(path, k)}: served has ${sa.length} branch(es), vendored has ${va.length}`,
        );
      }
      for (let i = 0; i < Math.min(sa.length, va.length); i += 1) {
        compareNode(sa[i], va[i], `${at(path, k)}[${i}]`, depth + 1);
      }
    }

    // Rule 1 above. Everything else object-valued on EITHER side: `items`,
    // `schema`, `content`, `headers`, a media-type object. Arrays stay out --
    // the four that are subschemas are handled by name above, and `required`,
    // `enum` and `security` have their own axes.
    for (const k of [...new Set([...keysOf(s), ...keysOf(v)])]) {
      if (NOT_SCHEMA.has(k)) continue;
      const sc = s[k];
      const vc = v[k];
      const sObj = isObj(sc);
      const vObj = isObj(vc);
      if (sObj && vObj) {
        compareNode(sc, vc, at(path, k), depth + 1);
        continue;
      }
      // Rule 8 above, and BEFORE the both-scalar short-circuit below, which
      // would otherwise leave the boolean form of these keywords uncompared in
      // both directions. Graded on presence, so `unevaluatedProperties: false`
      // lands where `unevaluatedProperties: {...}` already does. A
      // vendored-only one is the server dropping a restriction and keeps
      // whatever the rules below give it.
      if (NARROWING.has(k) && Object.hasOwn(s, k) && !Object.hasOwn(v, k)) {
        checks += 1;
        breaking.push(
          `${at(path, k)} is served but not vendored (a narrowing applicator: it rejects requests a vendored-built client sends)`,
        );
        continue;
      }
      if (!sObj && !vObj) continue;
      // Exactly one side is an object. A constraint keyword already reported
      // its own presence and value above; anything else is a subtree.
      if (CONSTRAINT_SET.has(k)) continue;
      checks += 1;
      if (vObj) {
        breaking.push(
          sc === undefined
            ? `${at(path, k)} is vendored but no longer served`
            : `${at(path, k)}: vendored declares an object, served has ${show(sc)}`,
        );
      } else {
        // A served-only subtree is additive; the narrowing applicators, which
        // are not, were graded above, on presence rather than on type. A served
        // object against a vendored scalar is a type disagreement either way.
        (vc === undefined ? stale : breaking).push(
          vc === undefined
            ? `${at(path, k)} is served but not vendored`
            : `${at(path, k)}: served declares an object, vendored has ${show(vc)}`,
        );
      }
    }
  };

  // 0. The document's own header. `openapi` is the DIALECT that defines the
  // keywords the constraint loop compares by value: in 3.0.x
  // `exclusiveMinimum`/`exclusiveMaximum` are booleans modifying
  // `minimum`/`maximum` and `nullable` exists, while in 3.1 they are numeric
  // bounds and `nullable` is gone -- so under a changed dialect this differ
  // compares two identical keyword values that mean different things, on every
  // axis below. The version is the producer's own label for the surface, so a
  // change is STALE (refresh and look at what moved); the dialect is BREAKING.
  checks += 1;
  if (canon(served?.openapi) !== canon(vendored?.openapi)) {
    breaking.push(`openapi: served ${show(served?.openapi)}, vendored ${show(vendored?.openapi)}`);
  }
  checks += 1;
  if (canon(served?.info?.version) !== canon(vendored?.info?.version)) {
    stale.push(
      `info.version: served ${show(served?.info?.version)}, vendored ${show(vendored?.info?.version)}`,
    );
  }

  // 1. Paths, methods, and the operation surface under each method. A path and a
  // verb that both exist prove nothing about the request a client must send or
  // the response it must parse, which is where a new required query parameter, a
  // 200 retargeted to ErrorResponse and a dropped auth requirement all live.
  const servedPaths = keysOf(served?.paths);
  const vendoredPaths = keysOf(vendored?.paths);

  checks += servedPaths.length + setDiff(vendoredPaths, servedPaths).length;
  for (const p of setDiff(servedPaths, vendoredPaths))
    stale.push(`path ${sanitize(p)} is served but not vendored`);
  for (const p of setDiff(vendoredPaths, servedPaths)) {
    breaking.push(`path ${sanitize(p)} is vendored but no longer served`);
  }

  /**
   * `servers` is where the bytes GO. It is an array, so the object walk skips
   * it, and nothing else here reaches the document root; `packages/spec`
   * exports this document to conformance/{python,go,rust}, where
   * `servers[0].url` is the base URL a generated client bakes in.
   *
   * Compared as an ORDERED list of urls, and this is where it parts company
   * with `security`. There every entry is an alternative, so an added one
   * leaves every existing client working and is STALE. Here the FIRST element
   * is the base URL a generator bakes in, so position is the contract:
   * `d.servers.unshift({url:"https://evil.example"})` removes nothing, so a
   * sorted set diff is empty, and the writer refuses only on
   * `breaking.length > 0` (the reformat preserves array order). So an addition
   * and a pure reorder are BREAKING here, as is a removal (a client built
   * against the vendored copy is pointed at a host the producer disowns).
   * `description` is prose and is not read.
   */
  const serverUrls = (list) =>
    (Array.isArray(list) ? list : []).map((e) =>
      isObj(e) && typeof e.url === "string" ? e.url : canon(e),
    );

  const compareServers = (label, sList, vList) => {
    if (!Array.isArray(sList) && !Array.isArray(vList)) return;
    checks += 1;
    const s = serverUrls(sList);
    const v = serverUrls(vList);
    const gone = setDiff(v, s);
    const added = setDiff(s, v);
    for (const u of gone) breaking.push(`${label} servers: served no longer offers ${sanitize(u)}`);
    for (const u of added) {
      breaking.push(
        `${label} servers: served also offers ${sanitize(u)} at index ${s.indexOf(u)}, and index 0 is the base URL a generated client bakes in`,
      );
    }
    // A pure permutation adds and removes nothing, so both diffs above are
    // empty while the base URL a generator reads has still changed.
    if (gone.length === 0 && added.length === 0 && s.join("\u0000") !== v.join("\u0000")) {
      breaking.push(
        `${label} servers: same urls in a new order -- served leads with ${sanitize(s[0])}, vendored with ${sanitize(v[0])}`,
      );
    }
  };

  compareServers("document", served?.servers, vendored?.servers);

  /**
   * Parameters keyed on `in:name` -- the pair that identifies one, since a
   * `query` and a `path` parameter may share a name. Path-item parameters apply
   * to every operation under it, so both levels are collected. A `$ref`'d
   * parameter keys on the ref, whose target is compared by the `$ref` constraint.
   */
  const paramsOf = (item, op) => {
    const out = new Map();
    for (const list of [item?.parameters, op?.parameters]) {
      if (!Array.isArray(list)) continue;
      for (const p of list) {
        if (!isObj(p)) continue;
        out.set(
          typeof p.$ref === "string" ? p.$ref : `${p.in ?? "(no in)"}:${p.name ?? "(no name)"}`,
          p,
        );
      }
    }
    return out;
  };

  /**
   * An operation with no `security` of its own inherits the document's, so the
   * requirement sets are compared EFFECTIVE: moving the same requirement from
   * the root onto an operation is not a change, and dropping it from either
   * place is. Each entry is an alternative (any one satisfies the operation), so
   * a dropped entry rejects a client that was using it -- BREAKING -- while an
   * added one leaves every existing client working -- STALE. `security: []` is
   * the removal of every alternative, and reports as such.
   */
  const effectiveSecurity = (op, root) =>
    (Array.isArray(op?.security) ? op.security : Array.isArray(root) ? root : [])
      .map((r) => canon(r))
      .sort();

  /**
   * A served-only parameter or requestBody given as a local `$ref` carries its
   * `required` on the target, so it is graded on that: read off the bare ref
   * object, a newly served required `$ref` parameter would grade STALE. Chains
   * are followed by `resolveRef` (RFC 6901 §6 decoding order).
   *
   * An unresolved ref is graded BREAKING here, never on the bare ref object:
   * `isRequired({$ref})` is false, so it would read "(optional)" and
   * `generate:wire` would install with no flag a parameter whose requirements
   * nobody can read -- and an external ref is the producer pointing the
   * contract at bytes this repo never vendored. The node is remembered so the
   * document-wide `$ref` scan below does not report it a second time.
   */
  const reportedRefNodes = new Set();
  const servedOnly = (what, node) => {
    const r = resolveRef(served, node);
    if (r.unresolved) {
      reportedRefNodes.add(node);
      breaking.push(
        `${what} is served but not vendored, and its $ref ${sanitize(node.$ref)} cannot be ` +
          `resolved (${r.unresolved})`,
      );
      return;
    }
    const required = isRequired(r.node);
    (required ? breaking : stale).push(
      `${what} is served but not vendored (${required ? "required" : "optional"})`,
    );
  };

  const compareOperation = (label, sItem, vItem, sOp, vOp) => {
    operations += 1;

    const sParams = paramsOf(sItem, sOp);
    const vParams = paramsOf(vItem, vOp);
    for (const [k, sp] of sParams) {
      checks += 1;
      const vp = vParams.get(k);
      if (vp === undefined) {
        servedOnly(`${label} parameter ${sanitize(k)}`, sp);
        continue;
      }
      // No `required` comparison here: `compareNode` compares the boolean form
      // at every node under this same label, so a check here would report
      // every flip twice.
      compareNode(sp, vp, `${label} parameter ${sanitize(k)}`);
    }
    for (const k of [...vParams.keys()].filter((k) => !sParams.has(k))) {
      checks += 1;
      breaking.push(`${label} parameter ${sanitize(k)} is vendored but no longer served`);
    }

    const sSec = effectiveSecurity(sOp, served?.security);
    const vSec = effectiveSecurity(vOp, vendored?.security);
    checks += 1;
    for (const r of setDiff(vSec, sSec)) {
      breaking.push(`${label} security: served no longer accepts ${sanitize(r)}`);
    }
    for (const r of setDiff(sSec, vSec)) {
      stale.push(`${label} security: served also accepts ${sanitize(r)}`);
    }

    // An operation-level `servers` OVERRIDES the document's for that operation,
    // so one appearing on a single operation reroutes it while the root still
    // reads clean. Presence asymmetry is BREAKING on its own; when both declare
    // one, the url sets are compared like any other.
    const sOverride = Array.isArray(sOp?.servers);
    const vOverride = Array.isArray(vOp?.servers);
    if (sOverride || vOverride) {
      checks += 1;
      if (sOverride !== vOverride) {
        breaking.push(
          sOverride
            ? `${label} servers: served declares an operation-level override, vendored has none`
            : `${label} servers: vendored declares an operation-level override, served has none`,
        );
      } else {
        compareServers(label, sOp.servers, vOp.servers);
      }
    }

    const sBody = sOp?.requestBody;
    const vBody = vOp?.requestBody;
    if (isObj(sBody) || isObj(vBody)) {
      checks += 1;
      if (!isObj(vBody)) {
        servedOnly(`${label} requestBody`, sBody);
      } else if (!isObj(sBody)) {
        breaking.push(`${label} requestBody is vendored but no longer served`);
      } else {
        // `requestBody.required` is compared by `compareNode` under this same
        // label, as for parameters above.
        compareNode(sBody, vBody, `${label} requestBody`);
      }
    }

    const sCodes = keysOf(sOp?.responses);
    const vCodes = keysOf(vOp?.responses);
    checks += sCodes.length + setDiff(vCodes, sCodes).length;
    for (const c of setDiff(sCodes, vCodes))
      stale.push(`${label} response ${sanitize(c)} is served but not vendored`);
    for (const c of setDiff(vCodes, sCodes)) {
      breaking.push(`${label} response ${sanitize(c)} is vendored but no longer served`);
    }
    for (const c of sCodes.filter((c) => vCodes.includes(c))) {
      // The response object, not only its schema: a `$ref` to
      // `#/components/responses/*` lives at this level, and the JSON body schema
      // is reached through `content` by the same walk.
      compareNode(sOp.responses[c], vOp.responses[c], `${label} response ${sanitize(c)}`);
    }
  };

  const sharedPaths = servedPaths.filter((p) => vendoredPaths.includes(p));
  for (const p of sharedPaths) {
    const sItem = served.paths[p];
    const vItem = vendored.paths[p];
    const pathLabel = `path ${sanitize(p)}`;

    // A path item is a NODE, not a bag of methods, and the loop below
    // enumerates only its verbs, so every other Path Item Object key needs its
    // own axis. OpenAPI 3.0.3 gives a path-item `servers` array precedence over
    // the document's for every operation under the path, so one appearing
    // reroutes the WHOLE path. Presence asymmetry is BREAKING on its own,
    // exactly as the operation-level override is graded.
    const sPathServers = Array.isArray(sItem?.servers);
    const vPathServers = Array.isArray(vItem?.servers);
    if (sPathServers || vPathServers) {
      checks += 1;
      if (sPathServers !== vPathServers) {
        breaking.push(
          sPathServers
            ? `${pathLabel} servers: served declares a path-item override, vendored has none`
            : `${pathLabel} servers: vendored declares a path-item override, served has none`,
        );
      } else {
        compareServers(pathLabel, sItem.servers, vItem.servers);
      }
    }

    // A path-item `$ref` REPLACES the whole item, so the methods compared below
    // are not the ones a client is held to.
    const sPathRef = sItem?.$ref;
    const vPathRef = vItem?.$ref;
    if (sPathRef !== undefined || vPathRef !== undefined) {
      checks += 1;
      if (sPathRef === undefined || vPathRef === undefined) {
        breaking.push(
          sPathRef === undefined
            ? `${pathLabel}.$ref: vendored replaces the whole path item with ${show(vPathRef)}, served has none`
            : `${pathLabel}.$ref: served replaces the whole path item with ${show(sPathRef)}, vendored has none`,
        );
      } else if (canon(sPathRef) !== canon(vPathRef)) {
        breaking.push(`${pathLabel}.$ref: served ${show(sPathRef)}, vendored ${show(vPathRef)}`);
      }
    }

    const s = methodsOf(sItem);
    const v = methodsOf(vItem);
    checks += s.length + setDiff(v, s).length;
    for (const m of setDiff(s, v))
      stale.push(`${m.toUpperCase()} ${sanitize(p)} is served but not vendored`);
    for (const m of setDiff(v, s))
      breaking.push(`${m.toUpperCase()} ${sanitize(p)} is vendored but no longer served`);
    for (const m of s.filter((m) => v.includes(m))) {
      compareOperation(`${m.toUpperCase()} ${sanitize(p)}`, sItem, vItem, sItem[m], vItem[m]);
    }
  }

  // 2. The `components` sections, by name, then each shared section's members.
  // The section set is diffed rather than three names being hardcoded, so a
  // section the server adds is reported instead of going unchecked
  // (`securitySchemes` carries the only description of how a client
  // authenticates).
  const sections = (doc) => (isObj(doc?.components) ? Object.keys(doc.components) : []);
  const servedSections = sections(served);
  const vendoredSections = sections(vendored);
  checks += servedSections.length + setDiff(vendoredSections, servedSections).length;
  for (const n of setDiff(servedSections, vendoredSections)) {
    stale.push(`components.${sanitize(n)} is served but not vendored`);
  }
  for (const n of setDiff(vendoredSections, servedSections)) {
    breaking.push(`components.${sanitize(n)} is vendored but no longer served`);
  }

  // `schemas` and `responses` are schema/response objects the node walk covers.
  // Everything else -- `securitySchemes` today -- has a SCALAR contract (`type`,
  // `scheme`, `in`, `name`) that the node walk does not compare, so it is
  // compared whole with prose stripped: renaming the API-key header from
  // `X-API-Key` is a client break.
  const NODE_SECTIONS = new Set(["schemas", "responses"]);
  const counts = {};
  for (const section of servedSections.filter((n) => vendoredSections.includes(n))) {
    const sMembers = isObj(served.components[section]) ? served.components[section] : {};
    const vMembers = isObj(vendored.components[section]) ? vendored.components[section] : {};
    const sNames = keysOf(sMembers);
    const vNames = keysOf(vMembers);
    checks += sNames.length + setDiff(vNames, sNames).length;
    for (const n of setDiff(sNames, vNames)) {
      stale.push(`components.${sanitize(section)}.${sanitize(n)} is served but not vendored`);
    }
    for (const n of setDiff(vNames, sNames)) {
      breaking.push(
        `components.${sanitize(section)}.${sanitize(n)} is vendored but no longer served`,
      );
    }
    const shared = sNames.filter((n) => vNames.includes(n));
    counts[section] = shared.length;
    for (const n of shared) {
      const label = `components.${sanitize(section)}.${sanitize(n)}`;
      if (NODE_SECTIONS.has(section)) {
        const before = checks;
        compareNode(sMembers[n], vMembers[n], label);
        // Nothing this differ knows how to compare. Counted and reported rather
        // than folded into the total, because a name that matched is not a
        // schema checked.
        if (section === "schemas" && checks === before) nameOnly += 1;
        continue;
      }
      checks += 1;
      if (canon(withoutProse(sMembers[n])) !== canon(withoutProse(vMembers[n]))) {
        breaking.push(
          `${label}: served ${show(withoutProse(sMembers[n]))}, vendored ${show(withoutProse(vMembers[n]))}`,
        );
      }
    }
  }

  // 3. Every `$ref` the served document carries, wherever it sits. The walks
  // above follow the vendored document's shape, so a served-only subtree (a
  // new property, path, response, component or nested `items`/`allOf`) is
  // graded STALE by its NAME and never entered, which would let a served-only
  // `{$ref: "#/components/schemas/DoesNotExist"}` or an external ref install
  // as an optional addition. A ref that does not resolve (external, malformed,
  // dangling or cyclic; `resolveRef`) is BREAKING: the contract at that node
  // is unreadable, or is bytes this repo never vendored. A ref the vendored
  // copy already fails to resolve at the SAME location is not a change and is
  // not reported, or one accepted `--allow-breaking` would turn the nightly
  // probe permanently red.
  const vendoredUnresolved = unresolvedRefs(vendored, "vendored");
  for (const [ref, { reason, hits }] of unresolvedRefs(served, "served")) {
    const known = new Set((vendoredUnresolved.get(ref)?.hits ?? []).map((h) => h.loc));
    const fresh = hits.filter((h) => !reportedRefNodes.has(h.node) && !known.has(h.loc));
    if (fresh.length === 0) continue;
    breaking.push(
      `$ref ${sanitize(ref)} cannot be resolved in the served document (${reason}), at ` +
        `${sanitize(fresh[0].loc, 2 * MAX_FRAGMENT_CHARS)}` +
        (fresh.length > 1 ? ` and ${fresh.length - 1} other place(s)` : ""),
    );
  }

  return {
    breaking,
    stale,
    stats: {
      nodes,
      checks,
      operations,
      sharedPaths: sharedPaths.length,
      sharedSchemas: counts.schemas ?? 0,
      sharedResponses: counts.responses ?? 0,
      sharedSchemes: counts.securitySchemes ?? 0,
      nameOnly,
    },
  };
};
