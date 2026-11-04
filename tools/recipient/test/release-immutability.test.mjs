#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  immutableReleaseRequestArgs,
  runImmutableReleasePreflight,
  verifyImmutableReleasesResponse,
} from "../scripts/verify-release-immutability.mjs";
const response = (status, body) =>
  `HTTP/2.0 ${status} Result\nContent-Type: application/json\n\n${JSON.stringify(body)}\n`;
assert.deepEqual(immutableReleaseRequestArgs(), [
  "api",
  "--include",
  "--method",
  "GET",
  "--hostname",
  "github.com",
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
  "repos/xochi-fi/xochi-sdk/immutable-releases",
]);
assert.deepEqual(
  verifyImmutableReleasesResponse(
    response(200, { enabled: true, enforced_by_owner: false }),
    "2026-11-04T22:39:02Z",
  ),
  {
    endpoint: "GET /repos/xochi-fi/xochi-sdk/immutable-releases",
    apiVersion: "2026-03-10",
    httpStatus: 200,
    enabled: true,
    enforcedByOwner: false,
    enforcementOrigin: "repository",
    observedAt: "2026-11-04T22:39:02Z",
  },
);
assert.equal(
  verifyImmutableReleasesResponse(response(200, { enabled: true, enforced_by_owner: true }))
    .enforcementOrigin,
  "organization",
);
assert.throws(
  () => verifyImmutableReleasesResponse(response(404, { message: "Not Found" })),
  /HTTP 404/,
);
assert.throws(
  () =>
    verifyImmutableReleasesResponse(response(200, { enabled: false, enforced_by_owner: false })),
  /enforcement is not confirmed/,
);
assert.throws(
  () => verifyImmutableReleasesResponse(response(200, { enabled: true })),
  /enforcement is not confirmed/,
);
assert.throws(
  () => verifyImmutableReleasesResponse("HTTP/2.0 200 OK\n\nnot-json\n"),
  /invalid JSON/,
);
assert.throws(
  () => verifyImmutableReleasesResponse('{"enabled":true,"enforced_by_owner":false}'),
  /omitted the HTTP status/,
);
assert.throws(
  () =>
    runImmutableReleasePreflight({
      request: () => ({ status: 1, stdout: "", stderr: "private command output" }),
    }),
  (error) => {
    assert.equal(error.message, "GitHub immutable-releases request failed");
    assert.equal(error.message.includes("private command output"), false);
    return true;
  },
);
const successful = runImmutableReleasePreflight({
  request: () => ({
    status: 0,
    stdout: response(200, { enabled: true, enforced_by_owner: false }),
    stderr: "",
  }),
  observedAt: "2026-11-04T22:39:02Z",
});
assert.equal(successful.enabled, true);
assert.equal(successful.httpStatus, 200);
process.stdout.write("immutable release preflight tests passed\n");
