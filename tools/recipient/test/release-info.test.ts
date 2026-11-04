import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertSupportedRuntime,
  diagnostics,
  packageVersion,
  runtimePlatform,
} from "../src/release-info.js";
const packageMetadata: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  packageMetadata === null ||
  typeof packageMetadata !== "object" ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("TEST ONLY package version metadata is invalid");
}
const expectedVersion = packageMetadata.version;

describe("release diagnostics", () => {
  it("pins the private test version and privacy-safe public facts", () => {
    expect(packageVersion()).toBe(expectedVersion);
    expect(diagnostics()).toMatchObject({
      ok: true,
      version: expectedVersion,
      nodeMajor: 22,
      telemetry: false,
      hostedPage: false,
      corridorRevision: "2",
      manifestDigest: "0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e",
      tokenArtifactHash: "0x128f498e06c59eeecdfcf41b96b3698bae23826ce3fb8608617e0a3084532f5f",
    });
  });

  it("classifies Linux, WSL and macOS and refuses non-Node-22 runtimes", () => {
    expect(runtimePlatform("linux", "6.8.0-generic")).toBe("linux");
    expect(runtimePlatform("linux", "5.15.90.1-microsoft-standard-WSL2")).toBe("wsl");
    expect(runtimePlatform("darwin", "25.3.0")).toBe("macos");
    expect(() => runtimePlatform("win32", "10")).toThrow(/macOS, Linux, and WSL/);
    expect(() => assertSupportedRuntime("23.0.0")).toThrow(/Node.js 22.x exactly/);
  });
});
