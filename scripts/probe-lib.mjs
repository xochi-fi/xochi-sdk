/**
 * Shared hazard handling for the producer-drift probes (`scripts/verify-*.mjs`,
 * scheduled by `.github/workflows/producer-drift.yml`). This header is the one
 * home for the rules and exit codes they share; each probe's header lists only
 * its own exit causes.
 *
 * Rules:
 *
 * 1. An equality assertion is informative only if at least one side is a value
 *    this repo cannot edit. The served side is that value.
 * 2. Every non-verifying outcome fails, "could not reach the server" included.
 *    Not being able to check is not evidence of agreement: no skip path, no
 *    `continue-on-error`.
 * 3. Probes run on a schedule, not per-PR. The event to detect is a server
 *    deploy, and a check that reddens honest PRs eventually gets disabled.
 *
 * Exit codes (`EXIT`):
 *
 *   0  OK: the producer and this repo agree.
 *   1  DRIFT: the producer and this repo disagree. Nothing else exits 1; a
 *      crash is 2 (`installCrashHandlers`).
 *   2  INCONCLUSIVE: nothing was compared -- unreachable, redirected, non-2xx,
 *      non-JSON, oversized or broken-off body, a required field absent, or the
 *      probe itself crashed.
 *   3  MISCONFIGURED: this machine's own state -- no server URL, a non-https or
 *      unparseable one, an unusable `PROBE_*` duration, or a local side that
 *      could not be established. Where a probe defers a local problem
 *      (`deferLocalProblem`), the producer is still sampled and its answer is
 *      reported with the exit, so a half-landed local change cannot switch the
 *      producer check off.
 *
 * Every operator- or producer-controlled string reaching a log line goes
 * through `sanitize`: these logs are public, Actions does not mask `vars.*`, and
 * a newline plus `::error title=...::` forges a workflow annotation at column 0.
 *
 * Here: the exit helpers, the `PROBE_*` env readers, the server/base-URL
 * resolution, repo-relative reads for each probe's local side, and the one
 * `fetch` shape (no-cache, unfollowed redirects, body-free error reporting).
 * No verdict lives here; each probe owns its own.
 *
 * `probeGet`/`parseJsonBody`/`fetchJson` return `{ ok: false, reason }` rather
 * than exiting, since the spec probe re-samples after a failure; `orInconclusive`
 * is for callers that want the exit. Node builtins only (`compare.mjs` is
 * builtins-only too), so nothing in the trust path can fail and be misread as a
 * producer problem.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitize } from "../packages/spec/wire/compare.mjs";

export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, INCONCLUSIVE: 2, MISCONFIGURED: 3 });

/**
 * Print and exit. Every exit in every probe goes through here.
 *
 * `writeSync`, not `console.error`, because `process.exit()` runs in the same
 * tick and Node's stderr is ASYNCHRONOUS on a pipe, which is what the Actions
 * runner and any `| tee` give it: everything still queued is discarded at the
 * exit. A probe whose verdict classes share an exit code (openapi's STALE,
 * BREAKING, RE-SPELLED) is told apart only by the body, so it must arrive whole.
 */
export const fail = (code, kind, msg) => {
  writeSync(2, `\n${kind}: ${msg}\n`);
  process.exit(code);
};

export const drift = (msg) => fail(EXIT.DRIFT, "DRIFT", msg);

export const misconfigured = (msg) => fail(EXIT.MISCONFIGURED, "MISCONFIGURED", msg);

export const inconclusive = (msg) =>
  fail(
    EXIT.INCONCLUSIVE,
    "INCONCLUSIVE",
    `${msg}\n  This is NOT a pass: nothing was compared, so nothing is known.`,
  );

/**
 * Node exits 1 on an unhandled throw, so without this a missing file or a bug
 * in a probe reads as DRIFT, a false accusation pointed at another team's diff.
 */
const installCrashHandlers = () => {
  const crashed = (e) =>
    fail(
      EXIT.INCONCLUSIVE,
      "INCONCLUSIVE",
      `the probe itself failed: ${e?.stack ?? e}\n  Nothing was compared.`,
    );
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
};

/**
 * Report a local-side problem now and keep going, so the producer is still
 * sampled; the probe exits 3 through `exitIfLocalProblem` once the producer's
 * answer is on the record. No-op without a problem.
 */
export const deferLocalProblem = (problem) => {
  if (!problem) return;
  console.error(`MISCONFIGURED (local side): ${problem}`);
  console.error(
    "\n  Not exited on yet; the producer is sampled anyway and both facts are reported below.\n",
  );
};

/**
 * Exit 3 with a deferred local problem, if there is one. `serverFinding` is one
 * line naming the server and what it answered.
 */
export const exitIfLocalProblem = (problem, serverFinding) => {
  if (!problem) return;
  misconfigured(
    `${problem}\n\n` +
      `  The producer was asked anyway: ${serverFinding}.\n` +
      "  No verdict: the local side of the comparison is not established.",
  );
};

/** A path under the repo root, for the local side of a comparison. */
export const repoPath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

/** Read a repo file as UTF-8; the caller decides what an unreadable one means. */
export const readRepoFile = (relative) => readFileSync(repoPath(relative), "utf-8");

/**
 * The first capture group of the one match of `regex` (which must be global) in
 * a repo file: `{ value }`, or `{ problem }` when the file is unreadable or the
 * pattern matches zero or several times. Taking the first of several would
 * leave the others unchecked.
 */
export const readSingleMatch = (relPath, regex, what) => {
  let text;
  try {
    text = readRepoFile(relPath);
  } catch (e) {
    return { problem: `could not read ${relPath}: ${e.message}` };
  }
  const matches = [...text.matchAll(regex)];
  if (matches.length === 1) return { value: matches[0][1] };
  if (matches.length === 0) {
    return {
      problem:
        `${relPath}: expected one ${what}, found none.\n` +
        "  Restore it, or update this probe's pattern in the same change.",
    };
  }
  return {
    problem:
      `${relPath}: expected one ${what}, found ${matches.length} ` +
      `(${matches.map((m) => sanitize(m[1].trim())).join(", ")}).\n` +
      "  Leave exactly one.",
  };
};

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/**
 * A `PROBE_*` duration is validated, not coerced. An unusable one is
 * MISCONFIGURED: nothing was asked of anyone.
 */
export const readPositiveMs = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    misconfigured(
      `${name} is not a usable duration: "${sanitize(raw)}".\n` +
        "  Set a positive number of milliseconds with no unit suffix (e.g. 20000).",
    );
  }
  return ms;
};

/**
 * Not a size budget: the largest thing any probe fetches is the ~56 KB
 * `openapi.json`, which a healthy solver serves in well under a second. 20s is
 * the point past which "the solver did not answer" IS the finding -- long
 * enough to ride out a cold start or one retried TLS handshake, short enough
 * that four probes plus the spec probe's re-sample stay far inside the job's
 * own limit, and short enough that a hung endpoint is reported as INCONCLUSIVE
 * rather than as a cancelled workflow with no verdict at all.
 * `PROBE_TIMEOUT_MS` overrides it.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Every probe's first call: crash handlers installed, `PROBE_TIMEOUT_MS` read. */
export const startProbe = () => {
  installCrashHandlers();
  return { timeoutMs: readPositiveMs("PROBE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS) };
};

/**
 * A URL cut short stops naming the host that was asked, which is the whole
 * content of the line it appears in; a media type never needs much room.
 */
export const MAX_URL_CHARS = 200;
const MAX_CONTENT_TYPE_CHARS = 80;

/**
 * Server key resolution on the SDK's env convention, `RIDDLER_URL_<NAME>`
 * uppercased. Read here rather than through `config.ts` so a missing URL is
 * MISCONFIGURED instead of a CLI error. This repo bakes in no host.
 *
 * Returns the base URL with trailing slashes stripped, the parsed URL for
 * callers that bound a server-supplied path to the same origin, and the
 * log-safe forms every print site uses: `display` (the server key) and `target`
 * (the base URL). `new URL()` strips tabs and newlines while `baseUrl` keeps
 * them, so the raw values never reach a log line.
 */
export const resolveServer = () => {
  const serverKey = (process.env.RIDDLER_SERVER ?? "prod").toLowerCase();
  const urlVar = `RIDDLER_URL_${serverKey.toUpperCase()}`;
  const raw = (process.env[urlVar] ?? "").trim();
  const display = sanitize(serverKey);
  const shownVar = sanitize(urlVar);

  if (!raw) {
    misconfigured(
      `no URL for server "${display}".\n` +
        `  Set ${shownVar}, or RIDDLER_SERVER to a key that has one.`,
    );
  }

  let parsedBase;
  try {
    parsedBase = new URL(raw);
  } catch {
    misconfigured(
      `${shownVar} is not a URL: "${sanitize(raw, MAX_URL_CHARS)}".\n` +
        "  Set it to the solver's https base URL.",
    );
  }

  if (parsedBase.protocol !== "https:") {
    misconfigured(
      `${shownVar} is "${parsedBase.protocol}//..." and these probes read over https only.\n` +
        "  Set the https URL: over cleartext anything on the path can edit the served side.",
    );
  }

  const baseUrl = raw.replace(/\/+$/, "");
  return {
    serverKey,
    urlVar,
    baseUrl,
    parsedBase,
    display,
    target: sanitize(baseUrl, MAX_URL_CHARS),
  };
};

/** The capabilities document under a resolved base URL. */
export const capabilitiesUrl = (baseUrl) => `${baseUrl}/xochi/capabilities`;

/**
 * Status, content-type and length; never the body (see `probeGet`). The
 * content-type is a producer string, so it is sanitized like every other.
 */
const describe = (response, text) =>
  `${response.status} (${sanitize(response.headers.get("content-type") ?? "no content-type", MAX_CONTENT_TYPE_CHARS)}, ` +
  `${Buffer.byteLength(text)} bytes)`;

/**
 * The largest body any probe has a use for. The wire contract is ~56 KB and the
 * attestation vectors are smaller, so 4 MB is two orders of magnitude of
 * headroom and still bounded. `AbortSignal.timeout` bounds LATENCY, not bytes:
 * a slow drip inside the 20s window buffers whole into a string that is then
 * hashed, lexed and parsed, so without this a hostile or broken producer sizes
 * the runner's memory.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read a body, refusing rather than buffering past `MAX_BODY_BYTES`, and
 * reporting a broken TRANSFER as its own outcome: `{ ok: true, text }`,
 * `{ ok: false, oversize, size }` or `{ ok: false, size, error }`. A reset, a
 * TLS teardown or a truncated chunked body is a failure of the wire, not a
 * finding about the producer's content.
 */
const readCapped = async (response) => {
  if (!response.body) return { ok: true, text: "" };
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        return { ok: false, oversize: true, size };
      }
      chunks.push(chunk);
    }
  } catch (e) {
    return { ok: false, size, error: e?.cause?.message ?? e?.message ?? String(e) };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
};

/**
 * One GET, with the hazards handled the same way for every probe.
 *
 * - `cache-control: no-cache`: `/xochi/capabilities` is cached ~300s, so a
 *   cached answer describes a fleet that may no longer exist. The header is a
 *   hint an intermediary may ignore, hence the spec probe's second sample.
 * - `redirect: "manual"`: fetch otherwise follows up to 20 redirects,
 *   cross-origin included, so a 302 relocates rule 1's uneditable value to a
 *   host nobody configured and the probe prints OK against it.
 * - No body in any error message; status, content-type and byte count route
 *   the problem.
 * - A body stream that breaks mid-download is its own outcome, not an empty
 *   successful read: the two name different parties.
 *
 * Returns `{ ok: true, response, text }` or `{ ok: false, reason }`.
 */
export const probeGet = async ({ url, accept = "application/json", timeoutMs, label }) => {
  const at = label ? `${label}: ` : "";
  const target = sanitize(url, MAX_URL_CHARS);

  let response;
  try {
    response = await fetch(url, {
      headers: { accept, "cache-control": "no-cache", pragma: "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return {
      ok: false,
      reason: `${at}GET ${target} failed: ${sanitize(e?.cause?.message ?? e.message)}`,
    };
  }

  // `type` covers the spec's opaque-redirect filtered response (status 0); Node
  // hands back the real 3xx, and either way the answer is "somewhere else".
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} answered ${response.status} redirect to ` +
        `${sanitize(response.headers.get("location") ?? "(no Location header exposed)", MAX_URL_CHARS)}.\n` +
        "  Not followed. Point the server URL at the host that answers.",
    };
  }

  const body = await readCapped(response);
  if (!body.ok && body.oversize) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} is still sending past ${MAX_BODY_BYTES} bytes (${body.size} so far).\n` +
        "  Abandoned unread: no document this repo vendors is that size. Check the server URL.",
    };
  }
  if (!body.ok) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} broke off after ${body.size} bytes: ${sanitize(body.error)}.\n` +
        "  The transfer failed, not the document. Re-run.",
    };
  }
  const text = body.text;

  if (!response.ok) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} returned ${describe(response, text)}.\n` +
        "  Body not logged; fetch it out of band if the status is not enough.",
    };
  }

  return { ok: true, response, text };
};

/**
 * Parse a body obtained by `probeGet`. Non-JSON is described by status,
 * content-type and length, never quoted: an HTML error page is the sort of body
 * that carries somebody's token in a query string.
 */
export const parseJsonBody = ({ response, text }, { url, label } = {}) => {
  const at = label ? `${label}: ` : "";
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      reason: `${at}GET ${sanitize(url ?? response.url, MAX_URL_CHARS)} did not return JSON: ${describe(response, text)}`,
    };
  }
};

/**
 * One GET parsed as JSON: `{ ok: true, value, text, response }` or
 * `{ ok: false, reason }`. `text` is kept for callers that hash or lex the raw
 * bytes as well.
 */
export const fetchJson = async ({ url, label, timeoutMs }) => {
  const got = await probeGet({ url, label, timeoutMs });
  if (!got.ok) return got;
  const parsed = parseJsonBody(got, { url, label });
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value, text: got.text, response: got.response };
};

/** For probes whose first non-answer ends the run: exit 2 with the reason. */
export const orInconclusive = (result) => {
  if (!result.ok) inconclusive(result.reason);
  return result;
};
