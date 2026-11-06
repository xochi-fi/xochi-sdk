/**
 * Error-body redaction for `ApiError.message` and its log line: a capped,
 * redacted excerpt of the error body, never the raw body.
 *
 * An error body (any non-ok response) is read up to its first 8 KiB and no
 * further: reading stops once the cap is full (a body that fills it counts as
 * cut), and the rest is cancelled unread. Everything below works on that
 * prefix. A cut JSON body does not parse, so `takeApiErrorReadToken` reads its
 * token from the prefix by strict match (`readTokenFromPrefix`).
 *
 * The excerpt, in order:
 * 1. `\u{…}`, `\uXXXX`, `\xXX`, JSON's `\n`, `\r`, `\t`, `\b`, `\f` and `\/`,
 *    `%XX` (as UTF-8) and numeric `&#…;` escapes (any number of leading zeros,
 *    `;` optional) are decoded, every non-ASCII character but a space is folded
 *    to its compatibility form (NFKD: fullwidth `Ａ１` reads `A1`), then
 *    invisible characters (format and default-ignorable characters, controls
 *    other than tab and line breaks) and complete markup tags (`<p>`, `</b>`,
 *    `<a …>`, `<!…>`, `<?…>`; a bare `<` is text) are removed; this repeats for
 *    nesting up to three deep, and a body still changing after that is shown
 *    as `[redacted]` alone. Backslashes as text stay as written: backslash
 *    escapes are read left to right with JSON's `\\` as a pair, so no escape
 *    starts at the backslash a pair ends (`C:\\keys\\nAbc`, `C:\\u0041` and
 *    `C:\\x41` keep their `n`, `u0041` and `x41`), and nothing decodes to a
 *    backslash (`\u005c`, `\x5c`, `%5C`, `&#92;` and a fullwidth `＼` stay as
 *    written), so no decoded backslash escapes the character after it.
 * 2. The result is cut to its first 2048 characters. After a cut, here or by
 *    the 8 KiB read, an unclosed tag at the end and the base64url run or
 *    unfinished escape the cut ends in are dropped, and `…` appended.
 * 3. Possible tokens are collected from the whole prefix: the body's own
 *    `read_token`, the value after any read-token key (`read_token`,
 *    `readToken`, `X-Xochi-Read-Token`, any case, quoted or escaped), and, both
 *    decoded and as written (decoding a raw `\n` eats the first character of a
 *    token written after a backslash, whole or split), every base64url run of
 *    at least 43 characters that is not hex and every token split into pieces:
 *    combining marks and non-ASCII spaces or line separators between base64url
 *    characters are ignored, and pieces of 8 or more characters that are not
 *    hex and hold a digit, `-`, `_` or mixed case are joined across one space,
 *    tab, `.`, `,`, `;`, `|`, `/` or line break (LF, CRLF or a lone CR; after a
 *    line break that follows a piece of 16 or more that is not a name, the last
 *    piece may be any run) when they make at least 43 characters. A piece that
 *    reads as a CamelCase or `snake_case` name (`PermitWitnessTransferFrom`,
 *    `pull_failed`) joins only when the unbroken sequence of linked pieces it
 *    sits in holds one that does not: a list of names stays readable, and
 *    random pieces that happen to read as names, one or several in a row, do
 *    not break the chain they sit in.
 * 4. Every 16-character fragment of a possible token, in base64url, standard
 *    base64, or hex of its bytes or of its characters (any case), is replaced
 *    wherever it appears, matched with every character outside that alphabet
 *    ignored (`0x` prefixes too), so separators inside an echo hide nothing;
 *    the span it covers, separators included, is replaced.
 * 5. The value after any read-token key, and every base64url run of at least
 *    43 characters that is not hex, are replaced.
 *
 * Tx hashes and `0x` addresses stay readable; any other long base64url value
 * (a base58 address, an opaque id, two ids one space apart) is redacted too,
 * with its fragments.
 *
 * Not covered: an echo of a token no read-token key in the prefix names, and
 * that is not a base64url run or a joinable split of one (its hex, its
 * standard base64, its raw bytes as `\xNN`, a split piece under 8 characters
 * or reading as a word, pieces that all read as names with no other piece in
 * their chain, or pieces split by any other separator or by more than one
 * character, such as `, `, `:` or a nested JSON string's `\\n`); and a piece
 * of under 16 characters with other base64url text on both sides, or left at a
 * cut. A 16-character window is 96 random bits, so what stays readable of a
 * token is a piece shorter than that.
 */

import { READ_TOKEN_LENGTH, READ_TOKEN_PATTERN } from "../shared/index.js";

/** The most of an error body ever read (bytes); the rest is cancelled unread. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;
/** The most of a normalized error body that reaches `ApiError.message`. */
const MAX_ERROR_EXCERPT_CHARS = 2048;
/** Normalization passes for nested escaping (`%2522`, `\\u0022`); each pass is linear. */
const NORMALIZE_PASSES = 3;
/**
 * The window a possible read token is redacted by: every run of this many of
 * its characters, in any of its forms and with separators ignored, is hidden
 * wherever it appears. 16 base64url characters are 96 random bits, so a window
 * never matches unrelated text by chance; what a split can leave readable of a
 * token is a piece shorter than this, with other text on both sides.
 */
const TOKEN_FRAGMENT_CHARS = 16;
const REDACTED = "[redacted]";
/** A read-token key (`read_token`, `readToken`, `X-Xochi-Read-Token`) and the value it opens. */
const READ_TOKEN_KEYED_VALUE = /(read[_-]?token\\*["']?\s*[:=]\s*\\*["']?)([A-Za-z0-9_-]+)/gi;
/** A base64url run at least a read token long (greedy from its first character: maximal). */
const LONG_BASE64URL_RUN = new RegExp(`[A-Za-z0-9_-]{${READ_TOKEN_LENGTH},}`, "g");
const BASE64URL_RUN = /[A-Za-z0-9_-]+/g;
const HEX_RUN = /^(?:0x)?[0-9a-fA-F]+$/;
const HEX_DIGIT = /[0-9a-fA-F]/;
/** What renders as nothing: format and default-ignorable characters, controls but tab and line breaks. */
const INVISIBLE = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Separators that split no word of ASCII text, between two base64url
 * characters: combining marks, and every space and line separator but U+0020.
 */
const RUN_JOINER =
  /(?<=[A-Za-z0-9_-])[\p{M}\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+(?=[A-Za-z0-9_-])/gu;
/**
 * What `normalizeOnce` folds with NFKD, one character at a time: every
 * non-ASCII character but a space, so fullwidth `Ａ１` reads `A1`. Spaces are
 * left for `RUN_JOINER` (NFKD would turn a no-break space into U+0020, which
 * splits a token), and NFKC is not used, since it would compose a combining
 * mark that splits a token into one letter outside base64url.
 */
const COMPATIBILITY_FOLDED = /[^\x00-\x7f\p{Zs}]/gu;
/**
 * What may sit between two pieces of a split token: one space, tab, `.`, `,`,
 * `;`, `|` or `/`, or a line break (LF, CRLF or a lone CR).
 */
const PIECE_GAP = /^(?:[ \t.,;|/]|(?:\r?\n|\r)[ \t]*)$/;
/** A name: CamelCase (`PermitWitnessTransferFrom`) or snake_case (`pull_failed`); a token piece only in a chain holding one that is not (`splitTokens`). */
const IDENTIFIER = /^(?:(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+)$/;
/** Complete markup: an element tag (`<p>`, `</b>`, `<a href=…>`), `<!…>` or `<?…>`; never a bare `<`. */
const MARKUP_TAG = /<(?:\/?[A-Za-z][^<>]*|[!?][^<>]*)>/g;
const UNCLOSED_TRAILING_TAG = /<(?:\/?[A-Za-z]|[!?])[^<>]*$/;
/** What the end of a cut excerpt may hold of a token or an unfinished escape. */
const CUT_TAIL_CHAR = /[A-Za-z0-9_%\\&#{-]/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * At most the first `MAX_ERROR_BODY_BYTES` of a body, and whether any of it
 * went unread. Reading stops once the cap is full, without waiting for the
 * body to end (a body that fills the cap counts as cut), and the rest is
 * cancelled, so a huge, endless or stalled error body costs a bounded read.
 * A body that fails mid-read yields what arrived before the failure, marked
 * truncated.
 */
export async function readCappedBytes(
  response: Response,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_ERROR_BODY_BYTES);
  let size = 0;
  let truncated = false;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_ERROR_BODY_BYTES - size;
      bytes.set(value.subarray(0, room), size);
      size += Math.min(value.byteLength, room);
    }
    if (size === MAX_ERROR_BODY_BYTES) truncated = true;
  } catch {
    // A failed body read is a cut: what arrived is kept, and treated as cut.
    truncated = true;
  }
  reader.cancel().catch(() => {});
  return { bytes: bytes.subarray(0, size), truncated };
}

/** `readCappedBytes` as UTF-8 text (a character split by the cap becomes U+FFFD). */
export async function readCappedText(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readCappedBytes(response);
  return { text: new TextDecoder().decode(bytes), truncated };
}

/**
 * A run of `%XX` escapes decoded as UTF-8 (an invalid sequence becomes
 * U+FFFD). `%5C` is never part of a run (`PERCENT_RUN`): it stays as written.
 */
function decodePercentRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  return new TextDecoder().decode(bytes);
}

/**
 * The character `codePoint` names, or `escape` itself when it names none or
 * names a backslash: a decoded backslash would escape the character after it
 * on the next pass (`\u005cnAbc…` would lose its `n`), so an escape for one
 * stays as written, as a written backslash pair does.
 */
function codePointOr(escape: string, codePoint: number): string {
  return codePoint <= 0x10ffff && codePoint !== 0x5c ? String.fromCodePoint(codePoint) : escape;
}

/**
 * What JSON's short escapes for a separator or a control character stand for.
 * `\"` and `\\` stay as written: neither character joins or splits a token,
 * and decoding `\\` would halve a run of backslashes on every pass.
 */
const JSON_SHORT_ESCAPE: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "/": "/",
};

/**
 * Every backslash escape `normalizeOnce` reads, in one alternation scanned
 * left to right: an escaped backslash (`\\`) is consumed as a pair before any
 * escape could start at its second backslash, so the backslash it ends never
 * escapes what follows (`C:\\keys\\nAbc…`, `C:\\u0041` and `C:\\x41` keep
 * their `n`, `u0041` and `x41`).
 */
const BACKSLASH_ESCAPE =
  /\\(?:\\|u\{0*([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbf/]))/g;
/** A run of `%XX` escapes, never `%5C` (a backslash, kept as written: `codePointOr`). */
const PERCENT_RUN = /(?:%(?![5][cC])[0-9a-fA-F]{2})+/g;

/**
 * One linear normalization pass: decode `\u{…}`, `\uXXXX`, `\xXX`, the JSON
 * escapes `\n`, `\r`, `\t`, `\b`, `\f` and `\/` (`BACKSLASH_ESCAPE`), `%XX`
 * and numeric character references (any number of leading zeros, `;`
 * optional), fold every non-ASCII character but a space to its compatibility
 * form (`COMPATIBILITY_FOLDED`), then drop invisible characters and complete
 * markup tags, so a token split or disguised by any of these reads whole
 * again. Nothing decodes or folds to a backslash: an escape or character
 * standing for one stays as written (`codePointOr`). A JSON error body writes
 * every line break and tab in a string as an escape, so without them a token
 * split across lines would read a letter (`n`) between its pieces, which no
 * separator rule skips.
 */
function normalizeOnce(text: string): string {
  return text
    .replace(
      BACKSLASH_ESCAPE,
      (
        escape: string,
        braced: string | undefined,
        u4: string | undefined,
        x2: string | undefined,
        short: string | undefined,
      ) => {
        if (short !== undefined) return JSON_SHORT_ESCAPE[short];
        const hex = braced ?? u4 ?? x2;
        return hex === undefined ? escape : codePointOr(escape, parseInt(hex, 16));
      },
    )
    .replace(PERCENT_RUN, decodePercentRun)
    .replace(
      /&#(?:[xX]0*([0-9a-fA-F]{1,6})|0*([0-9]{1,7}));?/g,
      (ref: string, hex: string | undefined, dec: string | undefined) =>
        codePointOr(ref, hex === undefined ? Number(dec) : parseInt(hex, 16)),
    )
    .replace(COMPATIBILITY_FOLDED, (char: string) => {
      const folded = char.normalize("NFKD");
      return folded.includes("\\") ? char : folded;
    })
    .replace(INVISIBLE, "")
    .replace(MARKUP_TAG, "");
}

/**
 * Whether a base64url run has the shape of a piece of a random token: at
 * least 8 characters, not hex, holding a digit, `-` or `_`, or mixing cases
 * past its first character. One that reads as a name (`IDENTIFIER`) is a
 * token piece only in a chain that holds one that does not (`splitTokens`).
 */
function pieceShaped(run: string): boolean {
  return (
    run.length >= 8 &&
    !HEX_RUN.test(run) &&
    (/[0-9_-]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run.slice(1))))
  );
}

/**
 * Tokens split by ASCII separators, joined: chains of piece-shaped runs
 * (`pieceShaped`), one `PIECE_GAP` apart, at least a token long together. A
 * run that reads as a name (`IDENTIFIER`) joins only when the unbroken
 * sequence of linked piece-shaped runs it sits in holds one that does not: a
 * list of real names stays readable, and random pieces that happen to read
 * as CamelCase, one or several in a row, do not break the chain they sit in.
 * After a line break that follows a piece of `TOKEN_FRAGMENT_CHARS` or more
 * (a hard wrap), the run that ends the chain may be of any shape.
 */
function splitTokens(text: string): string[] {
  const runs: { run: string; piece: boolean; name: boolean; linked: boolean; wrap: boolean }[] = [];
  let end = 0;
  for (const match of text.matchAll(BASE64URL_RUN)) {
    const [run] = match;
    const gap = text.slice(end, match.index);
    end = match.index + run.length;
    const shaped = pieceShaped(run);
    const name = IDENTIFIER.test(run);
    runs.push({
      run,
      piece: shaped && !name,
      name: shaped && name,
      linked: PIECE_GAP.test(gap),
      wrap: /[\r\n]/.test(gap),
    });
  }
  // Whether each run's unbroken sequence of linked piece-shaped runs holds a
  // piece that is not a name.
  const nearPiece = new Array<boolean>(runs.length).fill(false);
  for (let start = 0; start < runs.length; ) {
    let stop = start + 1;
    if (runs[start].piece || runs[start].name) {
      while (stop < runs.length && runs[stop].linked && (runs[stop].piece || runs[stop].name)) {
        stop++;
      }
    }
    const holdsPiece = runs.slice(start, stop).some((r) => r.piece);
    nearPiece.fill(holdsPiece, start, stop);
    start = stop;
  }
  const joinable = (i: number): boolean => runs[i].piece || (runs[i].name && nearPiece[i]);
  const found: string[] = [];
  let chain: string[] = [];
  // Whether the chain may take another run: a hard-wrap tail ends it.
  let open = false;
  const flush = () => {
    const joined = chain.join("");
    if (chain.length > 1 && joined.length >= READ_TOKEN_LENGTH) found.push(joined);
    chain = [];
    open = false;
  };
  for (let i = 0; i < runs.length; i++) {
    const { run, linked, wrap } = runs[i];
    const prev = runs[i - 1];
    if (open && linked && joinable(i)) {
      chain.push(run);
    } else if (open && linked && wrap && prev.piece && prev.run.length >= TOKEN_FRAGMENT_CHARS) {
      chain.push(run);
      open = false;
    } else {
      flush();
      if (joinable(i)) {
        chain = [run];
        open = true;
      }
    }
  }
  flush();
  return found;
}

/**
 * Every value of a body that may be a read token: the body's own `read_token`,
 * the value after any read-token key, and every base64url run at least a
 * token long that is not hex and every token split into pieces
 * (`RUN_JOINER` separators removed, `splitTokens` across ASCII ones), each in
 * the normalized prefix and in the undecoded one. Read from the whole prefix,
 * so an echo before the cut is caught even when the token itself lies past
 * it.
 */
function possibleTokens(body: string, text: string): string[] {
  const tokens: string[] = [];
  const served = parseJsonObject(body)?.read_token;
  if (typeof served === "string" && READ_TOKEN_PATTERN.test(served)) tokens.push(served);
  const joined = text.replace(RUN_JOINER, "");
  for (const [, , value] of joined.matchAll(READ_TOKEN_KEYED_VALUE)) tokens.push(value);
  // The undecoded prefix too: decoding a raw `\n`, `\t`, … eats the first
  // character of a token written right after a backslash (`C:\keys\nAbc…`),
  // whole or split, leaving a run or chain one character short of a token.
  for (const source of [joined, body.replace(RUN_JOINER, "")]) {
    for (const [run] of source.matchAll(LONG_BASE64URL_RUN)) {
      if (!HEX_RUN.test(run)) tokens.push(run);
    }
    tokens.push(...splitTokens(source));
  }
  return tokens;
}

/** The bytes a base64url string encodes, as lowercase hex. */
function base64urlHex(value: string): string {
  let hex = "";
  let acc = 0;
  let bits = 0;
  for (const char of value) {
    acc = ((acc << 6) | BASE64URL_ALPHABET.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/** An ASCII string's character codes as lowercase hex. */
function asciiHex(value: string): string {
  let hex = "";
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/**
 * The characters of `text` in one alphabet, each with its index in `text`:
 * what a token reads as once every separator around or inside it is ignored.
 * The hex alphabet is folded to lower case and skips `0x` prefixes.
 */
function skeleton(text: string, alphabet: RegExp, hex: boolean): { chars: string; at: number[] } {
  let chars = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (
      hex &&
      text[i] === "0" &&
      /[xX]/.test(text[i + 1] ?? "") &&
      HEX_DIGIT.test(text[i + 2] ?? "")
    ) {
      i++;
      continue;
    }
    if (!alphabet.test(text[i])) continue;
    chars += hex ? text[i].toLowerCase() : text[i];
    at.push(i);
  }
  return { chars, at };
}

/**
 * `text` with every `TOKEN_FRAGMENT_CHARS`-long fragment of each token hidden,
 * in base64url, standard base64 or hex (of its bytes or of its characters, any
 * case), matched on the text's `skeleton` in that alphabet: a fragment is
 * found whatever separators split it, and the span it covers, separators
 * included, is hidden. Overlapping spans merge into one `[redacted]`.
 */
function redactTokenFragments(text: string, tokens: readonly string[]): string {
  const width = TOKEN_FRAGMENT_CHARS;
  const base64url = new Set<string>();
  const base64 = new Set<string>();
  const hex = new Set<string>();
  const addFragments = (into: Set<string>, form: string) => {
    for (let i = 0; i + width <= form.length; i++) into.add(form.slice(i, i + width));
  };
  for (const token of tokens) {
    addFragments(base64url, token);
    addFragments(base64, token.replace(/-/g, "+").replace(/_/g, "/"));
    addFragments(hex, base64urlHex(token));
    addFragments(hex, asciiHex(token));
  }
  if (base64url.size === 0) return text;
  const hidden = new Uint8Array(text.length);
  const forms: [Set<string>, { chars: string; at: number[] }][] = [
    [base64url, skeleton(text, /[A-Za-z0-9_-]/, false)],
    [base64, skeleton(text, /[A-Za-z0-9+/]/, false)],
    [hex, skeleton(text, HEX_DIGIT, true)],
  ];
  for (const [fragments, { chars, at }] of forms) {
    for (let i = 0; i + width <= chars.length; i++) {
      if (fragments.has(chars.slice(i, i + width))) hidden.fill(1, at[i], at[i + width - 1] + 1);
    }
  }
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (!hidden[i]) {
      out += text[i++];
      continue;
    }
    out += REDACTED;
    while (i < text.length && hidden[i]) i++;
  }
  return out;
}

/**
 * An error body's capped prefix (`readCappedText`) made fit for
 * `ApiError.message` and the logs: the redaction rule in this module's header,
 * applied in its order. Every step is linear in the prefix.
 */
export function redactErrorBody(body: string, truncated: boolean): string {
  // Decode before cutting, so the cut never splits an escape mid-token.
  let text = body;
  for (let pass = 0; ; pass++) {
    const next = normalizeOnce(text);
    if (next === text) break;
    // Still unwrapping after the last pass: nothing of it is shown.
    if (pass === NORMALIZE_PASSES) return REDACTED;
    text = next;
  }
  const tokens = possibleTokens(body, text);
  let cut = truncated;
  if (text.length > MAX_ERROR_EXCERPT_CHARS) {
    text = text.slice(0, MAX_ERROR_EXCERPT_CHARS);
    cut = true;
  }
  // A cut may have split a tag, an escape or a token: drop what it ends in.
  if (cut) {
    text = text.replace(UNCLOSED_TRAILING_TAG, "");
    let end = text.length;
    while (end > 0 && CUT_TAIL_CHAR.test(text[end - 1])) end--;
    text = `${text.slice(0, end)}…`;
  }
  return redactTokenFragments(text, tokens)
    .replace(READ_TOKEN_KEYED_VALUE, `$1${REDACTED}`)
    .replace(LONG_BASE64URL_RUN, (run) => (HEX_RUN.test(run) ? run : REDACTED));
}

/** `"intent_id": "…"` and the opening of a `read_token` key in a JSON prefix. */
const PREFIX_INTENT_ID = /"intent_id"\s*:\s*"([^"\\]*)"/g;
const PREFIX_READ_TOKEN_KEY = /"read_token"\s*:/g;
const PREFIX_READ_TOKEN = new RegExp(
  `"read_token"\\s*:\\s*"([A-Za-z0-9_-]{${READ_TOKEN_LENGTH}})"`,
);

/**
 * The object/array nesting depth at `index` of a JSON prefix, counted outside
 * strings, or -1 when `index` lies inside a string or past the close of the
 * value the prefix opens.
 */
function jsonDepthAt(prefix: string, index: number): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < index; i++) {
    const c = prefix[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if ((c === "}" || c === "]") && --depth === 0) {
      return -1;
    }
  }
  return inString ? -1 : depth;
}

/**
 * The `read_token` a cut JSON error body carries for `intentId`, read by strict
 * match from the prefix that `readCappedText` kept (a cut body does not parse).
 * Only from a prefix that opens a JSON object and names exactly one
 * `intent_id`, equal to `intentId`, and exactly one `read_token` key, whose
 * value is a whole token followed by its closing quote, both keys of that
 * object itself (depth 1), never of a value nested in it.
 */
export function readTokenFromPrefix(prefix: string, intentId: string): string | undefined {
  if (!/^\s*\{/.test(prefix)) return undefined;
  const ids = [...prefix.matchAll(PREFIX_INTENT_ID)];
  if (ids.length !== 1 || ids[0][1] !== intentId) return undefined;
  if (jsonDepthAt(prefix, ids[0].index) !== 1) return undefined;
  if ([...prefix.matchAll(PREFIX_READ_TOKEN_KEY)].length !== 1) return undefined;
  const token = PREFIX_READ_TOKEN.exec(prefix);
  return token && jsonDepthAt(prefix, token.index) === 1 ? token[1] : undefined;
}

/**
 * A response body read as a JSON object, or undefined when it is not one. The
 * one place a body becomes a field bag: every read off it is then narrowed by
 * `typeof` at the use site.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  // Validated just above as a non-array object; its fields stay `unknown`.
  return parsed as Record<string, unknown>;
}
