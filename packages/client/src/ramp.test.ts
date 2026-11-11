// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  atomic,
  checkRampCommand,
  parseRamp,
  rampOutcome,
  type RampCommand,
  RampSnapshotSchema,
  RampWireSchema,
} from "./ramp.js";

interface WireCase {
  id: string;
  input: unknown;
  valid: boolean;
  expected_outcome?: string;
}
interface CommandCase {
  id: string;
  snapshot: unknown;
  command: unknown;
  expected: string;
  receipt?: { command: unknown; snapshot: unknown };
}
const fixtures = JSON.parse(
  readFileSync(new URL("../ramp/conformance.json", import.meta.url), "utf8"),
) as {
  wire_cases: WireCase[];
  atomic_cases: { value: unknown; valid: boolean }[];
  command_cases: CommandCase[];
};
const schema = JSON.parse(
  readFileSync(new URL("../ramp/contract.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: true });
ajv.addFormat("date-time", (value: string) => z.iso.datetime().safeParse(value).success);
const validateShape = ajv.compile(schema);

describe("ramp/1 cross-runtime conformance", () => {
  it.each(fixtures.wire_cases)("$id", ({ input, valid, expected_outcome }) => {
    const parsed = parseRamp(input);
    expect(parsed.ok).toBe(valid);
    // Independently exercise the canonical JSON Schema and its TypeScript binding.
    expect(validateShape(input)).toBe(RampWireSchema.safeParse(input).success);
    if (parsed.ok) {
      expect(validateShape(parsed.value)).toBe(true);
      expect(parseRamp(JSON.parse(JSON.stringify(parsed.value)))).toEqual(parsed);
      if (parsed.value.kind === "snapshot" && expected_outcome) {
        expect(rampOutcome(parsed.value)).toEqual({
          terminal: parsed.value.terminal,
          state: expected_outcome,
        });
      }
    } else {
      expect(parsed).toEqual({
        ok: false,
        code:
          typeof input === "object" &&
          input !== null &&
          "contract_version" in input &&
          input.contract_version === "ramp/2"
            ? "unsupported_version"
            : "invalid_request",
      });
    }
  });

  it.each(fixtures.atomic_cases)("checks exact atomic input $value", ({ value, valid }) => {
    if (valid) expect(atomic(value as string)).toBe(value);
    else expect(() => atomic(value as string)).toThrow("Invalid atomic amount");
  });

  it("preserves bigint units above Number.MAX_SAFE_INTEGER without rounding", () => {
    expect(atomic(900719925474099312345678901234567890n)).toBe(
      "900719925474099312345678901234567890",
    );
    expect(atomic(0n)).toBe("0");
    expect(() => atomic(-1n)).toThrow("Invalid atomic amount");
  });

  // Commands and receipts go in unparsed: checkRampCommand must classify malformed ones itself.
  it.each(fixtures.command_cases)("command: $id", ({ snapshot, command, receipt, expected }) => {
    expect(
      checkRampCommand(
        RampSnapshotSchema.parse(snapshot),
        command as RampCommand,
        receipt
          ? {
              command: receipt.command as RampCommand,
              snapshot: RampSnapshotSchema.parse(receipt.snapshot),
            }
          : undefined,
      ),
    ).toBe(expected);
  });

  it("drops bounded unknown optional fields without forwarding them", () => {
    const input = fixtures.wire_cases.find((row) => row.id === "bounded_optional_extension")!.input;
    const parsed = parseRamp(input);
    expect(parsed.ok && "future_extension" in parsed.value).toBe(false);
  });

  it("bounds unknown fields before discarding them", () => {
    const input = fixtures.wire_cases.find((row) => row.id === "availability_available")!
      .input as object;
    expect(parseRamp(input).ok).toBe(true);
    expect(parseRamp({ ...input, future: "x".repeat(2049) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseRamp({ ...input, future: Array(129).fill(0) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    const cyclic: Record<string, unknown> = { ...input };
    cyclic.future = cyclic;
    expect(parseRamp(cyclic)).toEqual({ ok: false, code: "invalid_request" });
  });
});

// Provider data (an offer) discards bounded unknown fields, so these exercise the snapshot boundary
// rather than strict-key rejection.
describe("untrusted ramp objects", () => {
  const input = fixtures.wire_cases.find((row) => row.id === "availability_available")!
    .input as object;

  it("rejects own accessors without invoking them, even in discarded fields", () => {
    let reads = 0;
    const getter = () => {
      reads++;
      throw new Error("private provider credentials");
    };
    const inputs = [
      Object.defineProperty({ ...input }, "kind", { get: getter, enumerable: true }),
      { ...input, future: Object.defineProperty({}, "secret", { get: getter, enumerable: true }) },
      { ...input, future: Object.defineProperty([0], "0", { get: getter, enumerable: true }) },
      { ...input, future: Object.defineProperty([], "every", { get: getter }) },
      Object.defineProperty({ ...input }, "hidden", { get: getter }),
      Object.defineProperty({ ...input }, Symbol("secret"), { get: getter }),
      Object.defineProperty({ ...input }, "setter", {
        set: () => {
          reads++;
        },
        enumerable: true,
      }),
    ];
    for (const value of inputs) {
      expect(parseRamp(value)).toEqual({ ok: false, code: "invalid_request" });
    }
    expect(reads).toBe(0);
  });

  it.each(["object", "array"])("contains revoked %s Proxies at the root and nested", (kind) => {
    const { proxy, revoke } = Proxy.revocable(kind === "array" ? [] : { ...input }, {});
    revoke();
    expect(parseRamp(proxy)).toEqual({ ok: false, code: "invalid_request" });
    expect(parseRamp({ ...input, future: proxy })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseRamp({ ...input, future: [proxy] })).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"])(
    "contains throwing %s traps without exposing the escaped error",
    (trap) => {
      const proxy = new Proxy(
        { ...input },
        {
          [trap]() {
            throw new Error("private provider credentials");
          },
        },
      );
      expect(parseRamp(proxy)).toEqual({ ok: false, code: "invalid_request" });
      expect(parseRamp({ ...input, future: proxy })).toEqual({
        ok: false,
        code: "invalid_request",
      });
    },
  );

  it("validates descriptor snapshots without reading Proxy properties again", () => {
    let reads = 0;
    const proxy = new Proxy(input, {
      get() {
        reads++;
        throw new Error("private provider credentials");
      },
      has() {
        reads++;
        throw new Error("private provider credentials");
      },
    });
    const expected = parseRamp(input);
    expect(expected.ok).toBe(true);
    expect(parseRamp(proxy)).toEqual(expected);
    expect(parseRamp({ ...input, future: proxy })).toEqual(expected);
    expect(reads).toBe(0);
  });
});
