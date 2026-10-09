/**
 * Shared hazard handling for the producer-drift probes.
 *
 * Three rules hold for all four probes, stated here and referenced there.
 *
 * 1. An equality assertion is informative only if at least one side is a value
 *    this repo cannot edit (riddler-sdk#92). The served side is that value.
 * 2. Every non-verifying outcome fails, "could not reach the server" included.
 *    Not being able to check is not evidence of agreement: no skip path, no
 *    `continue-on-error`.
 * 3. They run on a schedule, not per-PR. The event to detect is a server
 *    deploy, and a check that reddens honest PRs eventually gets disabled.
 *
 * Here: the exit-code helpers, the `PROBE_*` env readers, the server/base-URL
 * resolution, and the one `fetch` shape (no-cache, unfollowed redirects,
 * body-free error reporting). Per-probe copies had diverged:
 * `PROBE_TIMEOUT_MS=60s` exited 3 in one and 2 in the others, and two echoed
 * upstream error bodies into a public Actions log. No verdict lives here; each
 * probe owns its own.
 *
 * `probeGet`/`parseJsonBody` return `{ ok: false, reason }` rather than exiting,
 * since the spec probe re-samples after a failure; `orInconclusive` is for
 * callers that want the exit. Node builtins only, so nothing in the trust path
 * can fail and be misread as a producer problem.
 */

import { writeSync } from "node:fs";

/**
 * Print and exit. Every exit in every probe goes through here.
 *
 * `writeSync`, not `console.error`, because `process.exit()` runs in the same
 * tick and Node's stderr is ASYNCHRONOUS on a pipe -- which is exactly what the
 * Actions runner and any `| tee` give it. Everything still queued is discarded
 * at the exit, and the openapi probe's DRIFT body is the longest thing any
 * probe prints: measured, a 4.09 MB report came out of a pipe as 66,637 bytes,
 * losing the tail of the finding list and the whole remediation paragraph.
 * STALE and BREAKING share exit 1 here on purpose, so the body is the ONLY
 * discriminator and truncating it silently is worse than the exit code alone.
 */
export const fail = (code, kind, msg) => {
  writeSync(2, `\n${kind}: ${msg}\n`);
  process.exit(code);
};

/** Exit 1. Reserved for "the producer and this repo disagree", nothing else. */
export const drift = (msg) => fail(1, "DRIFT", msg);

/** Exit 3. This machine's own state or configuration, before anyone was asked. */
export const misconfigured = (msg) => fail(3, "MISCONFIGURED", msg);

/** Exit 2. Nothing was compared, so nothing is known. Rule 2 above. */
export const inconclusive = (msg) =>
  fail(
    2,
    "INCONCLUSIVE",
    `${msg}\n` +
      "  This is NOT a pass. Nothing was compared, so nothing is known.\n" +
      "  Not being able to check must not look like agreement from outside.",
  );

/**
 * Exit 1 means DRIFT and nothing else. Node exits 1 on an unhandled throw, so
 * without this a missing file or a bug in a probe reads as "the producer changed
 * the protocol", a false accusation pointed at another team's diff.
 */
export const installCrashHandlers = () => {
  const crashed = (e) =>
    fail(2, "INCONCLUSIVE", `the probe itself failed: ${e?.stack ?? e}\n  Nothing was compared.`);
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
};

/**
 * A `PROBE_*` duration is validated, not coerced. An unusable one is
 * MISCONFIGURED: nothing was asked of anyone, so do not name the solver.
 */
export const readPositiveMs = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    misconfigured(
      `${name} is not a usable duration: "${raw}".\n` +
        "  Wanted a positive number of milliseconds with no unit suffix (e.g. 20000).\n" +
        "  Reported here rather than as an unreachable server: nothing was asked of anyone.",
    );
  }
  return ms;
};

/**
 * Not a size budget: the largest thing any probe fetches is the ~56 KB
 * `openapi.json`, which a healthy solver serves in well under a second. 20s is
 * the point past which "the solver did not answer" IS the finding -- long
 * enough to ride out a cold start or one retried TLS handshake, short enough
 * that four probes plus the spec probe's ~5m30s re-sample stay far inside the
 * job's own limit, and short enough that a hung endpoint is reported as
 * INCONCLUSIVE rather than as a cancelled workflow with no verdict at all.
 * `PROBE_TIMEOUT_MS` overrides it and is validated, not coerced.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export const readTimeoutMs = () => readPositiveMs("PROBE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

/**
 * Server key resolution on the SDK's env convention, `RIDDLER_URL_<NAME>`
 * uppercased. Read here rather than through `config.ts` so a missing URL is
 * MISCONFIGURED instead of a CLI error. Returns the base URL with trailing
 * slashes stripped, plus the parsed URL for callers that bound a server-supplied
 * path to the same origin.
 */
export const resolveServer = () => {
  const serverKey = (process.env.RIDDLER_SERVER ?? "prod").toLowerCase();
  const urlVar = `RIDDLER_URL_${serverKey.toUpperCase()}`;
  const raw = (process.env[urlVar] ?? "").trim();

  if (!raw) {
    misconfigured(
      `no URL for server "${serverKey}".\n` +
        `  Set ${urlVar}, or RIDDLER_SERVER to a key that has one.\n` +
        "  Deliberately not defaulting to a built-in host: this repo bakes in no infrastructure,\n" +
        "  and a probe that invents one reports on a server nobody runs.",
    );
  }

  let parsedBase;
  try {
    parsedBase = new URL(raw);
  } catch {
    // `vars.*` is not masked, so an operator-set variable prints under the same
    // rule as a served string: this is the one message that echoes the value
    // back, and a newline plus `::error title=...::` in it forges a workflow
    // command at column 0.
    misconfigured(
      `${urlVar} is not a URL: "${oneLine(raw, MAX_URL_CHARS)}".\n` +
        "  MISCONFIGURED, not unreachable: the request was never well-formed enough to send.",
    );
  }

  if (parsedBase.protocol !== "https:") {
    misconfigured(
      `${urlVar} is "${parsedBase.protocol}//..." and these probes read over https only.\n` +
        "  The entire value of the served side is that this repo cannot edit it. Over cleartext\n" +
        "  anything on the path can, so an http answer is a value of unknown authorship wearing\n" +
        "  the producer's name -- worth less than no answer, because it looks like one.",
    );
  }

  return { serverKey, urlVar, baseUrl: raw.replace(/\/+$/, ""), parsedBase };
};

/**
 * Status, content-type and length; never the body (see `probeGet`). The
 * content-type is a PRODUCER string landing on a line in a public log, so it
 * goes through `oneLine` exactly like the `Location` header: `application/json`
 * is the honest case, and nothing stops the other one from carrying a newline
 * plus `::error title=...::`. Capped shorter than a URL because a media type
 * longer than that is not a media type, and this line exists to route the
 * problem, not to quote the answer.
 */
const describe = (response, text) =>
  `${response.status} (${oneLine(response.headers.get("content-type") ?? "no content-type", MAX_CONTENT_TYPE_CHARS)}, ` +
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
 * A served string reaching a log line, with C0/C1 controls escaped and a cap.
 * `compare.mjs` has the full version, but this file deliberately imports
 * nothing outside node builtins (and importing it would make the dependency
 * between `scripts/` and `packages/spec/wire/` circular), so the one-line rule
 * is restated: a `Location` header carrying a newline plus `::error title=...::`
 * forges a workflow annotation at column 0 in a public log.
 */
const oneLine = (value, max = 120) => {
  const clean = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`);
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

/**
 * Two caps that are not the 120-char default: a URL cut short stops naming the
 * host that was asked, which is the whole content of the line it appears in,
 * and a media type never needs that much room.
 */
const MAX_URL_CHARS = 200;
const MAX_CONTENT_TYPE_CHARS = 80;

/**
 * Read a body, refusing rather than buffering past `MAX_BODY_BYTES`, and
 * reporting a broken TRANSFER as its own outcome: `{ ok: true, text }`,
 * `{ ok: false, oversize, size }` or `{ ok: false, size, error }`.
 *
 * The caller used to wrap this in `.catch(() => ({ ok: true, text: "" }))`,
 * which asserted the read had SUCCEEDED and the producer had sent nothing. A
 * connection reset, a TLS teardown or a truncated chunked body therefore came
 * out of `parseJsonBody` as `did not return JSON: 200 (application/json, 0
 * bytes)` -- a finding about the producer's CONTENT for a failure of the wire,
 * pointed at the wrong team, and a swallowed error besides.
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
 * - No body in any error message. These logs are public and Actions does not
 *   mask `vars.*`; status, content-type and byte count route the problem, and
 *   every one of those that a producer or an operator controls -- the URL, the
 *   content-type, the `Location`, the transport error -- goes through `oneLine`.
 * - A body stream that breaks mid-download is its own outcome, not an empty
 *   successful read: the two name different parties.
 *
 * Returns `{ ok: true, response, text }` or `{ ok: false, reason }`.
 */
export const probeGet = async ({ url, accept = "application/json", timeoutMs, label }) => {
  const at = label ? `${label}: ` : "";
  const target = oneLine(url, MAX_URL_CHARS);

  let response;
  try {
    response = await fetch(url, {
      headers: { accept, "cache-control": "no-cache", pragma: "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `${at}GET ${target} failed: ${oneLine(e?.cause?.message ?? e.message)}` };
  }

  // `type` covers the spec's opaque-redirect filtered response (status 0); Node
  // hands back the real 3xx, and either way the answer is "somewhere else".
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} answered ${response.status} redirect to ` +
        `${oneLine(response.headers.get("location") ?? "(no Location header exposed)")}.\n` +
        "  Not followed. Point the server URL at the host that answers, or find out who is\n" +
        "  relocating it: a probe that chases a redirect is asking a different server.",
    };
  }

  const body = await readCapped(response);
  if (!body.ok && body.oversize) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} is still sending past ${MAX_BODY_BYTES} bytes (${body.size} so far).\n` +
        "  Abandoned unread. No document this repo vendors is that size, so this is a\n" +
        "  truncated stream, a wrong host or a body meant to exhaust the runner.",
    };
  }
  if (!body.ok) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} broke off after ${body.size} bytes: ${oneLine(body.error)}.\n` +
        "  The TRANSFER failed, not the document: a reset, a TLS teardown or a truncated\n" +
        "  chunked body. Kept apart from a content finding on purpose -- reported as an empty\n" +
        "  successful read this printed as the producer serving 0 bytes of non-JSON, which\n" +
        "  accuses the wrong party of the wrong thing.",
    };
  }
  const text = body.text;

  if (!response.ok) {
    return {
      ok: false,
      reason:
        `${at}GET ${target} returned ${describe(response, text)}.\n` +
        "  Body not logged on purpose; read it out of band if the status is not enough.",
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
      reason: `${at}GET ${oneLine(url ?? response.url, MAX_URL_CHARS)} did not return JSON: ${describe(response, text)}`,
    };
  }
};

/** For probes whose first non-answer ends the run: exit 2 with the reason. */
export const orInconclusive = (result) => {
  if (!result.ok) inconclusive(result.reason);
  return result;
};
