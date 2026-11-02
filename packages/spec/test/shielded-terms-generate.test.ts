// `conformance/generate-shielded-terms.ts` is the only writer of shielded-terms.json and its
// schema. Riddler vendors those bytes, so a committed file a fresh run would not reproduce is a
// contract nobody can regenerate. The generator runs into a scratch dir
// (SHIELDED_TERMS_VECTORS_DIR), twice, and both runs must equal the committed files; the
// committed vectors must also satisfy the committed schema.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Ajv2020 } from "ajv/dist/2020.js";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SPEC, "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const FILES = ["shielded-terms.json", "shielded-terms.schema.json"];
const committed = (f: string) => fs.readFileSync(path.join(SPEC, "conformance", f), "utf8");

function generate(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-terms-vectors-"));
  try {
    const run = spawnSync(TSX, ["conformance/generate-shielded-terms.ts"], {
      cwd: SPEC,
      env: { ...process.env, SHIELDED_TERMS_VECTORS_DIR: dir },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("generate-shielded-terms", () => {
  it("reproduces the committed vectors byte-for-byte on every run", () => {
    const first = generate();
    const second = generate();
    for (const f of FILES) {
      expect(first[f], f).toBe(committed(f));
      expect(second[f], f).toBe(committed(f));
    }
  }, 60_000);

  it("the committed vectors satisfy the committed schema", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(committed("shielded-terms.schema.json")));
    expect(
      validate(JSON.parse(committed("shielded-terms.json"))),
      ajv.errorsText(validate.errors),
    ).toBe(true);
  });

  it("every manifest, preview and terms digest is distinct", () => {
    type V = { digest?: string; manifestDigest?: string };
    const set = JSON.parse(committed("shielded-terms.json")) as {
      manifest: { vectors: V[] };
      preview: { vectors: V[] };
      terms: { vectors: V[] };
    };
    const all = [...set.manifest.vectors, ...set.preview.vectors, ...set.terms.vectors].map(
      (v) => v.digest ?? v.manifestDigest,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("a preview is never signable terms: other type, version and domain", () => {
    const set = JSON.parse(committed("shielded-terms.json")) as {
      constants: Record<string, string>;
      types: Record<string, { encodeType: string }>;
    };
    expect(set.types.preview!.encodeType.startsWith("ShieldedPreviewV1(")).toBe(true);
    expect(set.constants.previewDomainName).not.toBe(set.constants.termsDomainName);
    expect(set.constants.previewProtocolVersion).not.toBe(set.constants.termsProtocolVersion);
  });

  // The two 6 -> 18 rounding vectors exist to fail named wrong implementations. A policy or
  // floor change that lets the gas floor bind would make them agree with those implementations
  // and still regenerate byte-for-byte, so pin the property itself.
  it("the 6-to-18 rounding vectors still separate the wrong implementations", () => {
    type Preview = {
      name: string;
      inputs: {
        manifest: { sourceUnits: string; destinationUnits: string };
        policy: Record<"gasFloor" | "solverFeeBps" | "venueFeeBps" | "routingFeeBps", string>;
        caller: { amount: string };
      };
      message: { source: { amount: string }; feeBreakdown: { totalFee: string } };
    };
    const set = JSON.parse(committed("shielded-terms.json")) as {
      preview: { vectors: Preview[] };
    };
    const byName = (name: string) => {
      const v = set.preview.vectors.find((p) => p.name === name);
      if (!v) throw new Error(`missing preview vector ${name}`);
      return v;
    };
    const fees = (v: Preview, base: bigint) => {
      const bps = [
        v.inputs.policy.solverFeeBps,
        v.inputs.policy.venueFeeBps,
        v.inputs.policy.routingFeeBps,
      ].map(BigInt);
      const floor = BigInt(v.inputs.policy.gasFloor);
      const atLeastFloor = (x: bigint) => (x > floor ? x : floor);
      const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
      return {
        layers: sum(bps.map((b) => (base * b) / 10000n)),
        perLayerFloor: atLeastFloor(sum(bps.map((b) => (base * b) / 10000n))),
        combinedFloor: atLeastFloor((base * sum(bps)) / 10000n),
        perLayerCeil: atLeastFloor(sum(bps.map((b) => (base * b + 9999n) / 10000n))),
        floor,
      };
    };
    const bases = (v: Preview) => {
      const amount = BigInt(v.inputs.caller.amount);
      const su = BigInt(v.inputs.manifest.sourceUnits);
      const du = BigInt(v.inputs.manifest.destinationUnits);
      return { up: (amount * su + du - 1n) / du, down: (amount * su) / du };
    };

    const moves = byName("six-to-eighteen-round-up-moves-layers");
    const m = bases(moves);
    const served = BigInt(moves.message.feeBreakdown.totalFee);
    expect(fees(moves, m.up).layers > fees(moves, m.up).floor).toBe(true);
    expect(served).toBe(fees(moves, m.up).perLayerFloor);
    expect(fees(moves, m.down).perLayerFloor).not.toBe(served);

    const rem = byName("six-to-eighteen-layer-remainders");
    const r = bases(rem);
    const f = fees(rem, r.up);
    expect(f.layers > f.floor).toBe(true);
    expect(BigInt(rem.message.feeBreakdown.totalFee)).toBe(f.perLayerFloor);
    expect(new Set([f.perLayerFloor, f.combinedFloor, f.perLayerCeil]).size).toBe(3);
    expect(BigInt(rem.message.source.amount)).toBe(r.up + f.perLayerFloor);
    expect(r.up).not.toBe(r.down);
  });
});
