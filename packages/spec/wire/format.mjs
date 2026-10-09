/**
 * The vendored form of a served wire contract: sorted-key 2-space JSON with a
 * trailing newline, and every numeric LITERAL spelled exactly as the producer
 * served it.
 *
 * Why this exists rather than `JSON.stringify(JSON.parse(text), null, 2)`, which
 * is what `generate.mjs` used to write: `JSON.parse` folds every JSON number to
 * an IEEE-754 double, so the round trip re-spells literals --
 * `115792089...639935` becomes `1.157920892373162e+77`, `1e400` becomes `null`,
 * and a served `0.0` becomes `0`. `packages/spec` ships this file to
 * `sdks/{python,go,rust}`, and not every parser folds: Go's `json.Number` and
 * serde_json's `arbitrary_precision` keep the literal, so a re-spelled bound is
 * this repo asserting to those consumers a value the producer never served.
 *
 * The writer detected that lexically and REFUSED, with `--allow-renumbering` as
 * the escape. That flag was a trap and it is gone. The producer is Elixir/Jason,
 * whose float encoder emits a decimal point on every float, so the first
 * `default: 0.0` the solver adds reaches this path -- and consenting to the
 * folded spelling wrote `0` beside a served `0.0`, after which
 * `verify-openapi.mjs` lexed the two sides, found `servedOnly:['0.0']` against
 * `vendoredOnly:['0']` with an empty structural diff, and reported RE-SPELLED ->
 * exit 1 on every nightly run. Re-running the refresh reproduced the same bytes,
 * because `JSON.stringify` cannot emit `0.0`, so the remedy the probe named did
 * not exist. STALE, BREAKING and RE-SPELLED share exit 1, so the job status
 * carried no class, and a permanently red check on the one job guarding the wire
 * contract is a check somebody switches off -- after which a genuine
 * `EthAddress.pattern: "^.*$"` lands inside it unread.
 *
 * So the number is never parsed. The scanner below keeps each numeric token's
 * VERBATIM source text and the serializer emits it unchanged; the refusal it
 * replaces is now a post-condition in `generate.mjs` that must always hold.
 *
 * Everything else is byte-identical to what the `JSON.stringify` path produced,
 * which `wire-differ.test.ts` pins against the real vendored document: strings
 * are decoded and re-emitted through `JSON.stringify`, so escaping (including a
 * lone surrogate) is that function's own, and keys are sorted and then re-homed
 * on a plain object, so the integer-like ones lead in ascending numeric order
 * exactly as they did -- JS object ordering, not this sort, and deterministic
 * either way.
 *
 * Node builtins only, and nothing imported that needs building: this runs inside
 * the writer and beside the probes, whose trust path `probe-lib.mjs` keeps
 * dependency-free. `JSON.parse`'s reviver `context.source` would do the same job
 * in one line and is deliberately not used: it landed in Node 24 and
 * `.github/workflows/ci.yml` pins `node-version: '22'`, so on CI it arrives as
 * `undefined` -- the folding path, silently, which is the bug.
 */
import { IncomparableDocument, MAX_DEPTH } from "./compare.mjs";

/**
 * The input is not JSON this formatter can represent.
 *
 * It THROWS rather than falling back to `JSON.parse`: a formatter that degrades
 * quietly to the folding path reintroduces the re-spelling it exists to prevent,
 * on exactly the inputs it could not handle. The served document has already
 * been through `JSON.parse` by the time the writer calls this, so in that caller
 * this error means the two disagree about the bytes, which is a defect here and
 * not a verdict about the producer.
 */
export class MalformedDocument extends Error {}

/**
 * A number as the producer wrote it. The token is carried, never the value: the
 * loss this whole module is about happens at parse, so parsing it once "just to
 * check" would be enough to lose `1e400`.
 */
class RawNumber {
  constructor(token) {
    this.token = token;
  }
}

const isDigit = (c) => c >= "0" && c <= "9";

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Parse `text` into a tree whose numbers are `RawNumber`s, with keys sorted. */
const scan = (text) => {
  let i = 0;
  const bad = (what) => {
    throw new MalformedDocument(`${what} at offset ${i}`);
  };

  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i += 1;
      else break;
    }
  };

  const readEscape = () => {
    const e = text[i];
    i += 1;
    if (e === "u") {
      const hex = text.slice(i, i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad("an invalid \\u escape");
      i += 4;
      return String.fromCharCode(parseInt(hex, 16));
    }
    const mapped = ESCAPES[e];
    if (mapped === undefined) bad("an invalid string escape");
    return mapped;
  };

  const readString = () => {
    i += 1; // the opening quote
    let out = "";
    let run = i;
    for (;;) {
      if (i >= text.length) bad("an unterminated string");
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        out += text.slice(run, i);
        i += 1;
        return out;
      }
      if (code === 0x5c) {
        out += text.slice(run, i);
        i += 1;
        out += readEscape();
        run = i;
        continue;
      }
      // JSON forbids a raw control character in a string, and accepting one
      // would make this formatter's output differ from its input by more than
      // whitespace: `JSON.stringify` escapes it on the way back out.
      if (code < 0x20) bad("an unescaped control character in a string");
      i += 1;
    }
  };

  /**
   * The JSON number grammar, enforced rather than assumed. A token this rejects
   * is one `JSON.parse` rejects too, and emitting an unvalidated run of
   * `0123456789.eE+-` verbatim would let `1.2.3` or a bare `-` through into a
   * file the SDKs parse.
   */
  const readNumber = () => {
    const start = i;
    if (text[i] === "-") i += 1;
    if (text[i] === "0") i += 1;
    else if (isDigit(text[i])) while (isDigit(text[i])) i += 1;
    else bad("a number with no integer part");
    if (text[i] === ".") {
      i += 1;
      if (!isDigit(text[i])) bad("a fraction with no digits");
      while (isDigit(text[i])) i += 1;
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      if (!isDigit(text[i])) bad("an exponent with no digits");
      while (isDigit(text[i])) i += 1;
    }
    return new RawNumber(text.slice(start, i));
  };

  const word = (literal, value) => {
    if (text.startsWith(literal, i)) {
      i += literal.length;
      return { value };
    }
    return null;
  };

  /**
   * `depth` is the reformat's own bound, imported from the differ rather than
   * retyped, and checked for every node type exactly as the `sortKeys` this
   * replaces did: a `const` payload nested a few hundred thousand deep used to
   * exhaust the stack and exit on a `RangeError` instead of producing the
   * INCONCLUSIVE a document nobody walked deserves.
   */
  const value = (depth) => {
    if (depth > MAX_DEPTH) {
      throw new IncomparableDocument(
        `nesting deeper than ${MAX_DEPTH} while reformatting. The real contract nests 12 deep, ` +
          "so this is not that document; it was not reformatted.",
      );
    }
    if (i >= text.length) bad("end of input where a value was expected");
    const c = text[i];
    if (c === '"') return readString();
    if (c === "-" || isDigit(c)) return readNumber();
    if (c === "{") {
      i += 1;
      const entries = [];
      ws();
      if (text[i] === "}") {
        i += 1;
      } else {
        for (;;) {
          ws();
          if (text[i] !== '"') bad("an object key that is not a string");
          const k = readString();
          ws();
          if (text[i] !== ":") bad("an object member with no colon");
          i += 1;
          ws();
          entries.push([k, value(depth + 1)]);
          ws();
          if (text[i] === ",") {
            i += 1;
            continue;
          }
          if (text[i] === "}") {
            i += 1;
            break;
          }
          bad("an unclosed object");
        }
      }
      // Sorted here, and `Object.fromEntries` then applies JS's own key order on
      // top -- integer-like keys first, ascending -- which is what the response
      // status-code blocks in this document are ordered by. A duplicate key
      // resolves to its LAST occurrence in the text, as `JSON.parse` does,
      // because `sort` is stable and `fromEntries` keeps the later write.
      return Object.fromEntries(entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    }
    if (c === "[") {
      i += 1;
      const out = [];
      ws();
      if (text[i] === "]") {
        i += 1;
        return out;
      }
      for (;;) {
        ws();
        out.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return out;
        }
        bad("an unclosed array");
      }
    }
    const literal = word("true", true) ?? word("false", false) ?? word("null", null);
    if (literal === null) bad("a value that is not JSON");
    return literal.value;
  };

  ws();
  const root = value(0);
  ws();
  if (i !== text.length) bad("trailing content after the document");
  return root;
};

/** Serialize the scanned tree the way `JSON.stringify(x, null, 2)` would. */
const write = (node, indent) => {
  if (node instanceof RawNumber) return node.token;
  if (node === null) return "null";
  if (typeof node === "string") return JSON.stringify(node);
  if (typeof node === "boolean") return node ? "true" : "false";
  const inner = `${indent}  `;
  if (Array.isArray(node)) {
    if (node.length === 0) return "[]";
    return `[\n${node.map((e) => `${inner}${write(e, inner)}`).join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(node);
  if (keys.length === 0) return "{}";
  return `{\n${keys
    .map((k) => `${inner}${JSON.stringify(k)}: ${write(node[k], inner)}`)
    .join(",\n")}\n${indent}}`;
};

/**
 * `text` (the served bytes as a string) as the vendored artifact.
 *
 * Throws `MalformedDocument` if `text` is not JSON and `IncomparableDocument` if
 * it nests past `MAX_DEPTH`; the callers report those as their own INCONCLUSIVE,
 * because a document that was not reformatted has had nothing concluded about
 * it.
 */
export const formatDocument = (text) => `${write(scan(text), "")}\n`;
