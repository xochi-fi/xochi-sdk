#!/usr/bin/env node
// NOTE: `conformance/conformance.json` is the frozen byte-equality contract
// with `raxol_payments` (see CLAUDE.md). Do not run this script casually --
// regenerating it without a corresponding signer change silently masks digest
// drift. Kept here only so the toolchain stays runnable end to end.
//
// The pure EIP-712/stealth signers (signXochiIntent, XOCHI_TYPES, Quote,
// Eip712Signable) come from `@xochi/signer`, the network-free signing
// package. The sign-only composition (signOnly) and the chain/token registry
// (CONFIG, getTokenAddress) come from the private, never-published
// `@xochi/reference` workspace, whose `exports` point at TypeScript source
// (not a built `dist/`), so they always reflect what is on disk. That
// workspace is not part of the published `@xochi/spec` npm contract for
// external consumers. See packages/spec/README.md.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { CONFIG, getTokenAddress } from "@xochi/reference/config";
import { signOnly } from "@xochi/reference/sign-only";
import { signXochiIntent, XOCHI_TYPES, type Quote, type Eip712Signable } from "@xochi/signer";
import type { SignerConfig } from "@xochi/signer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic; changing any value here requires regenerating the fixture.
const CANONICAL = {
  PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
  SIGNER: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  AMOUNT: "1000000",
  SOLVER: "0xc6E555dfcC47e4A3bfecd6879570044ADc0270ff",
  DEADLINE: 1900000000,
};

function fixedNonceBytes32(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`nonce:${seed}`));
}

function fixedOrderId(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`orderId:${seed}`));
}

const FIXTURE_CONFIG: SignerConfig = {
  ...CONFIG,
  PRIVATE_KEY: CANONICAL.PRIVATE_KEY,
};

interface Vector {
  name: string;
  protocol: string;
  chain: string | null;
  token: string;
  private_key: string;
  expected_signer: string;
  quote?: Quote;
  eip712?: Eip712Signable;
  domain?: unknown;
  message?: unknown;
  expected_digest: string;
  expected_signature: string;
  expected_signed_object: string | null;
}

async function erc3009Vector(chainKey: string): Promise<Vector | null> {
  const chain = CONFIG.CHAINS[chainKey];
  if (!chain || !chain.usdc) return null;

  const quote: Quote = {
    request: {
      inputAmount: CANONICAL.AMOUNT,
      refundAddress: CANONICAL.SIGNER,
      inputToken: chain.usdc,
    },
    quoteExpires: CANONICAL.DEADLINE,
    gasless: {
      to: CANONICAL.SOLVER,
      nonce: fixedNonceBytes32(`erc3009:${chainKey}`),
      type: "erc3009",
    },
  };

  const result = await signOnly("erc3009", quote, chainKey, FIXTURE_CONFIG);

  return {
    name: `erc3009-${chainKey}-usdc`,
    protocol: "erc3009",
    chain: chainKey,
    token: "usdc",
    private_key: CANONICAL.PRIVATE_KEY,
    expected_signer: CANONICAL.SIGNER,
    quote,
    domain: result.domain,
    message: serializeMessage(result.message),
    expected_digest: result.digest,
    expected_signature: result.signature,
    expected_signed_object: result.signed_object,
  };
}

async function permit2Vector(chainKey: string, token: string): Promise<Vector | null> {
  const tokenAddress = getTokenAddress(chainKey, token);
  if (!tokenAddress) return null;

  const quote: Quote = {
    request: {
      inputAmount: CANONICAL.AMOUNT,
      refundAddress: CANONICAL.SIGNER,
      inputToken: tokenAddress,
    },
    quoteExpires: CANONICAL.DEADLINE,
    gasless: {
      to: CANONICAL.SOLVER,
      nonce: "1",
      orderId: fixedOrderId(`permit2:${chainKey}:${token}`),
      type: "permit2",
    },
  };

  const result = await signOnly("permit2", quote, chainKey, FIXTURE_CONFIG);

  return {
    name: `permit2-${chainKey}-${token}`,
    protocol: "permit2",
    chain: chainKey,
    token,
    private_key: CANONICAL.PRIVATE_KEY,
    expected_signer: CANONICAL.SIGNER,
    quote,
    domain: result.domain,
    message: serializeMessage(result.message),
    expected_digest: result.digest,
    expected_signature: result.signature,
    expected_signed_object: result.signed_object,
  };
}

async function xochiVector(
  fromChainKey: string,
  toChainKey: string,
  token: string,
  settlement = "public",
): Promise<Vector | null> {
  const fromChain = CONFIG.CHAINS[fromChainKey];
  const toChain = CONFIG.CHAINS[toChainKey];
  if (!fromChain || !toChain) return null;
  const fromToken = getTokenAddress(fromChainKey, token);
  const toToken = getTokenAddress(toChainKey, token);
  if (!fromToken || !toToken) return null;

  // settlementPreference is a signed message field, so a stealth vector is a
  // public one with this flipped -- the meta-keys are quote-time params, never
  // part of the signed XochiIntent. Suffix non-public names to keep them unique.
  const name =
    settlement === "public"
      ? `xochi-${fromChainKey}-${toChainKey}-${token}`
      : `xochi-${fromChainKey}-${toChainKey}-${token}-${settlement}`;

  // Synthesize the EIP-712 typed data Riddler would return from
  // POST /xochi/quote, matching the server domain version "3": domain name
  // "Xochi", deploy-scoped version (pinned to "3" here for determinism), and
  // salt = keccak256(version) binding the signature to the deployment. No
  // verifyingContract (verified off-chain via ecrecover). recipient == wallet
  // for these same-VM (EVM) corridors; no `nonce` in the signed struct.
  const XOCHI_DOMAIN_VERSION = "3";
  const eip712: Eip712Signable = {
    domain: {
      name: "Xochi",
      version: XOCHI_DOMAIN_VERSION,
      chainId: fromChain.chainId,
      salt: ethers.keccak256(ethers.toUtf8Bytes(XOCHI_DOMAIN_VERSION)),
    },
    types: XOCHI_TYPES,
    message: {
      intentId: `conformance-${name}`,
      quoteId: `conformance-${name}`,
      wallet: CANONICAL.SIGNER,
      recipient: CANONICAL.SIGNER,
      fromChainId: fromChain.chainId,
      toChainId: toChain.chainId,
      fromToken,
      toToken,
      fromAmount: CANONICAL.AMOUNT,
      toAmount: CANONICAL.AMOUNT,
      settlementPreference: settlement,
      deadline: CANONICAL.DEADLINE,
    },
  };

  const signature = await signXochiIntent(eip712, CANONICAL.PRIVATE_KEY);
  const digest = ethers.TypedDataEncoder.hash(eip712.domain, XOCHI_TYPES, eip712.message);

  return {
    name,
    protocol: "xochi",
    chain: null,
    token,
    private_key: CANONICAL.PRIVATE_KEY,
    expected_signer: CANONICAL.SIGNER,
    eip712,
    expected_digest: digest,
    expected_signature: signature,
    expected_signed_object: null,
  };
}

// Convert BigNumber / hex / atomic values in a message to JSON-safe forms.
function serializeMessage(message: unknown): unknown {
  return JSON.parse(
    JSON.stringify(message, (_key, value) => {
      if (value && typeof value === "object" && (value as { _isBigNumber?: boolean })._isBigNumber) {
        return (value as { toString(): string }).toString();
      }
      return value;
    }),
  );
}

const ERC3009_CHAINS = [
  "ethereum",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "eth-sepolia",
  "op-sepolia",
  "base-sepolia",
  "arb-sepolia",
];

const PERMIT2_CHAINS_USDC = [
  "ethereum",
  "base",
  "optimism",
  "arbitrum",
  "polygon",
  "eth-sepolia",
  "op-sepolia",
  "base-sepolia",
  "arb-sepolia",
];

const PERMIT2_CHAINS_USDT = ["ethereum", "base", "optimism", "arbitrum", "polygon"];

// WETH is permit2-only (no ERC-3009) and a volatile-tier settlement asset.
const PERMIT2_CHAINS_WETH = ["ethereum", "base", "optimism", "arbitrum", "polygon"];

// [from, to, token, settlement?]; settlement defaults to 'public'. The domain
// chainId is fromChainId, so every launch source chain must appear as a `from`
// to byte-pin its signature. Destinations are Base/OP (the only funded fill
// chains at launch); reverse corridors get pinned when those chains are funded.
const XOCHI_PAIRS: [string, string, string, string?][] = [
  // public -- every mainnet source x {usdc, usdt}
  ["base", "optimism", "usdc"],
  ["base", "optimism", "usdt"],
  ["optimism", "base", "usdc"],
  ["optimism", "base", "usdt"],
  ["arbitrum", "base", "usdc"],
  ["arbitrum", "base", "usdt"],
  ["polygon", "base", "usdc"],
  ["polygon", "base", "usdt"],
  ["ethereum", "base", "usdc"],
  ["ethereum", "base", "usdt"],
  // stealth -- the differentiator; both pull tokens on the primary corridor.
  // Only settlementPreference changes vs public, so one corridor per token
  // proves the binding without duplicating every source.
  ["base", "optimism", "usdc", "stealth"],
  ["base", "optimism", "usdt", "stealth"],
  // WETH -- volatile-tier settlement asset (permit2 pull); pin three public
  // corridors + the primary corridor stealth. Polygon's WETH is the bridged
  // 0x7ceB... address (not the canonical 0xC02a/0x4200 patterns), so pinning a
  // polygon source guards against a token-address typo.
  ["base", "optimism", "weth"],
  ["arbitrum", "base", "weth"],
  ["polygon", "base", "weth"],
  ["base", "optimism", "weth", "stealth"],
  // testnet -- CI coverage without mainnet tokens
  ["base-sepolia", "op-sepolia", "usdc"],
];

async function generate(): Promise<Vector[]> {
  const vectors: Vector[] = [];

  for (const chainKey of ERC3009_CHAINS) {
    const v = await erc3009Vector(chainKey);
    if (v) vectors.push(v);
  }

  for (const chainKey of PERMIT2_CHAINS_USDC) {
    const v = await permit2Vector(chainKey, "usdc");
    if (v) vectors.push(v);
  }

  for (const chainKey of PERMIT2_CHAINS_USDT) {
    const v = await permit2Vector(chainKey, "usdt");
    if (v) vectors.push(v);
  }

  for (const chainKey of PERMIT2_CHAINS_WETH) {
    const v = await permit2Vector(chainKey, "weth");
    if (v) vectors.push(v);
  }

  for (const [from, to, token, settlement] of XOCHI_PAIRS) {
    const v = await xochiVector(from, to, token, settlement);
    if (v) vectors.push(v);
  }

  return vectors;
}

async function main(): Promise<void> {
  const vectors = await generate();
  const outPath = path.join(__dirname, "conformance.json");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2) + "\n");

  console.log(`Wrote ${vectors.length} vectors to ${path.relative(process.cwd(), outPath)}`);
  console.log("Breakdown:");
  const counts = vectors.reduce<Record<string, number>>((acc, v) => {
    acc[v.protocol] = (acc[v.protocol] || 0) + 1;
    return acc;
  }, {});
  for (const [proto, count] of Object.entries(counts)) {
    console.log(`  ${proto}: ${count}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("generate-conformance failed:", err);
    process.exit(1);
  });
}
