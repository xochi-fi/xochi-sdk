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
  RampCommandSchema,
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

  it.each(fixtures.command_cases)("command: $id", ({ snapshot, command, receipt, expected }) => {
    expect(
      checkRampCommand(
        RampSnapshotSchema.parse(snapshot),
        RampCommandSchema.parse(command),
        receipt
          ? {
              command: RampCommandSchema.parse(receipt.command),
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
    const input = fixtures.wire_cases.find((row) => row.id === "intent_exact_large_amount")!
      .input as object;
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
