#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const IMMUTABLE_RELEASES_ENDPOINT = "repos/xochi-fi/xochi-sdk/immutable-releases";
export const GITHUB_API_VERSION = "2026-03-10";

function latestResponse(output) {
  const matches = [...output.matchAll(/^HTTP\/\S+\s+(\d{3})[^\n]*$/gm)];
  const status = matches.at(-1);
  if (!status || status.index === undefined) {
    throw new Error("GitHub immutable-releases response omitted the HTTP status");
  }

  const response = output.slice(status.index);
  const separator = response.search(/\r?\n\r?\n/);
  if (separator < 0) {
    throw new Error("GitHub immutable-releases response omitted the response body");
  }

  return {
    status: Number(status[1]),
    body: response.slice(separator).trim(),
  };
}

export function verifyImmutableReleasesResponse(output, observedAt = new Date().toISOString()) {
  const response = latestResponse(output);
  if (response.status !== 200) {
    throw new Error(`GitHub immutable-releases endpoint returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error("GitHub immutable-releases endpoint returned invalid JSON");
  }
  if (body?.enabled !== true || typeof body.enforced_by_owner !== "boolean") {
    throw new Error("GitHub immutable-releases enforcement is not confirmed");
  }

  return {
    endpoint: `GET /${IMMUTABLE_RELEASES_ENDPOINT}`,
    apiVersion: GITHUB_API_VERSION,
    httpStatus: response.status,
    enabled: body.enabled,
    enforcedByOwner: body.enforced_by_owner,
    enforcementOrigin: body.enforced_by_owner ? "organization" : "repository",
    observedAt,
  };
}

export function runImmutableReleasePreflight({
  request = () =>
    spawnSync(
      "gh",
      [
        "api",
        "--include",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
        IMMUTABLE_RELEASES_ENDPOINT,
      ],
      { encoding: "utf8" },
    ),
  observedAt = new Date().toISOString(),
} = {}) {
  const result = request();
  if (result.error || result.status !== 0) {
    throw new Error("GitHub immutable-releases request failed");
  }
  return verifyImmutableReleasesResponse(result.stdout, observedAt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${JSON.stringify(runImmutableReleasePreflight())}\n`);
  } catch (error) {
    process.stderr.write(`release immutability preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
