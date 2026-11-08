// `receipt` from the CLI: the minimal invocation reuses what setup/enroll/restore saved in the
// data directory, names exactly the flag that was never saved, and the Xochi API defaults to
// https://api.xochi.fi (the only origin the client accepts). No network: fetch is stubbed.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import { openNodeJournals } from "../src/node/data-dir.js";

const PASS = "receipt cli TEST ONLY";
const INTENT = "3f0c2a5e-8d7b-4e1a-9c6f-0b1d2e3f4a5b";
const saved = {
  passphrase: process.env["XOCHI_RECIPIENT_PASSPHRASE"],
  jwt: process.env["XOCHI_JWT"],
};

beforeAll(() => {
  process.env["XOCHI_RECIPIENT_PASSPHRASE"] = PASS;
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const [key, value] of [
    ["XOCHI_RECIPIENT_PASSPHRASE", saved.passphrase],
    ["XOCHI_JWT", saved.jwt],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function initialized(): Promise<string> {
  const dataDir = join(mkdtempSync(join(tmpdir(), "receipt-cli-")), "recipient");
  await run(["init", "--data-dir", dataDir]);
  return dataDir;
}

function editState(dataDir: string, edit: (state: Record<string, unknown>) => void): void {
  const path = join(dataDir, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(state);
  writeFileSync(path, JSON.stringify(state));
}

describe("receipt invocation", () => {
  it("names the one flag that was never saved", async () => {
    const dataDir = await initialized();
    await expect(run(["receipt", INTENT, "--data-dir", dataDir])).rejects.toThrow(
      "--oxide-token-artifact is required: no OxideToken artifact path was saved by setup, enroll start or restore",
    );
  });

  it("reuses the saved OxideToken artifact path", async () => {
    const dataDir = await initialized();
    const missing = join(dataDir, "saved-artifact-TEST-ONLY.json");
    editState(dataDir, (state) => {
      state["oxideTokenArtifact"] = missing;
      state["nodeUrl"] = "http://127.0.0.1:9/TEST-ONLY";
    });
    await expect(run(["receipt", INTENT, "--data-dir", dataDir])).rejects.toThrow(
      /ENOENT.*saved-artifact-TEST-ONLY\.json/,
    );
  });

  it("takes --binding-id only with --legacy-binding, and never against the saved one", async () => {
    const dataDir = await initialized();
    await expect(
      run(["receipt", INTENT, "--data-dir", dataDir, "--binding-id", "TEST-ONLY-b"]),
    ).rejects.toThrow(/--binding-id is only for receipt --legacy-binding/);
    editState(dataDir, (state) => {
      state["bindingId"] = "TEST-ONLY-a";
    });
    await expect(
      run([
        "receipt",
        INTENT,
        "--data-dir",
        dataDir,
        "--legacy-binding",
        "--binding-id",
        "TEST-ONLY-b",
      ]),
    ).rejects.toThrow(
      "--binding-id TEST-ONLY-b is not this data directory's enrolled binding id TEST-ONLY-a",
    );
  });

  // After "--", so the leading-dash id reaches the grammar check instead of the option parser.
  it.each([["Intent_A1"], ["a".repeat(129)], ["-leading-dash"]])(
    "refuses intent id %s before touching the data directory",
    async (intentId) => {
      const dataDir = join(tmpdir(), "receipt-cli-never-created");
      await expect(run(["receipt", "--data-dir", dataDir, "--", intentId])).rejects.toThrow(
        "intent id must be 1-64 characters of a-z, 0-9, '_' and '-', not starting with '-'",
      );
    },
  );
});

describe("operations reconcile", () => {
  it("refuses to release a live receipt run's lock unless forced: it moved no funds", async () => {
    const dataDir = await initialized();
    const operations = openNodeJournals(dataDir).operations;
    const held = await operations.beginReceipt(INTENT);
    await expect(run(["operations", "reconcile", "--data-dir", dataDir])).rejects.toThrow(
      new RegExp(`receipt run pid ${process.pid} on .* is still running.*--force`),
    );
    expect((await operations.get(held.id)).status).toBe("building");
    await run(["operations", "reconcile", "--data-dir", dataDir, "--force"]);
    expect((await operations.get(held.id)).status).toBe("aborted");
    expect(await operations.unresolved()).toBeNull();
  });
});

describe("Xochi API URL", () => {
  it("defaults to https://api.xochi.fi", async () => {
    const dataDir = await initialized();
    process.env["XOCHI_JWT"] = "TEST ONLY jwt";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: "TEST ONLY" }), { status: 404 });
    });
    await expect(
      run(["enroll", "status", "--data-dir", dataDir, "--binding-id", "TEST-ONLY"]),
    ).rejects.toThrow(/404/);
    expect(urls).toEqual(["https://api.xochi.fi/api/shielded/recipients/TEST-ONLY"]);
  });
});
