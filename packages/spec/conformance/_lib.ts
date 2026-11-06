// Shared plumbing for the vector generators (conformance/, fee/, erc8262/). Imports nothing
// from `@xochi/signer`: the shielded generators that use it stay independent of the
// reference they grade (packages/spec/test/generators.test.ts).

import fs, { realpathSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/** The conformance directory. */
export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where a generator writes every file: `SPEC_VECTORS_DIR` when set, else `defaultDir`. */
export const outDir = (defaultDir: string = HERE): string =>
  process.env.SPEC_VECTORS_DIR ?? defaultDir;

/** Writes `value` as `dir/name`: 2-space JSON plus a trailing newline. Returns the path. */
export function writeJson(dir: string, name: string, value: unknown): string {
  const target = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
  return target;
}

type WriteOptions = {
  /** Written beside the vectors as `<name>.schema.json`. */
  schema?: unknown;
  /** Replaces the default `wrote N vectors -> path` line. */
  summary?: string;
  dir?: string;
};

/**
 * Writes a vector file (and its schema) into `outDir()` unless `dir` is given, then logs one
 * line. Without a `summary`, `out` is the vector array or an object carrying `vectors`.
 */
export function writeVectors(
  name: string,
  out: object,
  { schema, summary, dir = outDir() }: WriteOptions = {},
): string {
  const line = summary ?? `wrote ${vectorCount(out)} vectors -> ${path.join(dir, name)}`;
  const target = writeJson(dir, name, out);
  if (schema !== undefined) writeJson(dir, name.replace(/\.json$/, ".schema.json"), schema);
  console.log(line);
  return target;
}

function vectorCount(out: object): number {
  const vectors = Array.isArray(out) ? out : "vectors" in out ? out.vectors : undefined;
  if (!Array.isArray(vectors)) throw new Error("writeVectors: no vector array; pass a summary");
  return vectors.length;
}

function committedVectorField(file: string, name: string, field: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(HERE, file), "utf8"));
  const vectors: unknown[] =
    parsed && typeof parsed === "object" && "vectors" in parsed && Array.isArray(parsed.vectors)
      ? parsed.vectors
      : [];
  const vector = vectors.find(
    (v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && "name" in v && v.name === name,
  );
  const value = vector?.[field];
  if (typeof value !== "string") throw new Error(`${file}: no "${name}" vector with ${field}`);
  return value;
}

/** The committed order-id.json `baseline-evm-usdc` orderId. */
export const baselineOrderId = (): string =>
  committedVectorField("order-id.json", "baseline-evm-usdc", "expected_order_id");

/** The committed fill-salt.json `baseline` fillId. */
export const baselineFillId = (): string =>
  committedVectorField("fill-salt.json", "baseline", "expected_fill_id");

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0, #1, #2). NOT SECRET. NEVER USE: known to
// everyone, they MUST NEVER hold funds or be registered in any role (solver, attester,
// authorizer, signer).
export const HARDHAT_TEST_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;

// Compared as URLs of the real path: a hand-built `file://` + path never matches one that
// needs percent-encoding (a space) or runs through a symlink.
/** True when the module at `moduleUrl` (its `import.meta.url`) is the script node ran. */
export const isMain = (moduleUrl: string): boolean =>
  process.argv[1] !== undefined && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href;

// --- JSON-schema helpers --------------------------------------------------------------------

export const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
export const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
export const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
export const STR = { type: "string" };
/** 65-byte secp256k1 r||s||v. */
export const SIG_ECDSA = { type: "string", pattern: "^0x[0-9a-f]{130}$" };
/** 64-byte Schnorr (Grumpkin) signature. */
export const SIG_SCHNORR = { type: "string", pattern: "^0x[0-9a-f]{128}$" };

/** A closed object: every property required except those named in `optional`. */
export const obj = (props: Record<string, unknown>, optional: readonly string[] = []) => ({
  type: "object",
  required: Object.keys(props).filter((k) => !optional.includes(k)),
  additionalProperties: false,
  properties: props,
});
export const arr = (items: unknown) => ({ type: "array", minItems: 1, items });
