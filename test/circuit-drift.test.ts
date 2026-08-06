/**
 * Circuit sync drift check.
 *
 * The compiled circuit artifacts in `circuits/` are copied out of ERC-8262 by
 * `scripts/sync-circuits.sh`. Nothing previously verified that the committed
 * copies were current, so a circuit change in ERC-8262 would surface here only
 * as a confusing Noir witness error at proof time.
 *
 * Two tiers:
 *
 *   1. Always -- the committed artifacts are internally consistent and agree
 *      with the input builders that have to populate their witnesses.
 *   2. When a sibling ERC-8262 checkout exists -- the artifacts still agree
 *      with the circuit sources they were compiled from. Parsing `main.nr`
 *      means this needs no nargo, so it runs anywhere the repo is present.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { Address } from "viem";

import { EXPECTED_NOIR_VERSION } from "../src/noir-version.js";
import { buildComplianceInputs } from "../src/inputs/compliance.js";
import { buildRiskScoreInputs } from "../src/inputs/risk-score.js";
import { buildPatternInputs } from "../src/inputs/pattern.js";
import { buildAttestationInputs } from "../src/inputs/attestation.js";
import { buildMembershipInputs } from "../src/inputs/membership.js";
import { buildNonMembershipInputs } from "../src/inputs/non-membership.js";
import { buildComplianceSignedInputs } from "../src/inputs/compliance-signed.js";
import { buildRiskScoreSignedInputs } from "../src/inputs/risk-score-signed.js";
import {
  buildComplianceMultiSignedInputs,
  type MultiSignedSlot,
} from "../src/inputs/compliance-multi-signed.js";

const TEST_DIR = new URL(".", import.meta.url).pathname;
const CIRCUITS_DIR = resolve(TEST_DIR, "../circuits");
const ERC_8262 = process.env.ERC_8262_PATH ?? resolve(TEST_DIR, "../../ERC-8262");

const SUBMITTER = "0x000000000000000000000000000000000000dEaD" as Address;
const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const ORACLE_ADDRESS = "0x00000000000000000000000000000000abcd1234" as Address;
const CHAIN_ID = 1n;
const TIMESTAMP = "1700000000";

interface AbiType {
  kind: string;
  length?: number;
  type?: AbiType;
}
interface AbiParam {
  name: string;
  type: AbiType;
  visibility: string;
}
interface Artifact {
  noir_version?: string;
  abi: { parameters: AbiParam[] };
}

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function dummyBundle() {
  return {
    signature: bytes(64, 0xab),
    pubkeyX: bytes(32, 0xcd),
    pubkeyY: bytes(32, 0xef),
    signerPubkeyHash: bytes(32, 0x12),
  };
}

function makeSlot(fill: number): MultiSignedSlot {
  return {
    signals: [10, 20, 30, 0, 0, 0, 0, 0],
    weights: [50, 30, 20, 0, 0, 0, 0, 0],
    pubkeyX: bytes(32, fill),
    pubkeyY: bytes(32, fill + 1),
    signature: bytes(64, fill + 2),
    signerPubkeyHash: bytes(32, fill + 3),
  };
}

/**
 * Every circuit, the builder that populates its witness, and the public-input
 * count the ERC pins in its Test Cases table. Adding a proof type to ERC-8262
 * without adding it here fails the "covers every artifact" case below.
 */
const CIRCUITS: { name: string; publicInputs: number; build: () => Record<string, unknown> }[] = [
  {
    name: "compliance",
    publicInputs: 6,
    build: () =>
      buildComplianceInputs({
        score: 20,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        timestamp: TIMESTAMP,
        submitter: SUBMITTER,
      }),
  },
  {
    name: "risk_score",
    publicInputs: 8,
    build: () =>
      buildRiskScoreInputs({
        type: "threshold",
        score: 60,
        threshold: 5000,
        direction: "gt",
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
  },
  {
    name: "pattern",
    publicInputs: 7,
    build: () =>
      buildPatternInputs({
        amounts: [9000, 8500, 9200],
        timestamps: [1700000000, 1700000100, 1700000200],
        numTransactions: 3,
        analysisType: 1,
        reportingThreshold: 10000,
        timeWindow: 86400,
        txSetHash: "0xabcd",
        submitter: SUBMITTER,
        settlementRoot: "0",
      }),
  },
  {
    name: "attestation",
    publicInputs: 6,
    build: () =>
      buildAttestationInputs({
        credentialAttribute: "0xccc",
        expiryTimestamp: 1800000000,
        merkleIndex: "0",
        merklePath: Array(20).fill("0") as string[],
        providerId: "1",
        credentialType: 1,
        credentialRoot: "0xddd",
        currentTimestamp: 1700000000,
        submitter: SUBMITTER,
      }),
  },
  {
    name: "membership",
    publicInputs: 5,
    build: () =>
      buildMembershipInputs({
        subjectSalt: "0",
        merkleIndex: "0",
        merklePath: Array(20).fill("0") as string[],
        merkleRoot: "0x1234",
        setId: "1",
        timestamp: TIMESTAMP,
        submitter: SUBMITTER,
      }),
  },
  {
    name: "non_membership",
    publicInputs: 5,
    build: () =>
      buildNonMembershipInputs({
        lowLeaf: "10",
        highLeaf: "100",
        lowIndex: "0",
        lowPath: Array(20).fill("0") as string[],
        highIndex: "1",
        highPath: Array(20).fill("0") as string[],
        merkleRoot: "0",
        setId: "1",
        submitter: SUBMITTER,
      }),
  },
  {
    name: "compliance_signed",
    publicInputs: 9,
    build: () =>
      buildComplianceSignedInputs({
        score: 25,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        timestamp: TIMESTAMP,
        chainId: CHAIN_ID,
        oracleAddress: ORACLE_ADDRESS,
        signedBundle: dummyBundle(),
      }),
  },
  {
    name: "risk_score_signed",
    publicInputs: 11,
    build: () =>
      buildRiskScoreSignedInputs({
        type: "threshold",
        direction: "gt",
        threshold: 5000,
        score: 60,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        signedTimestamp: TIMESTAMP,
        chainId: CHAIN_ID,
        oracleAddress: ORACLE_ADDRESS,
        signedBundle: dummyBundle(),
      }),
  },
  {
    name: "compliance_multi_signed",
    publicInputs: 14,
    build: () =>
      buildComplianceMultiSignedInputs({
        jurisdictionId: 0,
        thresholdM: 1,
        providerSetHash: "0xdead",
        timestamp: TIMESTAMP,
        submitter: SUBMITTER,
        chainId: CHAIN_ID,
        oracleAddress: ORACLE_ADDRESS,
        slots: [makeSlot(0x10), null, null, null, null],
      }),
  },
];

function loadArtifact(name: string): Artifact {
  return JSON.parse(readFileSync(resolve(CIRCUITS_DIR, `${name}.json`), "utf-8")) as Artifact;
}

const publicNames = (a: Artifact): string[] =>
  a.abi.parameters.filter((p) => p.visibility === "public").map((p) => p.name);

/** Parse `fn main(...)` from a Noir source, returning [all params, public params]. */
function parseMainParams(source: string): { all: string[]; pub: string[] } {
  const stripped = source.replace(/\/\/[^\n]*/g, "");
  const match = /fn main\s*\((.*?)\)\s*(?:->|\{)/s.exec(stripped);
  if (!match) throw new Error("could not locate fn main");

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of match[1]) {
    if ("[(<".includes(ch)) depth += 1;
    else if ("])>".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const named = parts.filter((p) => p.includes(":"));
  return {
    all: named.map((p) => p.split(":")[0].trim()),
    pub: named.filter((p) => /:\s*pub\s/.test(p)).map((p) => p.split(":")[0].trim()),
  };
}

describe("circuit artifacts", () => {
  it("covers every artifact committed to circuits/", () => {
    const onDisk = readdirSync(CIRCUITS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(onDisk).toEqual(CIRCUITS.map((c) => c.name).sort());
  });

  it("are all compiled by the pinned Noir version", () => {
    const versions = new Map<string, string>();
    for (const { name } of CIRCUITS) {
      const v = loadArtifact(name).noir_version ?? "<missing>";
      versions.set(name, v);
      expect(v, `${name} noir_version`).toContain(EXPECTED_NOIR_VERSION);
    }
    // A single mixed artifact means a partial sync, which the per-circuit
    // assertion above misses whenever the odd one out is still a valid version.
    expect(
      new Set(versions.values()).size,
      `mixed versions: ${JSON.stringify([...versions])}`,
    ).toBe(1);
  });

  it.each(CIRCUITS)("$name: exposes $publicInputs public inputs", ({ name, publicInputs }) => {
    expect(publicNames(loadArtifact(name))).toHaveLength(publicInputs);
  });

  it.each(CIRCUITS)("$name: the input builder populates every witness field", ({ name, build }) => {
    const declared = loadArtifact(name)
      .abi.parameters.map((p) => p.name)
      .sort();
    const produced = Object.keys(build()).sort();
    expect(produced).toEqual(declared);
  });
});

describe.skipIf(!existsSync(resolve(ERC_8262, "circuits")))(
  "circuit artifacts vs ERC-8262 sources",
  () => {
    it.each(CIRCUITS)("$name: artifact matches circuits/$name/src/main.nr", ({ name }) => {
      const nr = resolve(ERC_8262, `circuits/${name}/src/main.nr`);
      expect(existsSync(nr), `missing circuit source at ${nr}`).toBe(true);

      const parsed = parseMainParams(readFileSync(nr, "utf-8"));
      const artifact = loadArtifact(name);

      // Order matters: it fixes the on-chain publicInputs encoding.
      expect(publicNames(artifact)).toEqual(parsed.pub);
      expect(artifact.abi.parameters.map((p) => p.name)).toEqual(parsed.all);
    });

    it("nargo pin in .tool-versions matches EXPECTED_NOIR_VERSION", () => {
      const toolVersions = resolve(ERC_8262, ".tool-versions");
      expect(existsSync(toolVersions)).toBe(true);
      const pin = /^nargo\s+(\S+)/m.exec(readFileSync(toolVersions, "utf-8"))?.[1];
      expect(pin).toBe(EXPECTED_NOIR_VERSION);
    });

    it.each(CIRCUITS)("$name: matches the compiled target when one exists", ({ name }) => {
      const candidates = [
        resolve(ERC_8262, `circuits/${name}/target/${name}.json`),
        resolve(ERC_8262, `circuits/target/${name}.json`),
      ];
      const target = candidates.find((p) => existsSync(p));
      if (target === undefined) return; // not compiled locally; sources were checked above

      const upstream = JSON.parse(readFileSync(target, "utf-8")) as Artifact;
      expect(upstream.abi.parameters.map((p) => p.name)).toEqual(
        loadArtifact(name).abi.parameters.map((p) => p.name),
      );
      expect(upstream.noir_version).toBe(loadArtifact(name).noir_version);
    });
  },
);
