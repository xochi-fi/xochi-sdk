#!/usr/bin/env node
// NOTE: `fee/vectors.json` and `fee/schedule.json` are the frozen normative
// artifacts for SPEC.md Section 4 (the layered fee model). They are generated
// from the fee reference published in `@xochi/client` (`packages/client/src/fee.ts`,
// whose `FEE_SCHEDULE` is byte-parity with the server's
// `Riddler.Integrations.Xochi.FeePolicy`).
// Regenerate only after a deliberate schedule change;
// `packages/reference/test/fee.test.ts` re-checks every vector.
//
// `@xochi/client` is a devDependency only: generators are not part of the
// published `@xochi/spec` npm contract, which stays runtime-dependency-free.
// It resolves to the client's built `dist`, so build the workspaces first
// (`npm run build:workspaces`) or this reads a stale schedule.

import fs, { realpathSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  FEE_SCHEDULE,
  computeFeeBreakdown,
  type FeeComputeParams,
} from "@xochi/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic input matrix. Every case names a concrete taker scenario; the
// expected breakdown is computed, never hand-written. `1000000` is 1 USDC / 1
// USDT (6-decimals). The two odd amounts exercise the per-layer floor rule
// (sum-of-floors < floor-of-total).
const CANONICAL_AMOUNT = "1000000";

interface Case {
  name: string;
  input: FeeComputeParams;
}

const CASES: Case[] = [
  // Full tier x asset_class matrix at the headline (no impact, non-ACP). Scores
  // carry the proofs each tier needs so no gating fires.
  { name: "standard-stable", input: { trust_score: 0, asset_class: "stable", input_amount: CANONICAL_AMOUNT } },
  { name: "standard-volatile", input: { trust_score: 0, asset_class: "volatile", input_amount: CANONICAL_AMOUNT } },
  { name: "trusted-stable", input: { trust_score: 25, asset_class: "stable", input_amount: CANONICAL_AMOUNT } },
  { name: "trusted-volatile", input: { trust_score: 25, asset_class: "volatile", input_amount: CANONICAL_AMOUNT } },
  {
    name: "verified-stable",
    input: { trust_score: 50, asset_class: "stable", input_amount: CANONICAL_AMOUNT, attestations: ["compliance"] },
  },
  {
    name: "verified-volatile",
    input: { trust_score: 50, asset_class: "volatile", input_amount: CANONICAL_AMOUNT, attestations: ["compliance"] },
  },
  {
    name: "premium-stable",
    input: {
      trust_score: 75,
      asset_class: "stable",
      input_amount: CANONICAL_AMOUNT,
      attestations: ["compliance", "non_membership"],
    },
  },
  {
    name: "premium-volatile",
    input: {
      trust_score: 75,
      asset_class: "volatile",
      input_amount: CANONICAL_AMOUNT,
      attestations: ["compliance", "non_membership"],
    },
  },
  {
    name: "institutional-stable",
    input: {
      trust_score: 100,
      asset_class: "stable",
      input_amount: CANONICAL_AMOUNT,
      attestations: ["compliance", "non_membership"],
    },
  },
  {
    name: "institutional-volatile",
    input: {
      trust_score: 100,
      asset_class: "volatile",
      input_amount: CANONICAL_AMOUNT,
      attestations: ["compliance", "non_membership"],
    },
  },
  // Attestation gating: a verified score with no proofs is gated down to trusted.
  { name: "gated-verified-to-trusted", input: { trust_score: 50, asset_class: "stable", input_amount: CANONICAL_AMOUNT } },
  // ACP origin waives the routing layer (standard stable 22 -> 14).
  { name: "acp-origin-standard-stable", input: { trust_score: 0, asset_class: "stable", input_amount: CANONICAL_AMOUNT, acp_origin: true } },
  // Price impact added on a thin book (2000 / 10000 => 10 bps; total 22 -> 32).
  {
    name: "impact-standard-stable",
    input: { trust_score: 0, asset_class: "stable", input_amount: CANONICAL_AMOUNT, fill_usd: 2000, available_liquidity_usd: 10000 },
  },
  // Impact clamped at the cap (fill >> liquidity).
  {
    name: "impact-capped-volatile",
    input: { trust_score: 0, asset_class: "volatile", input_amount: CANONICAL_AMOUNT, fill_usd: 100000, available_liquidity_usd: 1000 },
  },
  // Per-layer floor truncation: sum-of-floors (731) < floor-of-total (733).
  { name: "floor-truncation-stable", input: { trust_score: 0, asset_class: "stable", input_amount: "333333" } },
  { name: "floor-truncation-volatile", input: { trust_score: 0, asset_class: "volatile", input_amount: "333333" } },
];

interface Vector {
  name: string;
  input: FeeComputeParams;
  expected: ReturnType<typeof computeFeeBreakdown>;
}

function generate(): Vector[] {
  const seen = new Set<string>();
  return CASES.map(({ name, input }) => {
    if (seen.has(name)) throw new Error(`duplicate vector name: ${name}`);
    seen.add(name);
    return { name, input, expected: computeFeeBreakdown(input) };
  });
}

function main(): void {
  const vectors = generate();
  const vectorsPath = path.join(__dirname, "vectors.json");
  const schedulePath = path.join(__dirname, "schedule.json");

  fs.mkdirSync(__dirname, { recursive: true });
  fs.writeFileSync(vectorsPath, JSON.stringify(vectors, null, 2) + "\n");
  fs.writeFileSync(schedulePath, JSON.stringify(FEE_SCHEDULE, null, 2) + "\n");

  console.log(`Wrote ${vectors.length} fee vectors to ${path.relative(process.cwd(), vectorsPath)}`);
  console.log(`Wrote fee schedule to ${path.relative(process.cwd(), schedulePath)}`);
}

// Compared as URLs of the real path: a hand-built `file://` + path never
// matches one that needs percent-encoding (a space) or runs through a symlink.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMainModule) {
  main();
}
